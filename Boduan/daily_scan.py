"""
全市场扫描 + 交易计划生成（新工作流）
======================================
新流程:
  Step 1: 市场阶段判断
  Step 2: 全市场形态扫描（5种形态，涨幅>9.9% + KEY_SECTORS）
  Step 3: 候选股票按概念分类
  Step 4: 热门板块排名（10天内连续3次排名前5）
  Step 5: 匹配候选股票与热门板块
  Step 6: 生成交易计划

用法: python daily_scan.py
"""
import sys, os, io

# Windows GBK 终端兼容
if sys.platform == "win32":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 绕过代理直连数据源（避免代理不可用导致HTTP请求失败）
_proxy_bypass_domains = (
    "push2.eastmoney.com,push2his.eastmoney.com,quote.eastmoney.com,"
    "data.eastmoney.com,eastmoney.com,10jqka.com.cn,q.10jqka.com.cn,"
    "vip.stock.finance.sina.com.cn,hq.sinajs.cn,finance.sina.com.cn,"
    "sina.com.cn,ths.com.cn"
)
existing_no_proxy = os.environ.get("NO_PROXY", "")
if existing_no_proxy:
    os.environ["NO_PROXY"] = existing_no_proxy + "," + _proxy_bypass_domains
else:
    os.environ["NO_PROXY"] = _proxy_bypass_domains
os.environ["no_proxy"] = os.environ["NO_PROXY"]

import logging
# 抑制 AKShare 内部的 tqdm 进度条
os.environ["TQDM_DISABLE"] = "1"
logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("scan")

from datetime import datetime, timedelta
from typing import List, Dict, Optional, Tuple
import numpy as np
import pandas as pd

# 重点跟踪（自选股）
from swing_trader.utils.watchlist_manager import get_watchlist
from swing_trader.core.risk_check import RiskChecker
from swing_trader.core.post_first_board_tracker import PostFirstBoardTracker
from swing_trader.utils.indicators import check_weekly_l1

# 周末跳过
if datetime.now().weekday() >= 5:
    print("周末休市，跳过执行")
    sys.exit(0)

# 重点监控板块（晓胜策略核心方向+市场常热板块）
# 注：当赛道轮动评分启用时，此列表作为后备（fallback），
# 实际扫描范围由 rotation 动态推荐
KEY_SECTORS = [
    "机器人概念", "人工智能", "算力租赁", "芯片概念", "第三代半导体",
    "新能源汽车", "光伏概念", "储能", "电力物联网", "军工",
    "低空经济", "消费电子概念", "数据中心", "人形机器人",
    "DeepSeek概念", "东数西算(算力)", "液冷服务器", "存储芯片",
    "多模态AI", "AI应用",
]

# 导入赛道轮动评分引擎
from swing_trader.utils.sector_rotation import (
    analyze_and_recommend, save_recommendations, load_recommendations, is_cache_fresh,
)
from swing_trader.utils.config import CONFIG


# ──────────────────────────────────────────────
# 动态赛道扫描范围获取
# ──────────────────────────────────────────────

def get_scan_sectors() -> List[str]:
    """
    获取动态扫描赛道列表。

    load_recommendations() 在加载层已完成 THS 名称映射，
    本函数直接使用 ths_scan_sectors 返回同花顺概念板块名。

    优先级:
      1. 赛道轮动评分缓存/本地周报（已含 ths_scan_sectors）
      2. 回退到固定的 KEY_SECTORS

    返回: 同花顺概念板块名称列表（用于扫描成分股）
    """
    rotation_cfg = CONFIG.rotation

    if not rotation_cfg.enabled:
        logger.info("赛道轮动评分未启用，使用固定 KEY_SECTORS")
        return KEY_SECTORS

    # load_recommendations() 自动处理: cache → 文件夹后备 → None
    # 返回值始终包含 ths_scan_sectors（同花顺板块名）
    data = load_recommendations()
    if data and data.get("ths_scan_sectors"):
        sectors = data["ths_scan_sectors"]
        source = data.get("source", "缓存")
        logger.info(f"  赛道轮动推荐: {len(sectors)} 个板块 (来自{source})")
        return sectors

    # 无有效数据，使用固定后备列表
    logger.info("  赛道推荐未就绪，使用 KEY_SECTORS 后备")
    return KEY_SECTORS


