"""
资金合力分析 (Capital Convergence Analysis)
=============================================
评估一只股票在5个维度上的资金合力强度，判断
不同类型资金（散户、游资、机构）是否在同一方向形成共振。

评分体系 (0-15分):
  12-15  强势合力 - 多维度共振，资金高度一致
  8-11   一般合力 - 部分维度支持，存在分歧
  4-7    分歧     - 多空博弈，方向不明
  0-3    无合力   - 资金面疲软，不建议参与

5个维度 (每维0-3分):
  1. 量价配合 (Volume-Price Alignment)
  2. 资金流向 (Capital Flow Direction)
  3. 技术形态 (Technical Pattern)
  4. 板块共振 (Sector Resonance)
  5. 主力阶段 (Capital Phase)
"""
import os
import sys
import json
import logging
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple
from pathlib import Path

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# ── 模块级缓存（只在单次运行中有效） ──
_hist_cache: Dict[str, pd.DataFrame] = {}
_money_flow_cache: Dict[str, dict] = {}

# 东方财富API请求头
EASTMONEY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://quote.eastmoney.com/",
}


# ══════════════════════════════════════════════
#  数据获取
# ══════════════════════════════════════════════

def _get_secid(symbol: str) -> str:
    """股票代码转东方财富 secid"""
    return "1." + symbol if symbol.startswith("6") else "0." + symbol


def fetch_hist_data(symbol: str, days: int = 90) -> Optional[pd.DataFrame]:
    """获取个股历史日K线数据

    数据源优先级: AKShare → baostock → None

    Args:
        symbol: 6位股票代码
        days: 需要的最少交易日数

    Returns:
        DataFrame with columns: date, close, volume, high, low, open, pctChg
        或 None（全部失败）
    """
    if symbol in _hist_cache:
        return _hist_cache[symbol]

    end = datetime.now()
    # 多取一些日期以覆盖非交易日
    start = end - timedelta(days=days + 30)
    start_str = start.strftime("%Y%m%d")
    end_str = end.strftime("%Y%m%d")

    # ── Priority 1: AKShare ──
    try:
        import akshare as ak
        df = ak.stock_zh_a_hist(
            symbol=symbol,
            period="daily",
            start_date=start_str,
            end_date=end_str,
            adjust="qfq",
        )
        if df is not None and not df.empty:
            df.rename(columns={
                "日期": "date", "收盘": "close", "成交量": "volume",
                "最高": "high", "最低": "low", "开盘": "open",
                "涨跌幅": "pctChg", "换手率": "turnover",
            }, inplace=True)
            df["date"] = pd.to_datetime(df["date"])
            for c in ["close", "volume", "high", "low", "open", "pctChg"]:
                if c in df.columns:
                    df[c] = pd.to_numeric(df[c], errors="coerce")
            df.sort_values("date", inplace=True)
            df.reset_index(drop=True, inplace=True)
            if len(df) >= days // 2:
                _hist_cache[symbol] = df
                return df
    except Exception as e:
        logger.debug(f"AKShare 获取 {symbol} 失败: {e}")

    # ── Priority 2: baostock ──
    try:
        import baostock as bs
        lg = bs.login()
        if lg.error_code == "0":
            prefix = "sh." if symbol.startswith("6") else "sz."
            rs = bs.query_history_k_data_plus(
                prefix + symbol,
                "date,close,volume,high,low,open,pctChg",
                start_date=start.strftime("%Y-%m-%d"),
                end_date=end.strftime("%Y-%m-%d"),
                frequency="d", adjustflag="2",
            )
            rows = []
            if rs.error_code == "0":
                df_bs = rs.get_data()
                if df_bs is not None and not df_bs.empty:
                    df_bs.rename(columns={
                        "date": "date", "close": "close", "volume": "volume",
                        "high": "high", "low": "low", "open": "open",
                        "pctChg": "pctChg",
                    }, inplace=True)
                    df_bs["date"] = pd.to_datetime(df_bs["date"])
                    for c in ["close", "volume", "high", "low", "open", "pctChg"]:
                        if c in df_bs.columns:
                            df_bs[c] = pd.to_numeric(df_bs[c], errors="coerce")
                    df_bs.sort_values("date", inplace=True)
                    df_bs.reset_index(drop=True, inplace=True)
                    if len(df_bs) >= days // 2:
                        _hist_cache[symbol] = df_bs
                        return df_bs
            bs.logout()
    except Exception as e:
        logger.debug(f"baostock 获取 {symbol} 失败: {e}")

    return None


