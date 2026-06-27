"""
晓胜波段王 · 盘中风险监控
=========================
每日 13:15 自动执行，基于上午半天数据分析风险和机会。

监控维度:
  1. 大盘指数实时表现（涨跌幅、成交额）
  2. 市场宽度（涨跌家数比、涨停/跌停）
  3. 交易计划候选股实时状态
  4. 北向资金流向
  5. 板块轮动
  6. 综合风险评级

用法: python midday_check.py
"""
import sys, os, io, re

if sys.platform == "win32":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import logging
logging.basicConfig(level=logging.WARNING, format="%(message)s")
# 压制 akshare 的 tqdm 进度条
os.environ["AKSHARE_PROGRESS_BAR"] = "0"
os.environ["AKSHARE_DISABLE_PROGRESS"] = "1"
logging.getLogger("akshare").setLevel(logging.ERROR)
try:
    from akshare import progress
    progress.disable_progress_bar()
except Exception:
    pass

from datetime import datetime, timedelta

# 周末跳过
if datetime.now().weekday() >= 5:  # Saturday(5) or Sunday(6)
    print("周末休市，跳过执行")
    sys.exit(0)
from typing import List, Dict, Optional, Tuple
import numpy as np
import pandas as pd



# ──────────────────────────────────────────────
# 1. 大盘指数
# ──────────────────────────────────────────────

def _sina_fetch(codes: Dict[str, str]) -> Dict:
    """统一的新浪接口请求 + 简单重试"""
    import requests
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://finance.sina.com.cn",
    }
    url = "https://hq.sinajs.cn/list=" + ",".join(codes.keys())
    for attempt in range(2):
        try:
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code == 200:
                return resp.text
        except Exception:
            if attempt == 0:
                continue
    return ""


def get_index_realtime() -> Dict:
    """获取主要指数实时行情（新浪接口）"""
    codes = {"sh000001": "上证指数", "sz399001": "深证成指",
             "sz399006": "创业板指", "sh000688": "科创50"}
    result = {}
    try:
        text = _sina_fetch(codes)
        if not text:
            return result
        for line in text.strip().split("\n"):
            line = line.strip().strip(";")
            if "=" not in line:
                continue
            parts = line.split("=", 1)
            data = parts[1].strip('"').split(",")
            if len(data) >= 32:
                # 新浪指数格式: 名称,今开,昨收,最新(3),最高,最低,涨跌额(6),涨跌幅%(7),成交量(8),成交额(9)
                name = data[0]
                price = float(data[3]) if data[3] else 0
                pct_str = data[7] if len(data) > 7 else "0"
                pct = float(pct_str) if pct_str else 0
                vol = float(data[9]) if len(data) > 9 and data[9] else 0
                result[name] = {"price": price, "pct": pct, "volume": vol}
    except Exception:
        pass
    return result


# ──────────────────────────────────────────────
# 2. 市场宽度（全市场实时数据）
# ──────────────────────────────────────────────

# 共享缓存：stock_zh_a_spot() 只调用一次
_spot_df_cache: Optional[pd.DataFrame] = None

def _get_spot_df(refresh: bool = False) -> pd.DataFrame:
    """获取全市场快照（带缓存，避免多次请求）"""
    global _spot_df_cache
    if _spot_df_cache is not None and not refresh:
        return _spot_df_cache
    import akshare as ak
    try:
        _spot_df_cache = ak.stock_zh_a_spot()
    except Exception:
        _spot_df_cache = pd.DataFrame()
    return _spot_df_cache


def get_market_breadth(df: Optional[pd.DataFrame] = None) -> Dict:
    """统计全市场涨跌分布"""
    if df is None:
        df = _get_spot_df()
    try:
        if df.empty:
            return {"total": 0}

        # Sina版列顺序: 代码,名称,最新价,涨跌幅(4),涨跌额(5),...
        pct_col = df.columns[3]  # 涨跌幅是第4列
        pcts = pd.to_numeric(df[pct_col], errors="coerce").fillna(0)

        up = int((pcts > 0).sum())
        down = int((pcts < 0).sum())
        flat = int((pcts == 0).sum())

        limit_up = int((pcts >= 9.5).sum())
        limit_down = int((pcts <= -9.5).sum())

        return {"total": len(df), "up": up, "down": down, "flat": flat,
                "limit_up": limit_up, "limit_down": limit_down}
    except Exception as e:
        return {"total": 0}


# ──────────────────────────────────────────────
# 3. 解析交易计划中的候选股
# ──────────────────────────────────────────────