def force_refresh_scan_sectors(board_index_cache, date_rankings=None) -> List[str]:
    """
    强制刷新赛道评分并返回推荐扫描列表。

    在 HotSectorAnalyzer 完成数据采集后调用，
    保存推荐结果供后续使用。
    """
    rotation_cfg = CONFIG.rotation
    top_n = rotation_cfg.top_n

    # 执行赛道评分
    result = analyze_and_recommend(
        board_index_cache=board_index_cache,
        date_rankings=date_rankings,
        top_n=top_n,
    )

    # 强制加入晓胜核心方向（按关键词匹配）
    scan_sectors = list(result["scan_sectors"])
    core_keywords = list(rotation_cfg.core_keywords)

    # 将包含核心关键词的板块提到前面
    matched_core = []
    for sector in scan_sectors:
        for kw in core_keywords:
            if kw in sector:
                matched_core.append(sector)
                break

    # 确保核心方向在扫描列表中
    # 如果在推荐列表中已有，则优先排序
    # 如果没有，则从 KEY_SECTORS 中补充
    all_board_names = list(board_index_cache.keys()) if board_index_cache else []
    for kw in core_keywords:
        found = False
        for sector in scan_sectors:
            if kw in sector:
                found = True
                break
        if not found:
            # 从所有板块中查找匹配的
            for board in all_board_names:
                if kw in board and board not in scan_sectors:
                    scan_sectors.append(board)
                    break

    # 排序：核心匹配优先，按评分降序
    def sort_key(sector):
        is_core = any(kw in sector for kw in core_keywords)
        rank = 0
        for r in result.get("recommendations", []):
            if r["name"] == sector:
                rank = r["score"]
                break
        return (1 if is_core else 0, rank)

    scan_sectors.sort(key=sort_key, reverse=True)

    # 限制数量
    scan_sectors = scan_sectors[:top_n]

    # 保存结果
    if rotation_cfg.cache_enabled:
        result["scan_sectors"] = scan_sectors
        save_recommendations(result)

    logger.info(f"  赛道轮动推荐: {len(scan_sectors)} 个赛道 (实时评分)")
    for s in scan_sectors[:5]:
        logger.info(f"     {s}")
    if len(scan_sectors) > 5:
        logger.info(f"     ... 等 {len(scan_sectors)} 个")

    return scan_sectors
# ──────────────────────────────────────────────

def get_market_phase() -> Dict:
    """判断当前市场阶段"""
    import baostock as bs
    lg = bs.login()
    if lg.error_code != "0":
        return {"phase": "未知", "confidence": 0, "position": "0%"}
    try:
        rs = bs.query_history_k_data_plus(
            "sh.000001", "date,close,pctChg",
            frequency="w", adjustflag="2",
            start_date="2024-01-01",
            end_date=datetime.now().strftime("%Y-%m-%d"),
        )
        dates, closes, pcts = [], [], []
        if rs.error_code == "0":
            df = rs.get_data()
            if df is not None and not df.empty:
                for _, row in df.iterrows():
                    close_val = row.get("close", 0)
                    if close_val and float(close_val) > 0:
                        dates.append(str(row["date"]))
                        closes.append(float(close_val))
                        pcts.append(float(row.get("pctChg", 0)) if row.get("pctChg") else 0)

        if len(closes) < 8:
            return {"phase": "春(默认)", "confidence": 2, "position": "30%"}

        recent = closes[-10:]
        recent_pcts = pcts[-10:]
        ma5 = np.mean(recent[-5:])
        ma10 = np.mean(recent)
        macd_bull = ma5 > ma10
        positive_weeks = sum(1 for p in recent_pcts if p > 0)

        if macd_bull and positive_weeks >= 4:
            confidence = min(3 + sum(1 for p in recent_pcts[-4:] if p > 0), 5)
            return {"phase": "春", "confidence": confidence, "position": f"{min(50 + confidence*5, 70)}%"}
        elif positive_weeks >= 3:
            return {"phase": "冬末春初", "confidence": 3, "position": "30%"}
        else:
            return {"phase": "冬", "confidence": 1, "position": "0%"}
    finally:
        bs.logout()


# ──────────────────────────────────────────────
# Step 2: 全市场形态扫描
# ──────────────────────────────────────────────

def scan_stocks(stocks: List[Tuple[str, str]]) -> List[Dict]:
    """批量扫描股票，检测符合形态的标的"""
    import baostock as bs
    from swing_trader.backtest.detectors import detect_all

    lg = bs.login()
    if lg.error_code != "0":
        logger.error("BaoStock登录失败")
        return []

    results = []
    total = len(stocks)

    try:
        for idx, (code, name) in enumerate(stocks):
            if code.startswith(("8", "4")):
                continue
            # 验证股票代码格式（必须为6位数字）
            if not (len(code) == 6 and code.isdigit()):
                continue
            if not code.startswith(("0", "3", "6")):
                continue

            bs_code = f"sh.{code}" if code.startswith("6") else f"sz.{code}"
            rs = bs.query_history_k_data_plus(
                bs_code, "date,open,close,high,low,volume,amount,pctChg",
                frequency="d", adjustflag="2",
                start_date="2022-01-01",
                end_date=datetime.now().strftime("%Y-%m-%d"),
            )
            if rs.error_code != "0":
                continue

            df = rs.get_data()
            if df is None or df.empty or len(df) < 250:
                continue

            for col in ["open","close","high","low","volume","amount","pctChg"]:
                df[col] = pd.to_numeric(df[col], errors="coerce")
            df = df.sort_values("date").reset_index(drop=True)

            closes = df["close"].tolist()
            volumes = df["volume"].tolist()
            highs = df["high"].tolist()
            lows = df["low"].tolist()
            opens = df["open"].tolist()
            pct_chg = df["pctChg"].tolist()
            dates = df["date"].tolist()

            if len(closes) < 250:
                continue

            # 只检测最新一天
            i = len(closes) - 1
            if closes[i] < 3.0:
                continue

            # ── L1过滤: 多条件周线评分系统 ──
            if len(df) >= 60:
                df_temp = df.copy()
                df_temp["date_dt"] = pd.to_datetime(df_temp["date"])
                df_temp["week"] = df_temp["date_dt"].dt.isocalendar().week.astype(str) \
                    + "-" + df_temp["date_dt"].dt.isocalendar().year.astype(str)
                weekly_df = df_temp.groupby("week").agg({
                    "close": "last",
                    "volume": "sum" if "volume" in df_temp.columns else "last",
                }).reset_index()
                passed, score, details = check_weekly_l1(
                    weekly_closes=weekly_df["close"].values,
                    weekly_volumes=weekly_df["volume"].values if "volume" in weekly_df.columns else None,
                )
                if not passed and len(weekly_df["close"].values) >= 10:
                    continue  # 周线未达标，跳过

            match = detect_all(
                closes[:i+1], volumes[:i+1],
                highs[:i+1] if highs else None,
                lows[:i+1] if lows else None,
                opens[:i+1] if opens else None,
                pct_chg[:i+1] if pct_chg else None,
            )
            if match:
                results.append({
                    "code": code,
                    "name": name,
                    "date": str(dates[i]) if dates else "",
                    "price": closes[i],
                    "pattern": match.get("pattern_type", ""),
                    "confidence": match.get("confidence", ""),
                    "description": match.get("description", ""),
                    "vol_ratio": match.get("vol_ratio", 0),
                    "pct_chg": match.get("latest_pct", 0),
                    "ma144": match.get("ma144", 0),
                    "confidence_score": match.get("confidence_score", 0),
                    "resonance_score": match.get("weekly_resonance_score", 0),
                })

            if (idx + 1) % 10 == 0:
                logger.info(f"  扫描进度: {idx+1}/{total} | 已发现 {len(results)} 个")

    finally:
        bs.logout()

    return results