def fetch_money_flow(symbol: str) -> Optional[dict]:
    """获取东方财富资金流向数据

    API: push2.eastmoney.com/api/qt/stock/get
    字段:
        f62 = 主力净流入 (元)
        f64 = 超大单净流入 (元)
        f66 = 大单净流入 (元)
        f69 = 小单净流入 (元)
        f84 = 中单净流入 (元)
        f85 = 主力净流入占比 (‰, 千分比)

    Returns:
        {main_force, super_large, large, medium, small, main_ratio} 或 None
    """
    if symbol in _money_flow_cache:
        return _money_flow_cache[symbol]

    import urllib.request
    secid = _get_secid(symbol)
    url = (f"http://push2.eastmoney.com/api/qt/stock/get"
           f"?secid={secid}&fields=f62,f64,f66,f69,f84,f85")

    try:
        req = urllib.request.Request(url, headers=EASTMONEY_HEADERS)
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read().decode("utf-8"))
        d = data.get("data", {})
        if not d:
            return None

        result = {
            "main_force": float(d.get("f62", 0)),       # 主力净流入
            "super_large": float(d.get("f64", 0)),       # 超大单
            "large": float(d.get("f66", 0)),             # 大单
            "medium": float(d.get("f84", 0)),            # 中单
            "small": float(d.get("f69", 0)),             # 小单(散户)
            "main_ratio": float(d.get("f85", 0)),        # 主力净流入占比(‰)
        }
        _money_flow_cache[symbol] = result
        time.sleep(0.3)  # 避免请求过快
        return result
    except Exception as e:
        logger.debug(f"资金流向获取失败 {symbol}: {e}")
        return None


# ══════════════════════════════════════════════
#  指标计算
# ══════════════════════════════════════════════

def compute_ma(series: np.ndarray, period: int) -> np.ndarray:
    """计算移动平均"""
    if len(series) < period:
        return np.array([])
    return pd.Series(series).rolling(window=period).mean().values


def compute_macd(closes: np.ndarray) -> Dict:
    """计算MACD (12, 26, 9)

    Returns:
        {"macd": [...], "signal": [...], "hist": [...], "latest_macd": float, ...}
    """
    s = pd.Series(closes)
    ema12 = s.ewm(span=12, adjust=False).mean().values
    ema26 = s.ewm(span=26, adjust=False).mean().values
    macd_line = ema12 - ema26
    signal_line = pd.Series(macd_line).ewm(span=9, adjust=False).mean().values
    macd_hist = macd_line - signal_line

    return {
        "macd": macd_line,
        "signal": signal_line,
        "hist": macd_hist,
        "latest_macd": macd_line[-1],
        "latest_signal": signal_line[-1],
        "latest_hist": macd_hist[-1],
    }


# ══════════════════════════════════════════════
#  5维度评分
# ══════════════════════════════════════════════