def parse_trade_plan_candidates() -> List[Dict]:
    """
    读取今日交易计划，解析候选股票列表

    返回: [{"code": str, "name": str, "pattern": str, "concepts": str}, ...]
    """
    today = datetime.now().strftime("%Y%m%d")
    # 先看今天有没有生成计划，没有就看昨天的
    for offset in [0, -1]:
        date_str = (datetime.now() + timedelta(days=offset)).strftime("%Y%m%d")
        path = os.path.join("scan_results", f"trade_plan_{date_str}.md")
        if not os.path.exists(path):
            continue

        candidates = []
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        for line in lines:
            # 匹配表格行: | 代码 | 名称 | 形态 | ...
            if line.startswith("|") and line.count("|") >= 4:
                cells = [c.strip() for c in line.split("|")]
                # 跳过表头行（包含"代码"、"---"等）
                if len(cells) < 4:
                    continue
                if "代码" in cells or "---" in cells:
                    continue
                code = cells[1] if len(cells) > 1 else ""
                name = cells[2] if len(cells) > 2 else ""
                pattern = cells[3] if len(cells) > 3 else ""
                # 表格中可能有不同列数，但前3列固定: 代码 | 名称 | 形态
                # 部分表可能没有形态列（非候选表），通过是否为6位数字代码判断
                if re.match(r"^\d{6}$", code) and name and pattern in ("A","B","C","D","E"):
                    candidates.append({
                        "code": code,
                        "name": name,
                        "pattern": pattern,
                    })
        if candidates:
            return candidates
    return []


# ──────────────────────────────────────────────
# 4. 个股风险检查
# ──────────────────────────────────────────────

def check_stock_risks(candidates: List[Dict], df: Optional[pd.DataFrame] = None) -> Tuple[List[Dict], str]:
    """
    对候选股逐一检查实时风险

    返回: (risk_items_list, summary_table_str)
    """
    if not candidates:
        return [], "（无候选数据）"

    if df is None:
        df = _get_spot_df()
    try:
        if df.empty:
            return [], "（实时数据获取失败）"
    except Exception as e:
        return [], f"（实时数据获取异常: {e}）"

    # 列索引（Sina版）
    code_col = df.columns[0]
    name_col = df.columns[1]
    price_col = df.columns[2]
    pct_col = df.columns[3]

    # 构建代码→行 的快速索引（处理 sh/sz/bj 前缀）
    code_map = {}
    for _, row in df.iterrows():
        code = str(row[code_col]).strip()
        if code:
            code_map[code] = row  # 完整代码: sh688012
            # 同时注册裸代码: 688012（交易计划用裸代码）
            if len(code) > 2 and code[:2] in ("sh", "sz", "bj"):
                code_map[code[2:]] = row

    risks = []
    table_rows = []

    for cand in candidates:
        code = cand["code"]
        row = code_map.get(code)
        if row is None:
            continue

        try:
            pct = float(row[pct_col])
        except (ValueError, TypeError):
            pct = 0
        try:
            price = float(row[price_col])
        except (ValueError, TypeError):
            price = 0

        name = cand["name"]
        pattern = cand["pattern"]
        risk_level = "无"
        risk_reason = ""
        icon = ""

        # 风险判断
        if pct < -7:
            risk_level = "🔴 致命"
            risk_reason = f"暴跌{pct:.1f}%"
        elif pct < -5:
            risk_level = "🔴 高风险"
            risk_reason = f"大跌{pct:.1f}%"
        elif pct < -3:
            risk_level = "🟡 警告"
            risk_reason = f"下跌{pct:.1f}%"
        elif pct > 9:
            risk_level = "🟢 涨停"
            risk_reason = f"涨停{pct:.1f}%"

        if risk_level != "无":
            risks.append({
                "code": code, "name": name, "pattern": pattern,
                "pct": pct, "price": price,
                "risk_level": risk_level, "risk_reason": risk_reason,
            })

        # 风险图标（表格用）
        if pct < -5:
            icon = "🔴"
        elif pct < -3:
            icon = "🟡"
        elif pct > 9:
            icon = "🟢"
        elif pct > 5:
            icon = "🟢"
        else:
            icon = "  "

        table_rows.append(f"| {icon} | {code} | {name} | {pattern} | {pct:+.1f}% | {price:.2f} | {risk_reason or '正常'} |")

    # 按风险排序（致命>高风险>警告>正常）
    risk_order = {"🔴 致命": 0, "🔴 高风险": 1, "🟡 警告": 2}
    risks.sort(key=lambda r: risk_order.get(r["risk_level"], 9))

    header = "|   | 代码 | 名称 | 形态 | 实时涨幅 | 现价 | 风险提示 |\n|:---:|:---:|:---:|:---:|:---:|:---:|:---|\n"
    summary = header + "\n".join(table_rows) if table_rows else "（无匹配数据）"

    return risks, summary


# ──────────────────────────────────────────────
# 5. 北向资金
# ──────────────────────────────────────────────