def get_realtime_quotes(candidates: List[Dict]) -> None:
    """
    用新浪实时接口获取候选股今日真实涨跌幅，覆盖baostock的滞后数据。

    新浪返回格式: 0=名称,1=今开,2=昨收,3=当前,4=最高,5=最低
    """
    if not candidates:
        return
    import urllib.request

    codes = [c["code"] for c in candidates]
    # 新浪需要 sh/sz 前缀（无点号）
    sina_codes = [("sh" if c.startswith("6") else "sz") + c for c in codes]
    url = "https://hq.sinajs.cn/list=" + ",".join(sina_codes)

    try:
        req = urllib.request.Request(url, headers={"Referer": "https://finance.sina.com.cn"})
        resp = urllib.request.urlopen(req, timeout=15)
        raw = resp.read().decode("gbk")

        for i, line in enumerate(raw.strip().split("\n")):
            if not line.strip() or i >= len(candidates):
                continue
            parts = line.split(",")
            if len(parts) < 6:
                continue
            try:
                yesterday_close = float(parts[2])
                current_price = float(parts[3])
                if yesterday_close > 0 and current_price > 0:
                    real_pct = (current_price - yesterday_close) / yesterday_close * 100
                    candidates[i]["pct_chg"] = round(real_pct, 2)
                    candidates[i]["price"] = current_price
            except (ValueError, IndexError):
                continue

        logger.info(f"  实时行情覆盖: {sum(1 for c in candidates if c.get('price', 0) > 0)}/{len(candidates)} 只")
    except Exception as e:
        logger.warning(f"  获取实时行情失败: {e}")


def get_gainer_stocks() -> List[Tuple[str, str]]:
    """获取全市场涨幅>9.9%的标的（新浪数据）"""
    import akshare as ak
    stocks = []
    try:
        all_spot = ak.stock_zh_a_spot()
        if all_spot is not None and not all_spot.empty:
            gainers = all_spot[all_spot["涨跌幅"] > 9.9].copy()
            for _, row in gainers.iterrows():
                code_full = str(row["代码"])
                name = str(row["名称"])
                if code_full.startswith(("sh", "sz")):
                    code = code_full[2:]
                elif code_full.startswith("bj"):
                    continue
                else:
                    continue
                if (not code.startswith(("8", "4"))
                        and "ST" not in name
                        and "N" not in name):
                    stocks.append((code, name))
    except Exception as e:
        logger.warning(f"获取涨幅>9.9%标失败: {e}")
    return stocks


def get_sector_stocks(sector_name: str) -> List[Tuple[str, str]]:
    """获取板块成分股（同花顺）"""
    import requests
    from bs4 import BeautifulSoup
    import akshare as ak

    try:
        board_df = ak.stock_board_concept_name_ths()
        match = board_df[board_df["name"].str.contains(sector_name, na=False, regex=False)]
        if match.empty:
            return []
        board_code = str(match.iloc[0]["code"])

        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        stocks = []
        for page in range(1, 20):
            url = f"http://q.10jqka.com.cn/gn/detail/code/{board_code}/page/{page}/"
            try:
                r = requests.get(url, headers=headers, timeout=10)
                soup = BeautifulSoup(r.text, "html.parser")
                tables = soup.find_all("table")
                if len(tables) < 1:
                    break
                rows = tables[0].find_all("tr")
                if len(rows) <= 1:
                    break
                for row in rows[1:]:
                    cells = row.find_all("td")
                    if len(cells) >= 4:
                        code = cells[1].get_text(strip=True)
                        name = cells[2].get_text(strip=True)
                        if code and name and not code.startswith(("8", "4")) and "ST" not in name:
                            stocks.append((code, name))
                if len(rows) < 11:
                    break
            except:
                break
        return list(dict.fromkeys(stocks))[:30]
    except:
        return []