def score_volume_price(
    closes: List[float],
    volumes: List[float],
    current_price: float,
) -> Dict:
    """维度1: 量价配合评分 (0-3)

    评分依据:
        3分: 放量上涨, vol_ratio>=1.5, price>MA5>MA10, price>=MA20
        2分: 温和放量, vol_ratio>=1.2, price>MA10
        1分: 量价平淡, vol_ratio 0.8-1.2 或 横盘
        0分: 量价背离, 放量下跌 或 缩量下跌
    """
    if len(closes) < 20:
        return {"score": 0, "reason": "数据不足(需20日)", "details": {}}

    closes_arr = np.array(closes[-20:])
    volumes_arr = np.array(volumes[-20:], dtype=float)
    latest_vol = volumes_arr[-1]
    avg_vol = np.mean(volumes_arr[:-1]) if len(volumes_arr) > 1 else latest_vol
    vol_ratio = latest_vol / avg_vol if avg_vol > 0 else 1.0

    ma5 = np.mean(closes_arr[-5:])
    ma10 = np.mean(closes_arr[-10:])
    ma20 = np.mean(closes_arr)

    pct_vs_ma5 = (current_price - ma5) / ma5 * 100
    pct_vs_ma10 = (current_price - ma10) / ma10 * 100
    pct_vs_ma20 = (current_price - ma20) / ma20 * 100

    # 均线排列
    if ma5 > ma10 > ma20:
        ma_alignment = "多头排列"
    elif ma5 < ma10 < ma20:
        ma_alignment = "空头排列"
    else:
        ma_alignment = "交叉"

    # 判定
    if vol_ratio >= 1.5 and current_price > ma5 and ma5 > ma10 and current_price >= ma20:
        score = 3
        reason = f"放量上涨(量比{vol_ratio:.1f})，站上所有均线"
    elif vol_ratio >= 1.2 and current_price > ma10:
        score = 2
        reason = f"温和放量上涨(量比{vol_ratio:.1f})，站上MA10"
    elif (0.8 <= vol_ratio < 1.2) or (ma20 * 0.97 <= current_price <= ma20 * 1.03):
        score = 1
        reason = f"量价平淡(量比{vol_ratio:.1f})，横盘整理"
    elif vol_ratio > 1.5 and current_price < ma5:
        score = 0
        reason = f"放量下跌(量比{vol_ratio:.1f})，抛压较大"
    else:
        score = 0
        reason = f"量价背离(量比{vol_ratio:.1f})，动量不足"

    return {
        "score": score,
        "reason": reason,
        "details": {
            "vol_ratio": round(vol_ratio, 2),
            "price_vs_ma5_pct": round(pct_vs_ma5, 2),
            "price_vs_ma10_pct": round(pct_vs_ma10, 2),
            "price_vs_ma20_pct": round(pct_vs_ma20, 2),
            "ma_alignment": ma_alignment,
        },
    }


def score_capital_flow(symbol: str, amount: float = 0) -> Dict:
    """维度2: 资金流向评分 (0-3)

    评分依据:
        3分: 主力+超大单净流入, f85>5‰
        2分: 主力净流入>0
        1分: 主力小幅流出或中性
        0分: 主力大幅流出, 散户接盘
    """
    data = fetch_money_flow(symbol)
    if data is None:
        return {"score": 0, "reason": "资金流向API不可用", "details": {}}

    main_force = data["main_force"]        # 主力净流入
    super_large = data["super_large"]      # 超大单
    small = data["small"]                  # 小单(散户)
    main_ratio = data["main_ratio"]        # 主力净流入占比(‰)

    # 格式化主力金额(万元)
    mf_wan = main_force / 10000

    if main_force > 0 and super_large > 0 and mf_wan > 1000:
        score = 3
        reason = f"主力大幅净流入({mf_wan:.0f}万)，超大单主导"
    elif main_force > 0:
        score = 2
        reason = f"主力净流入({mf_wan:.0f}万)，力度一般"
    elif main_force > -5000000:
        score = 1
        reason = f"主力小幅净流出({abs(mf_wan):.0f}万)，偏中性"
    elif main_force <= -5000000 and small > 0:
        score = 0
        reason = f"主力大幅流出({abs(mf_wan):.0f}万)，散户接盘"
    else:
        score = 0
        reason = f"主力大幅净流出({abs(mf_wan):.0f}万)"

    return {
        "score": score,
        "reason": reason,
        "details": {
            "main_force_net": main_force,
            "super_large_net": super_large,
            "small_net": small,
            "main_ratio_permille": main_ratio,
        },
    }