def get_north_flow() -> Optional[Dict]:
    """获取北向资金实时流向"""
    # 方法1: 尝试 akshare EM 接口
    try:
        import akshare as ak
        df = ak.stock_hsgt_north_flow_em()
        if df is not None and not df.empty:
            latest = df.iloc[-1]
            val_col = None
            for c in df.columns:
                if "净流入" in str(c):
                    val_col = c; break
            if val_col:
                val = float(latest[val_col])
                return {"value": val, "status": "流入" if val > 0 else "流出"}
    except Exception:
        pass

    # 方法2: 直接请求东方财富API
    try:
        import requests
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://data.eastmoney.com/",
        }
        url = (
            "https://push2.eastmoney.com/api/qt/kamt.kline/get?"
            "fields1=f1,f2,f3,f5&fields2=f51,f52,f53,f54,f55&klt=1&lmt=1"
        )
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            klines = data.get("data", {}).get("klines", [])
            if klines:
                # 格式: "日期,沪股通净流入,深股通净流入,总净流入,总额度"
                parts = klines[-1].split(",")
                if len(parts) >= 4:
                    total = float(parts[3])
                    return {"value": total, "status": "流入" if total > 0 else "流出"}
    except Exception:
        pass
    return None


# ──────────────────────────────────────────────
# 6. 板块轮动
# ──────────────────────────────────────────────

def get_sector_midday() -> List[Dict]:
    """获取今日上午涨幅居前/跌幅居前的板块"""
    import akshare as ak
    try:
        df = ak.stock_sector_fund_flow_rank(indicator="今日", sector_type="行业资金流向")
        if df is None or df.empty:
            return []

        results = []
        name_col = None
        pct_col = None
        for c in df.columns:
            if "名称" in str(c):
                name_col = c
            if "涨跌幅" in str(c):
                pct_col = c

        if name_col and pct_col:
            # 取前5和后5
            for _, row in df.head(5).iterrows():
                results.append({
                    "name": str(row[name_col]),
                    "pct": float(row[pct_col]),
                    "type": "领涨",
                })
            for _, row in df.tail(5).iterrows():
                results.append({
                    "name": str(row[name_col]),
                    "pct": float(row[pct_col]),
                    "type": "领跌",
                })
        return results
    except Exception as e:
        return []


# ──────────────────────────────────────────────
# 7. 综合风险评分
# ──────────────────────────────────────────────

def assess_risk_level(market: Dict, breadth: Dict, stock_risks: List[Dict]) -> Tuple[str, str]:
    """
    综合评估当前市场风险等级

    返回: (risk_level, description)
    """
    risk_score = 0
    reasons = []

    # 大盘维度
    if market:
        sh = market.get("上证指数", {})
        sh_pct = sh.get("pct", 0)
        if sh_pct < -1.5:
            risk_score += 3
            reasons.append(f"上证跌{sh_pct:.1f}%＞1.5%")
        elif sh_pct < -0.8:
            risk_score += 1
            reasons.append(f"上证跌{sh_pct:.1f}%")

        cy = market.get("创业板指", {})
        cy_pct = cy.get("pct", 0)
        if cy_pct < -2:
            risk_score += 2
            reasons.append(f"创业板跌{cy_pct:.1f}%＞2%")

    # 市场宽度
    if breadth.get("total", 0) > 0:
        total = breadth["total"]
        up_ratio = breadth["up"] / total
        down_ratio = breadth["down"] / total
        limit_up = breadth.get("limit_up", 0)
        limit_down = breadth.get("limit_down", 0)

        if up_ratio < 0.2:  # < 20%股票上涨 = 普跌
            risk_score += 2
            reasons.append(f"仅{up_ratio:.0%}个股上涨（普跌）")
        elif up_ratio < 0.35:
            risk_score += 1
            reasons.append(f"仅{up_ratio:.0%}个股上涨")

        if limit_down > 20:  # 超过20只跌停
            risk_score += 2
            reasons.append(f"{limit_down}只跌停")
        elif limit_down > 10:
            risk_score += 1
            reasons.append(f"{limit_down}只跌停")

    # 候选个股风险
    high_risk = sum(1 for r in stock_risks if "致命" in r["risk_level"] or "高风险" in r["risk_level"])
    warns = sum(1 for r in stock_risks if "警告" in r["risk_level"])
    if high_risk >= 3:
        risk_score += 3
        reasons.append(f"{high_risk}只候选股高风险")
    elif high_risk >= 1:
        risk_score += 2
        reasons.append(f"{high_risk}只候选股高风险")
    if warns >= 3:
        risk_score += 1
        reasons.append(f"{warns}只候选股预警")

    # 综合评级
    if risk_score >= 5:
        return "🔴 高风险", "; ".join(reasons)
    elif risk_score >= 3:
        return "🟡 预警", "; ".join(reasons)
    elif risk_score >= 1:
        return "🔵 关注", "; ".join(reasons)
    else:
        return "🟢 正常", "大盘和个股运行平稳"