# ──────────────────────────────────────────────
# Step 3: 候选股票按概念分类
# ──────────────────────────────────────────────

def classify_candidates(candidates: List[Dict]) -> Dict[str, List[Dict]]:
    """
    对候选股票按所属概念板块分类。

    返回: {"概念板块名": [候选股票, ...], ...}
    """
    from swing_trader.utils.hot_sector_analyzer import HotSectorAnalyzer

    codes = [c["code"] for c in candidates]
    print(f"  获取 {len(codes)} 只候选股票的概念板块...")

    # 并行获取概念板块
    concepts_map = HotSectorAnalyzer.get_stocks_concepts_batch(codes)

    # 建立反向索引: 概念板块 → [股票]
    sector_to_stocks: Dict[str, List[Dict]] = {}
    for cand in candidates:
        code = cand["code"]
        cand_concepts = concepts_map.get(code, [])
        cand["concepts"] = cand_concepts  # 附加到候选记录
        for concept in cand_concepts:
            if concept not in sector_to_stocks:
                sector_to_stocks[concept] = []
            sector_to_stocks[concept].append(cand)

    # 统计覆盖情况
    covered = sum(1 for c in candidates if c.get("concepts"))
    print(f"  已分类: {covered}/{len(candidates)} 只股票")
    print(f"  涉及概念板块: {len(sector_to_stocks)} 个")

    return sector_to_stocks


# ──────────────────────────────────────────────
# Step 4: 热门板块排名
# ──────────────────────────────────────────────

def get_hot_sectors_ranking(progress_callback=None) -> Dict:
    """
    获取热门板块排名（10天内至少3次排名前5）。

    返回: {
        "hot_sectors": [...],
        "total_boards": N,
        "analyzed_dates": [...],
        "board_index_cache": {...},     # 板块指数数据（供赛道评分使用）
        "date_rankings": {...},         # 每日排名（供赛道评分使用）
    }
    """
    from swing_trader.utils.hot_sector_analyzer import HotSectorAnalyzer

    analyzer = HotSectorAnalyzer(max_workers=30)
    # top_n=10 因为375个板块竞争前5太激烈（前1.3%），前10（前2.7%）更合理
    # min_appearances=3: 8~10天中至少3次进入前10
    result = analyzer.analyze(
        window_days=10, top_n=10, min_appearances=3,
        progress_callback=progress_callback,
    )
    # 附加板块缓存数据（供赛道轮动评分使用）
    result["board_index_cache"] = getattr(analyzer, "_board_index_cache", {})
    # 构建 date_rankings
    date_rankings = {}
    if analyzer._board_index_cache:
        # 从缓存数据重建每日排名
        all_dates = set()
        for df in analyzer._board_index_cache.values():
            if "日期" in df.columns:
                for d in df["日期"].dropna().tolist():
                    all_dates.add(str(d)[:10])
        recent_dates = sorted(all_dates)[-10:]
        for date in recent_dates:
            board_pct = {}
            for board_name, df in analyzer._board_index_cache.items():
                if "日期" not in df.columns:
                    continue
                row = df[df["日期"].astype(str).str.startswith(date)]
                if row.empty:
                    continue
                pct = row.iloc[0].get("涨跌幅")
                if pct is not None and not pd.isna(pct):
                    board_pct[board_name] = pct
            if board_pct:
                sorted_boards = sorted(board_pct.items(), key=lambda x: x[1], reverse=True)
                date_rankings[date] = [b[0] for b in sorted_boards[:10]]
    result["date_rankings"] = date_rankings
    return result


# ──────────────────────────────────────────────
# Step 5: 匹配候选股票与热门板块
# ──────────────────────────────────────────────

def match_with_hot_sectors(
    candidates: List[Dict],
    hot_sectors: List[Dict],
) -> List[Dict]:
    """
    匹配候选股票与热门板块。

    对每个候选股票，检查它所属的概念板块是否在热门板块中。
    返回候选股票列表，增加 hot_match 字段。
    """
    hot_names = set(h["name"] for h in hot_sectors)

    for cand in candidates:
        cand_concepts = cand.get("concepts", [])
        matched_hot = [h for h in hot_names if h in cand_concepts]
        cand["hot_match"] = matched_hot
        cand["is_hot"] = len(matched_hot) > 0

    return candidates


# ──────────────────────────────────────────────
# Step 6: 生成交易计划报告
# ──────────────────────────────────────────────

def _buy_suggestion(pattern: str) -> str:
    """根据形态类型返回买卖点建议"""
    suggestions = {
        "A": "回踩年线/5日线低吸",
        "B": "放量突破均价线介入",
        "C": "放量加速确认跟进",
        "D": "贴5日线博弈",
        "E": "回踩阳线下沿不破介入",
        "F": "突破首阳高点确认介入",
    }
    return suggestions.get(pattern, "观察等待")