def score_technical_pattern(closes: List[float]) -> Dict:
    """维度3: 技术形态评分 (0-3)

    评分依据:
        3分: MA5>MA10>MA20 + MACD>0 + MACD_hist>0 + price>MA20
        2分: price>MA20 and (MA5>MA10 or MACD>0)
        1分: 技术面中性
        0分: 空头排列, MACD<0
    """
    if len(closes) < 60:
        return {"score": 0, "reason": "数据不足(需60日)", "details": {}}

    closes_arr = np.array(closes, dtype=float)
    price = closes_arr[-1]

    ma5 = np.mean(closes_arr[-5:])
    ma10 = np.mean(closes_arr[-10:])
    ma20 = np.mean(closes_arr[-20:])
    ma60 = np.mean(closes_arr[-60:])

    ma_bullish = ma5 > ma10 > ma20
    ma_bearish = ma5 < ma10 < ma20

    # MACD
    macd_info = compute_macd(closes_arr)
    macd_val = macd_info["latest_macd"]
    macd_hist_val = macd_info["latest_hist"]
    macd_bullish = macd_val > 0 and macd_hist_val > 0

    above_ma20 = price > ma20
    above_ma60 = price > ma60

    if ma_bullish and macd_bullish and above_ma20:
        score = 3
        reason = "多头排列+MACD金叉，技术面强势"
    elif above_ma20 and (ma5 > ma10 or macd_val > 0):
        score = 2
        reason = "站上MA20，均线或MACD偏多"
    elif above_ma20 or abs(macd_val) < 0.3:
        score = 1
        reason = "技术面中性，方向待明朗"
    else:
        score = 0
        reason = "空头排列，技术面弱势"

    return {
        "score": score,
        "reason": reason,
        "details": {
            "ma5": round(ma5, 3),
            "ma10": round(ma10, 3),
            "ma20": round(ma20, 3),
            "ma60": round(ma60, 3),
            "macd": round(macd_val, 4),
            "macd_hist": round(macd_hist_val, 4),
            "ma_bullish": ma_bullish,
            "macd_bullish": macd_bullish,
            "price_vs_ma20_pct": round((price - ma20) / ma20 * 100, 2),
        },
    }


def score_sector_resonance(symbol: str, today_pct: float = 0) -> Dict:
    """维度4: 板块共振评分 (0-3)

    评分依据:
        3分: 多个概念板块为当前热门，且个股上涨
        2分: 至少一个所属板块为热门
        1分: 所属板块表现一般
        0分: 板块数据不可用或所属板块冷门

    数据源: HotSectorAnalyzer / AKShareSource
    """
    # 1. 获取该股票所属概念板块
    concepts = []
    try:
        try:
            from swing_trader.utils.hot_sector_analyzer import HotSectorAnalyzer
        except ImportError:
            from hot_sector_analyzer import HotSectorAnalyzer
        concepts = HotSectorAnalyzer.get_stock_concepts(symbol)
    except Exception as e:
        logger.debug(f"获取 {symbol} 概念板块失败: {e}")

    if not concepts:
        # 降级: 尝试获取行业板块排名
        try:
            try:
                from swing_trader.data_sources.akshare_source import AKShareSource
            except ImportError:
                sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "data_sources"))
                from akshare_source import AKShareSource
            src = AKShareSource()
            ranking = src.get_sector_ranking(top_n=10)
            if ranking:
                return {
                    "score": 1,
                    "reason": "使用行业板块排名(粗略)",
                    "details": {"concepts": [], "ranking_top": ranking[:5]},
                }
        except Exception:
            pass
        return {"score": 0, "reason": "板块数据不可用", "details": {}}

    # 2. 获取当前热门板块
    hot_sectors = []
    try:
        try:
            from swing_trader.utils.hot_sector_analyzer import HotSectorAnalyzer
        except ImportError:
            from hot_sector_analyzer import HotSectorAnalyzer
        analyzer = HotSectorAnalyzer()
        hot_data = analyzer.compute_hot_sectors(top_n=5, min_appearances=2)
        # hot_data 是 [(板块名, 热度分), ...] 或类似结构
        hot_sectors = [h.get("name", "") if isinstance(h, dict) else str(h) for h in hot_data]
    except Exception as e:
        logger.debug(f"获取热门板块失败: {e}")

    # 3. 检查交集
    matching = [c for c in concepts if any(h in c or c in h for h in hot_sectors)]
    match_cnt = len(matching)

    if match_cnt >= 2 and today_pct >= 0:
        score = 3
        reason = f"多概念共振({', '.join(matching[:3])})，个股同步上涨"
    elif match_cnt >= 1:
        score = 2
        reason = f"所属板块({matching[0]})为当前热门"
    elif hot_sectors:
        score = 1
        reason = "所属板块不在当前热门板块中，但板块数据正常"
    else:
        score = 1
        reason = "无法判断板块热度"

    return {
        "score": score,
        "reason": reason,
        "details": {
            "concepts": concepts[:5],
            "matching_hot": matching,
            "hot_sectors_top": hot_sectors[:5],
        },
    }