# ──────────────────────────────────────────────
# 主流程
# ──────────────────────────────────────────────

def main():
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = []

    lines.append("=" * 54)
    lines.append("  晓胜波段王 · 盘中风险监控")
    lines.append(f"  {now}（下午开盘15分钟后）")
    lines.append("=" * 54)
    lines.append("")

    # ── 大盘指数 ──
    print("[1/5] 获取大盘指数...")
    market = get_index_realtime()
    lines.append("【大盘指数】")
    if market:
        for name, data in market.items():
            pct = data.get("pct", 0)
            vol = data.get("volume", 0)
            vol_str = f"{vol/1e8:.0f}亿" if vol > 0 else ""
            arrow = "↑" if pct >= 0 else "↓"
            lines.append(f"  {name}: {pct:+.2f}% {arrow}  {vol_str}")
    else:
        lines.append(f"  获取失败")
    lines.append("")

    # ── 获取全市场快照（共享，避免重复请求）──
    # print("  加载全市场实时数据...")
    df = _get_spot_df()

    # ── 市场宽度 ──
    print("[2/5] 统计市场宽度...")
    breadth = get_market_breadth(df)
    lines.append("【市场宽度】")
    if breadth.get("total", 0) > 0:
        lines.append(f"  上涨: {breadth['up']}  下跌: {breadth['down']}  平盘: {breadth['flat']}")
        up_ratio = breadth['up'] / breadth['total']
        lines.append(f"  涨跌比: {up_ratio:.0%} / {(1-up_ratio):.0%}")
        lines.append(f"  涨停: {breadth['limit_up']}  跌停: {breadth['limit_down']}")
    else:
        lines.append(f"  获取失败")
    lines.append("")

    # ── 交易计划个股风险 ──
    print("[3/5] 检查候选股实时状态...")
    candidates = parse_trade_plan_candidates()
    plan_date = "（今日无交易计划，使用最近数据）"
    if candidates:
        plan_date = f"（共{len(candidates)}只候选股）"
    stock_risks, stock_table = check_stock_risks(candidates, df)

    lines.append(f"【候选股监控】{plan_date}")
    if stock_risks:
        lines.append(f"  ⚠️ 发现 {len(stock_risks)} 只异常标的:")
        for r in stock_risks:
            lines.append(f"    {r['risk_level']} {r['name']}({r['code']}): {r['risk_reason']}")
    else:
        lines.append(f"  ✅ 候选股运行正常")
    lines.append("")
    lines.append("  详细清单:")
    lines.append(stock_table)
    lines.append("")

    # ── 北向资金 ──
    print("[4/5] 获取北向资金流向...")
    north = get_north_flow()
    lines.append("【北向资金】")
    if north:
        arrow = "↑" if north["status"] == "流入" else "↓"
        lines.append(f"  当日净{north['status']}: {north['value']:.1f}亿 {arrow}")
    else:
        lines.append(f"  获取失败（盘后数据可能延迟）")
    lines.append("")

    # ── 综合风险 ──
    print("[5/5] 综合风险评估...")
    risk_level, risk_reason = assess_risk_level(market, breadth, stock_risks)
    lines.append("=" * 54)
    lines.append(f"【综合风险评级】{risk_level}")
    lines.append(f"  {risk_reason}")
    lines.append("=" * 54)
    lines.append("")

    # 风险等级对应的操作建议
    if "高风险" in risk_level:
        lines.append("💡 建议: 市场风险较高，建议降低仓位、收缩战线。")
        lines.append("   候选股中出现大跌的标的，应暂缓买入或设好止损。")
        lines.append("   如已持仓，检查止损位是否触发。")
    elif "预警" in risk_level:
        lines.append("💡 建议: 市场有局部风险，注意控制单票仓位。")
        lines.append("   关注候选股中警告级别的标的，下午可能出现方向选择。")
    elif "关注" in risk_level:
        lines.append("💡 建议: 市场小幅波动，正常交易但保持警惕。")
    else:
        lines.append("💡 建议: 市场运行平稳，按计划执行即可。")

    lines.append("")
    lines.append("-" * 54)
    lines.append("*数据来源: 新浪财经实时行情 | 盘中13:15自动监控*")

    report = "\n".join(lines)

    # 输出到控制台
    print()
    print(report)

    # 保存到文件
    output_dir = "scan_results"
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, f"midday_risk_{datetime.now().strftime('%Y%m%d')}.md")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(f"# 盘中风险监控\n\n{report}\n")
    print(f"\n✅ 监控报告已保存: {output_path}")


if __name__ == "__main__":
    main()