def generate_plan_report(
    phase: Dict,
    all_candidates: List[Dict],
    hot_sectors: List[Dict],
    sector_to_stocks: Dict[str, List[Dict]],
    watchlist_stocks: List[Tuple[str, str]] = None,
) -> str:
    """生成交易计划报告"""
    lines = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines.append(f"# Swing-Trader 交易计划")
    lines.append(f"**生成时间**: {now}")
    lines.append(f"")
    lines.append(f"---")
    lines.append(f"")
    lines.append(f"## 一、市场温度")
    lines.append(f"")
    lines.append(f"- **阶段**: {phase['phase']}")
    lines.append(f"- **右侧信号**: {phase['confidence']}/5")
    lines.append(f"- **建议仓位**: {phase['position']}")
    lines.append(f"")
    lines.append(f"---")
    lines.append(f"")

    # ── 重点跟踪自选股 ──
    if watchlist_stocks:
        lines.append(f"## 二、重点跟踪自选股")
        lines.append(f"")
        lines.append(f"| 代码 | 名称 | 形态信号 | 评分 | 所属概念 | 今日涨幅 | 量比 |")
        lines.append(f"|:---:|:---:|:---:|:---:|:---|:---:|:---:|")
        # 在候选池中查找自选股
        cand_by_code = {c["code"]: c for c in all_candidates}
        for code, name in watchlist_stocks:
            c = cand_by_code.get(code)
            if c:
                # 有形态信号
                concepts = c.get("concepts", [])
                concept_str = ", ".join(concepts[:3]) if concepts else "-"
                score = c.get("confidence_score", 0)
                lines.append(
                    f"| {code} | {name} | {c['pattern']} ✅ | {score} | {concept_str} "
                    f"| {c['pct_chg']:.1f}% | {c['vol_ratio']:.1f} |"
                )
            else:
                lines.append(
                    f"| {code} | {name} | 无信号 | - | - | - | - |"
                )
        lines.append(f"")
        lines.append(f"---")
        lines.append(f"")

    # ── rotation 推荐赛道（匹配用） ──
    section_num = "三" if watchlist_stocks else "二"
    is_rotation = bool(hot_sectors and "score" in hot_sectors[0])
    if is_rotation:
        lines.append(f"## {section_num}、赛道轮动推荐（rotation 评分匹配）")
        lines.append(f"")
        lines.append(f"| 排名 | 赛道名称 | 评分 | 评级 | 最新涨跌幅 |")
        lines.append(f"|:---:|:---|:---:|:---:|:---:|")
        for i, hs in enumerate(hot_sectors, 1):
            pct_str = f"{hs['latest_pct']:.2f}%" if hs.get('latest_pct') else "-"
            lines.append(
                f"| {i} | {hs['name']} | {hs['score']} | {hs.get('rating', '')} | {pct_str} |"
            )
        total_scored = len(hot_sectors)
        print(f"     推荐赛道数: {total_scored}")
    elif hot_sectors:
        lines.append(f"## {section_num}、热门板块（10天内连续3次排名前5）")
        lines.append(f"")
        lines.append(f"| 排名 | 板块名称 | 上榜次数 | 最新涨跌幅 | 平均涨跌幅 |")
        lines.append(f"|:---:|:---|:---:|:---:|:---:|")
        for i, hs in enumerate(hot_sectors, 1):
            lines.append(
                f"| {i} | {hs['name']} | {hs['rank_times']}次 "
                f"| {hs['latest_pct']:.2f}% | {hs['avg_pct']:.2f}% |"
            )
    else:
        lines.append(f"## {section_num}、热门板块")
        lines.append(f"今日无热门板块数据。")
    lines.append(f"")
    lines.append(f"---")
    lines.append(f"")

    # ── 候选股票池（按形态分组、显示热门匹配） ──
    pool_section = "四" if watchlist_stocks else "三"
    lines.append(f"## {pool_section}、候选股票池")
    lines.append(f"")
    lines.append(f"**共 {len(all_candidates)} 只候选标的**")
    lines.append(f"")

    # 按形态分组（D→A→B→C→E）
    pattern_order = {"D": "新高模式", "A": "首板250", "B": "上影线试盘",
                     "C": "小阳线爬升", "E": "反包博弈"}
    pattern_win_rates = {"D": "76.0%", "A": "47.1%", "B": "46.2%",
                         "C": "72.7%", "E": "61.5%"}

    # 筛选出热门匹配的
    hot_matched = [c for c in all_candidates if c.get("is_hot")]
    non_hot = [c for c in all_candidates if not c.get("is_hot")]

    # 热门匹配优先展示
    if hot_matched:
        lines.append(f"### 🔥 热门板块匹配标的（建议重点关注）")
        lines.append(f"")
        lines.append(f"| 代码 | 名称 | 形态 | 评分 | 合力 | 买卖点 | 匹配热门板块 | 涨幅 | 量比 |")
        lines.append(f"|:---:|:---:|:---:|:---:|:---:|:---|:---|:---:|:---:|")
        for c in hot_matched:
            hot_str = ", ".join(c.get("hot_match", [])[:3])
            score = c.get("confidence_score", 0)
            # 合力评分
            conv = c.get("convergence", {})
            conv_score = conv.get("score", 0)
            conv_ev = conv.get("evaluation", "-")
            conv_str = f"{conv_score}分" if conv_score > 0 else "-"
            suggestion = _buy_suggestion(c.get("pattern", ""))
            lines.append(
                f"| {c['code']} | {c['name']} | {c['pattern']} "
                f"| {score} | {conv_str} | {suggestion} | {hot_str} | {c['pct_chg']:.1f}% | {c['vol_ratio']:.1f} |"
            )
        lines.append(f"")

    # 非热门匹配按形态展示
    if non_hot:
        lines.append(f"### 其他候选标的")
        lines.append(f"")
        for pattern_type in ["D", "A", "B", "C", "E"]:
            group = [c for c in non_hot if c["pattern"] == pattern_type]
            if group:
                pname = pattern_order.get(pattern_type, pattern_type)
                wr = pattern_win_rates.get(pattern_type, "")
                lines.append(f"#### {pname}({pattern_type}) - {len(group)} 只 - 回测胜率{wr}")
                lines.append(f"")
                lines.append(f"| 代码 | 名称 | 评分 | 合力 | 买卖点 | 所属概念 | 涨幅 | 量比 |")
                lines.append(f"|:---:|:---:|:---:|:---:|:---|:---|:---:|:---:|")
                for c in group:
                    concepts = c.get("concepts", [])
                    concept_str = ", ".join(concepts[:3]) if concepts else "-"
                    score = c.get("confidence_score", 0)
                    # 合力评分
                    conv = c.get("convergence", {})
                    conv_score = conv.get("score", 0)
                    conv_str = f"{conv_score}分" if conv_score > 0 else "-"
                    suggestion = _buy_suggestion(c.get("pattern", ""))
                    lines.append(
                        f"| {c['code']} | {c['name']} | {score} | {conv_str} | {suggestion} | {concept_str} "
                        f"| {c['pct_chg']:.1f}% | {c['vol_ratio']:.1f} |"
                    )
                lines.append(f"")

    if not all_candidates:
        lines.append(f"**今日无符合形态的候选标的**")
        lines.append(f"")

    lines.append(f"---")
    lines.append(f"")

    # ── 候选股票概念分布 ──
    concept_section = "五" if watchlist_stocks else "四"
    lines.append(f"## {concept_section}、候选股票概念分布")
    lines.append(f"")
    if sector_to_stocks:
        # 按股票数量排序
        sorted_sectors = sorted(sector_to_stocks.items(),
                                key=lambda x: len(x[1]), reverse=True)
        lines.append(f"| 概念板块 | 候选股票数 | 具体标的 |")
        lines.append(f"|:---|:---:|:---|")
        for sector, stocks in sorted_sectors[:20]:
            names = ", ".join(f"{s['name']}({s['pattern']})" for s in stocks[:5])
            lines.append(f"| {sector} | {len(stocks)} | {names} |")
    else:
        lines.append(f"暂无概念分类数据。")
    lines.append(f"")
    lines.append(f"---")
    lines.append(f"")

    # ── 风险提示 ──
    risk_section = "六" if watchlist_stocks else "五"
    lines.append(f"## {risk_section}、风险提示")
    lines.append(f"")
    lines.append(f"1. ⚠️ 本计划仅为辅助决策，不构成投资建议")
    lines.append(f"2. ⚠️ 严格执行止损纪律：单票亏损 > 5% 坚决离场")
    lines.append(f"3. ⚠️ 仓位不超过建议仓位上限")
    lines.append(f"4. ⚠️ 市场有风险，投资需谨慎")
    lines.append(f"")
    lines.append(f"---")
    lines.append(f"*Swing-Trader v2.0 | 数据驱动 · 右侧交易 · 热门板块匹配 · 严格风控*")

    return "\n".join(lines)