def score_capital_phase(closes: List[float], volumes: List[float]) -> Dict:
    """维度5: 主力阶段评分 (0-3)

    复用 capital_flow.identify_capital_phase() 识别主力运作阶段。

    映射关系:
        再次吸引 → 3分 (最强合力信号)
        第一波启动 → 2分
        蛰伏吸筹 → 2分
        阴跌洗盘 → 1分
        方向不明/数据不足 → 0分
    """
    if len(closes) < 60:
        return {"score": 0, "reason": "数据不足(需60日)", "details": {}}

    try:
        # 兼容两种导入方式: 从项目根 或 从 utils 目录
        try:
            from swing_trader.utils.capital_flow import identify_capital_phase
        except ImportError:
            from capital_flow import identify_capital_phase
        result = identify_capital_phase(closes, volumes)
        phase = result.get("phase", "方向不明")
        desc = result.get("description", phase)

        phase_score_map = {
            "再次吸引": 3,
            "第一波启动": 2,
            "蛰伏吸筹": 2,
            "阴跌洗盘": 1,
            "方向不明": 0,
            "数据不足": 0,
        }
        score = phase_score_map.get(phase, 0)
        return {"score": score, "reason": desc, "details": result}
    except Exception as e:
        logger.debug(f"主力阶段识别失败: {e}")
        return {"score": 0, "reason": f"主力阶段分析失败: {e}", "details": {}}


# ══════════════════════════════════════════════
#  综合分析入口
# ══════════════════════════════════════════════

def analyze_convergence(
    symbol: str,
    name: str = "",
    current_price: float = 0,
    today_pct: float = 0,
    amount: float = 0,
) -> Dict:
    """对一只股票进行全面的资金合力分析

    Args:
        symbol: 6位股票代码
        name: 股票名称
        current_price: 当前价
        today_pct: 今日涨跌幅(%)
        amount: 今日成交额(元)

    Returns:
        {
            "symbol": str,
            "name": str,
            "total_score": int,        # 0-15
            "max_score": 15,
            "score_ratio": float,      # 0.0-1.0
            "evaluation": str,         # 强势合力/一般合力/分歧/无合力
            "suggestions": [str],      # 操作建议
            "dimensions": {
                "volume_price": {...},
                "capital_flow": {...},
                "technical": {...},
                "sector": {...},
                "phase": {...},
            },
        }
    """
    # 1. 获取历史K线
    df = fetch_hist_data(symbol)
    if df is not None and not df.empty:
        closes = df["close"].dropna().tolist()
        volumes = df["volume"].dropna().tolist()
    else:
        closes = []
        volumes = []

    # 2. 逐维度评分
    dims = {}

    # 维度1: 量价配合
    d1 = score_volume_price(closes, volumes, current_price)
    dims["volume_price"] = d1

    # 维度2: 资金流向
    d2 = score_capital_flow(symbol, amount)
    dims["capital_flow"] = d2

    # 维度3: 技术形态
    d3 = score_technical_pattern(closes)
    dims["technical"] = d3

    # 维度4: 板块共振
    d4 = score_sector_resonance(symbol, today_pct)
    dims["sector"] = d4

    # 维度5: 主力阶段
    d5 = score_capital_phase(closes, volumes)
    dims["phase"] = d5

    # 3. 综合评分
    total = sum(d["score"] for d in dims.values())

    # 评价标签
    if total >= 12:
        evaluation = "强势合力"
    elif total >= 8:
        evaluation = "一般合力"
    elif total >= 4:
        evaluation = "分歧"
    else:
        evaluation = "无合力"

    # 操作建议
    suggestions = _gen_suggestions(total, dims, current_price, closes)

    return {
        "symbol": symbol,
        "name": name,
        "total_score": total,
        "max_score": 15,
        "score_ratio": round(total / 15, 2),
        "evaluation": evaluation,
        "suggestions": suggestions,
        "dimensions": dims,
    }


def _gen_suggestions(
    total: int,
    dims: Dict,
    current_price: float,
    closes: List[float],
) -> List[str]:
    """根据合力评分生成操作建议"""
    suggestions = []

    if total >= 12:
        suggestions.append("多维度共振，资金高度一致，可积极关注")
    elif total >= 8:
        suggestions.append("部分维度支持，可在回调时逢低关注")
    elif total >= 4:
        suggestions.append("多空分歧较大，建议观望或轻仓试探")
    else:
        suggestions.append("资金面疲软，不建议参与")

    # 各维度专项建议
    for dim_key, dim_data in dims.items():
        score = dim_data["score"]
        reason = dim_data["reason"]

        if score == 0:
            labels = {
                "volume_price": "量价",
                "capital_flow": "资金",
                "technical": "技术",
                "sector": "板块",
                "phase": "主力",
            }
            suggestions.append(f"[{labels.get(dim_key, dim_key)}] {reason}")

    return suggestions


# ══════════════════════════════════════════════
#  报告生成
# ══════════════════════════════════════════════

DIMENSION_LABELS = {
    "volume_price": "量价配合",
    "capital_flow": "资金流向",
    "technical": "技术形态",
    "sector": "板块共振",
    "phase": "主力阶段",
}


def generate_convergence_section(conv_result: Dict) -> str:
    """生成资金合力分析的Markdown文本块

    Args:
        conv_result: analyze_convergence() 的返回值

    Returns:
        Markdown 格式的合力分析文本
    """
    lines = []
    lines.append("#### 资金合力分析")
    lines.append("")

    total = conv_result["total_score"]
    ev = conv_result["evaluation"]

    # 评分摘要
    ev_icons = {"强势合力": "[强]", "一般合力": "[中]", "分歧": "[弱]", "无合力": "[无]"}
    icon = ev_icons.get(ev, "[-]")
    lines.append(f"> **综合评分: {total}/15** {icon} {ev}")
    lines.append("")

    # 各维度明细表
    lines.append("| 维度 | 得分 | 说明 |")
    lines.append("|:---|:---:|:---|")
    dims = conv_result["dimensions"]
    for key, label in DIMENSION_LABELS.items():
        d = dims.get(key, {})
        score = d.get("score", 0)
        reason = d.get("reason", "数据不可用")
        lines.append(f"| {label} | {score}/3 | {reason} |")

    lines.append("")

    # 操作建议
    if conv_result.get("suggestions"):
        lines.append("**操作建议:**")
        for s in conv_result["suggestions"]:
            lines.append(f"- {s}")

    return "\n".join(lines)