# ──────────────────────────────────────────────
# 主流程
# ──────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  Swing-Trader 全市场扫描 v2.0")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 60)
    print()

    # ── Step 1: 市场阶段 ──
    print("[1/6] 市场阶段判断...")
    phase = get_market_phase()
    print(f"   阶段: {phase['phase']} | 信号: {phase['confidence']}/5 | 建议仓位: {phase['position']}")

    if phase["phase"] == "冬":
        print("\n⚠️ 当前市场处于冬阶段，建议空仓观望。\n")
        return

    print()

    # ── Step 2: 全市场形态扫描 ──
    print("=" * 50)
    print("Step 2/6: 全市场形态扫描")
    print("=" * 50)
    all_candidates = []

    # 2a: 扫描全市场涨幅>9.9%标的
    print("\n[2a] 扫描全市场涨幅>9.9%标的（新浪数据）...")
    gainers = get_gainer_stocks()
    print(f"   全市场涨幅>9.9%: {len(gainers)} 只")
    if gainers:
        results = scan_stocks(gainers)
        for r in results:
            r["source"] = "涨幅>9.9%"
        all_candidates.extend(results)
        print(f"   ✅ 发现 {len(results)} 个信号")

    # 2b: 扫描重点板块成分股（赛道轮动评分推荐）
    print("\n[2b] 扫描重点板块成分股（赛道轮动推荐）...")
    scan_sectors = get_scan_sectors()
    print(f"   扫描赛道数: {len(scan_sectors)} 个")
    scanned_codes = set(c["code"] for c in all_candidates)
    for sector in scan_sectors:
        print(f"   板块: {sector}")
        stocks = get_sector_stocks(sector)
        if not stocks:
            print(f"     ⚠️ 无法获取成分股")
            continue
        # 排除已扫描的
        new_stocks = [(c, n) for c, n in stocks if c not in scanned_codes]
        if not new_stocks:
            print(f"     全部已扫描，跳过")
            continue
        print(f"     待扫描: {len(new_stocks)} 只（去重后）")
        results = scan_stocks(new_stocks)
        if results:
            for r in results:
                r["source"] = sector
                scanned_codes.add(r["code"])
            all_candidates.extend(results)
            print(f"     ✅ 发现 {len(results)} 个信号")

    # 2c: 扫描重点跟踪（自选股）
    watchlist_stocks = get_watchlist()
    if watchlist_stocks and len(watchlist_stocks) > 0:
        print(f"\n[2c] 扫描重点跟踪自选股（{len(watchlist_stocks)} 只）...")
        for code, name in watchlist_stocks:
            print(f"   {code} {name}")
        new_watch = [(c, n) for c, n in watchlist_stocks if c not in scanned_codes]
        if new_watch:
            results = scan_stocks(new_watch)
            if results:
                for r in results:
                    r["source"] = "重点跟踪"
                    scanned_codes.add(r["code"])
                all_candidates.extend(results)
                print(f"   ✅ 发现 {len(results)} 个信号")
            else:
                print(f"   无形态信号")
        else:
            print(f"   全部已在候选池中")

    # 去重
    seen = set()
    deduped = []
    for c in all_candidates:
        if c["code"] not in seen:
            seen.add(c["code"])
            deduped.append(c)
    all_candidates = deduped

    # 用新浪实时数据覆盖候选股的涨跌幅（修正baostock滞后问题）
    if all_candidates:
        print("\n[实时校正] 获取今日真实涨跌幅覆盖baostock数据...")
        get_realtime_quotes(all_candidates)

    print(f"\n   📊 共发现 {len(all_candidates)} 个候选标的（去重后）")
    for p in ["D", "A", "B", "C", "E"]:
        count = sum(1 for c in all_candidates if c["pattern"] == p)
        if count:
            print(f"       {p}: {count} 只")

    if not all_candidates:
        print("\n⚠️ 今日无符合形态的候选标的，不继续后续分析。")
        report = generate_plan_report(phase, [], [], {}, watchlist_stocks=watchlist_stocks)
        output_dir = "scan_results"
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f"trade_plan_{datetime.now().strftime('%Y%m%d')}.md")
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"\n✅ 交易计划已保存: {output_path}")
        print(report)
        return

    # ── 排雷引擎 ──
    print("\n" + "=" * 50)
    print("排雷引擎: 业绩/公告/交易/板块四维检查")
    print("=" * 50)
    risk_checker = RiskChecker()
    risk_results = risk_checker.batch_check([(c["code"], c["name"]) for c in all_candidates])
    clean_candidates = []
    for cand, risk in zip(all_candidates, risk_results):
        cand["risk_level"] = risk.risk_level
        cand["risk_fatal"] = risk.is_fatal()
        if risk.is_fatal():
            print(f"  🔴 {cand['name']}({cand['code']}): 致命雷 — 剔除")
        else:
            clean_candidates.append(cand)
    if len(clean_candidates) < len(all_candidates):
        print(f"  排雷后剩余: {len(clean_candidates)}/{len(all_candidates)} 个")
    all_candidates = clean_candidates

    # ── 首板后低吸跟踪 ──
    tracker = PostFirstBoardTracker()
    tracked_count = 0
    for c in all_candidates:
        if c["pattern"] == "A":
            # 构造简化的 PatternMatch 对象供跟踪器使用
            from swing_trader.core.pattern_scan import PatternMatch
            pm = PatternMatch()
            pm.symbol = c["code"]
            pm.name = c["name"]
            pm.pattern_type = "A"
            pm.sector = ""
            pm.latest_close = c["price"]
            pm.latest_pct = c["pct_chg"]
            pm.vol_ratio = c.get("vol_ratio", 0.0)
            tracker.add_from_match(pm)
            tracked_count += 1
    buy_signals = tracker.update_all()
    if buy_signals:
        print(f"  🔔 {len(buy_signals)} 个首板后低吸信号触发!")
        for sig in buy_signals:
            print(f"      {sig['name']}({sig['symbol']}): {sig['reason']}")
    elif tracked_count > 0:
        print(f"  首板跟踪: {tracked_count} 新加入, {len(tracker.get_tracking_list())} 在跟踪")

    if not all_candidates:
        print("\n⚠️ 所有候选标的均被排雷引擎过滤")
        report = generate_plan_report(phase, [], [], {}, watchlist_stocks=watchlist_stocks)
        output_dir = "scan_results"
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, f"trade_plan_{datetime.now().strftime('%Y%m%d')}.md")
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"\n✅ 交易计划已保存: {output_path}")
        print(report)
        return

    # ── Step 3: 候选股票按概念分类 ──
    sector_to_stocks = classify_candidates(all_candidates)
    print()

    # ── Step 4: 热门板块排名 ──
    print("=" * 50)
    print("Step 4/6: 热门板块排名分析")
    print("   （10天内至少3次排名前5 = 热门板块）")
    print("=" * 50)

    def progress_cb(completed, total):
        if completed % 100 == 0:
            print(f"   板块数据获取进度: {completed}/{total}")

    print("\n   正在获取所有概念板块指数数据（顺序获取，约需5-8分钟）...")
    print("   提示：首次运行后会缓存，后续运行瞬间完成")
    hot_result = get_hot_sectors_ranking(progress_callback=progress_cb)

    hot_sectors = hot_result.get("hot_sectors", [])
    total_boards = hot_result.get("total_boards", 0)
    analyzed_dates = hot_result.get("analyzed_dates", [])

    print(f"\n   分析完成:")
    print(f"     总板块数: {total_boards}")
    print(f"     分析日期: {analyzed_dates[0]} ~ {analyzed_dates[-1]} ({len(analyzed_dates)}天)")
    print(f"     热门板块数: {len(hot_sectors)}")
    for hs in hot_sectors:
        print(f"       🔥 {hs['name']}: {hs['rank_times']}次上榜, "
              f"最新{hs['latest_pct']:.2f}%, 平均{hs['avg_pct']:.2f}%")

    # ── 赛道轮动评分刷新（基于已获取的板块数据） ──
    if CONFIG.rotation.enabled:
        board_cache = hot_result.get("board_index_cache", {})
        date_rankings = hot_result.get("date_rankings", {})
        if board_cache:
            print("\n   📊 赛道轮动评分: 基于板块数据分析推荐赛道...")
            updated_sectors = force_refresh_scan_sectors(board_cache, date_rankings)
            print(f"     推荐扫描赛道: {len(updated_sectors)} 个")
    print()

    # ── Step 5: 匹配候选股票与热门板块 ──
    print("=" * 50)
    print("Step 5/6: 候选股票与赛道匹配")
    print("=" * 50)

    # 使用 rotation 推荐赛道进行匹配
    # load_recommendations() 在加载层已做好 THS 映射（ths_scan_sectors）
    rotation_rec = load_recommendations()
    if rotation_rec and rotation_rec.get("recommendations"):
        # display_sectors: 原始赛道名 + 评分（用于报告显示）
        display_sectors = []
        for r in rotation_rec["recommendations"]:
            display_sectors.append({
                "name": r["name"],
                "score": r.get("score", 0),
                "rating": r.get("rating_label", ""),
                "latest_pct": float(r.get("latest_pct", 0)) if r.get("latest_pct") else 0,
            })
        # match_sectors: 同花顺板块名（用于匹配候选股概念，加载层已映射好）
        ths_names = rotation_rec.get("ths_scan_sectors", [])
        match_sectors = [{"name": t} for t in ths_names]

        print(f"   使用 rotation 推荐赛道进行匹配")
        print(f"     报告赛道: {len(display_sectors)} 个")
        print(f"     同花顺板块: {len(match_sectors)} 个")
        for r in display_sectors[:5]:
            print(f"     📊 {r['name']} (评分: {r['score']})")
        if len(display_sectors) > 5:
            print(f"     ... 共 {len(display_sectors)} 个赛道")

        match_source_sectors = match_sectors
        display_source_sectors = display_sectors
    else:
        # 后备：使用 HotSectorAnalyzer 热门板块
        print(f"   赛道推荐未就绪，使用 HotSectorAnalyzer 热门板块 ({len(hot_sectors)} 个)")
        match_source_sectors = hot_sectors
        display_source_sectors = hot_sectors

    all_candidates = match_with_hot_sectors(all_candidates, match_source_sectors)

    hot_matched = [c for c in all_candidates if c.get("is_hot")]
    print(f"\n   匹配结果:")
    print(f"     与推荐赛道匹配: {len(hot_matched)} 只")
    for c in hot_matched:
        print(f"       {c['code']} {c['name']} ({c['pattern']}) → "
              f"{', '.join(c.get('hot_match', []))}")
    print(f"     未匹配: {len(all_candidates) - len(hot_matched)} 只")
    print()

    # ── Step 5b: 资金合力分析（对每个候选股） ──
    print("=" * 50)
    print("Step 5b/6: 候选股资金合力分析")
    print("=" * 50)
    try:
        from swing_trader.utils.capital_convergence import analyze_convergence
        conv_count = 0
        for c in all_candidates:
            try:
                conv = analyze_convergence(
                    symbol=c["code"],
                    name=c["name"],
                    current_price=c.get("price", 0),
                    today_pct=c.get("pct_chg", 0),
                )
                c["convergence"] = {
                    "score": conv["total_score"],
                    "max_score": conv["max_score"],
                    "evaluation": conv["evaluation"],
                }
                conv_count += 1
            except Exception as e:
                logger.debug(f"合力分析失败 {c['code']}: {e}")
        print(f"   完成: {conv_count}/{len(all_candidates)} 只")
        if conv_count > 0:
            strong = sum(1 for c in all_candidates if c.get("convergence", {}).get("score", 0) >= 12)
            medium = sum(1 for c in all_candidates if 8 <= c.get("convergence", {}).get("score", 0) < 12)
            weak = sum(1 for c in all_candidates if c.get("convergence", {}).get("score", 0) < 8)
            if strong:
                print(f"     [强合力] {strong} 只")
            if medium:
                print(f"     [一般] {medium} 只")
            if weak:
                print(f"     [弱/分歧] {weak} 只")
    except Exception as e:
        print(f"   ⚠️ 资金合力分析模块未加载: {e}")
    print()

    # ── Step 6: 生成交易计划报告 ──
    print("=" * 50)
    print("Step 6/6: 生成交易计划书")
    print("=" * 50)
    report = generate_plan_report(phase, all_candidates, display_source_sectors, sector_to_stocks,
                                  watchlist_stocks=watchlist_stocks)

    output_dir = "scan_results"
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"trade_plan_{datetime.now().strftime('%Y%m%d')}.md")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"\n   ✅ 交易计划已保存: {output_path}")
    print()

    # 打印到控制台
    print(report)
    print()


if __name__ == "__main__":
    main()
