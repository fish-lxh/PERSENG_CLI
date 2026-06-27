"""
浪型分析模块 v2 — 融合艾略特波浪 + 箱体理论 + 道氏理论的多维度波段分析
支持批量分析：一次性登录，结果缓存
v2 改进：更智能的趋势检测（不依赖严格MA排序）、箱体突破识别、日线补充、
         浪型阶段划分（底部盘整/初升段/主升段/末升段/回调/下跌）
"""
import sys, os
sys.path.insert(0, r'C:\Swing-Trader')

import warnings
warnings.filterwarnings('ignore')

from datetime import datetime, timedelta
import numpy as np
from typing import List, Dict, Optional, Tuple

# 全局缓存
_wave_cache = {}

# ── 常量 ──
BOX_PERIOD = 20       # 箱体周期（周）
WAVE_WINDOW = 3       # 波段拐点检测窗口
MIN_WEEKS = 20        # 最小分析周数
FIB_LEVELS = [0.236, 0.382, 0.500, 0.618, 0.786, 1.000, 1.272, 1.618]


def _ensure_login():
    """确保baostock已登录（单例）"""
    import baostock as bs
    lg = bs.login()
    if lg.error_code != "0":
        raise ConnectionError(f"baostock登录失败: {lg.error_msg}")
    return bs


def get_stock_data_batch(codes: List[str], weeks: int = 60) -> Dict[str, Dict]:
    """
    批量获取个股周线+日线数据（只登录一次）
    返回: {"code": {
        "weekly": {"dates": [...], "closes": [...], ...},
        "daily": {"dates": [...], "closes": [...], ...}
    }, ...}
    """
    bs = _ensure_login()
    result = {}
    end = datetime.now().strftime("%Y-%m-%d")

    for code in codes:
        stock_code = f"sh.{code}" if code.startswith("6") else f"sz.{code}"
        start_w = (datetime.now() - timedelta(weeks=weeks)).strftime("%Y-%m-%d")

        # ── 周线 ──
        rs = bs.query_history_k_data_plus(
            stock_code, 'date,close,high,low,volume',
            frequency='w', adjustflag='2',
            start_date=start_w, end_date=end
        )

        w_dates, w_closes, w_highs, w_lows, w_volumes = [], [], [], [], []
        while rs.next():
            row = rs.get_row_data()
            if row[1] and float(row[1]) > 0:
                w_dates.append(row[0])
                w_closes.append(float(row[1]))
                w_highs.append(float(row[2]))
                w_lows.append(float(row[3]))
                vol = float(row[4]) if row[4] else 0
                w_volumes.append(vol)

        # ── 日线（最近30天，用于补充当周未完成的数据） ──
        start_d = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
        rs2 = bs.query_history_k_data_plus(
            stock_code, 'date,close,high,low,volume',
            frequency='d', adjustflag='2',
            start_date=start_d, end_date=end
        )

        d_dates, d_closes, d_highs, d_lows = [], [], [], []
        while rs2.next():
            row = rs2.get_row_data()
            if row[1] and float(row[1]) > 0:
                d_dates.append(row[0])
                d_closes.append(float(row[1]))
                d_highs.append(float(row[2]))
                d_lows.append(float(row[3]))

        result[code] = {
            "weekly": {"dates": w_dates, "closes": w_closes, "highs": w_highs, "lows": w_lows, "volumes": w_volumes},
            "daily": {"dates": d_dates, "closes": d_closes, "highs": d_highs, "lows": d_lows},
        }

    return result


# ─────────────────────────────────────────────
# 波段拐点识别
# ─────────────────────────────────────────────

def find_swing_points(closes: List[float], window: int = WAVE_WINDOW) -> List[Dict]:
    """识别波段高低点（Zigzag-like）

    返回: [{"index": i, "type": "peak"/"trough", "price": f}, ...]
    """
    if len(closes) < window * 2 + 1:
        return []

    peaks_troughs = []
    for i in range(window, len(closes) - window):
        left_vals = closes[i - window:i]
        right_vals = closes[i + 1:i + 1 + window]

        if closes[i] > max(left_vals) and closes[i] >= max(right_vals):
            peaks_troughs.append({"index": i, "type": "peak", "price": closes[i]})
        if closes[i] < min(left_vals) and closes[i] <= min(right_vals):
            peaks_troughs.append({"index": i, "type": "trough", "price": closes[i]})

    # 过滤连续同类型
    filtered = []
    for pt in peaks_troughs:
        if filtered and pt["type"] == filtered[-1]["type"]:
            if pt["type"] == "peak" and pt["price"] > filtered[-1]["price"]:
                filtered[-1] = pt
            elif pt["type"] == "trough" and pt["price"] < filtered[-1]["price"]:
                filtered[-1] = pt
        else:
            filtered.append(pt)

    return filtered


def find_recent_trend_line(swings: List[Dict]) -> Dict:
    """利用最近波段高低点判断短期趋势方向"""
    if len(swings) < 2:
        return {"direction": "不明", "strength": 0}

    recent = swings[-4:] if len(swings) >= 4 else swings
    peaks = [s for s in recent if s["type"] == "peak"]
    troughs = [s for s in recent if s["type"] == "trough"]

    # 更高的高点和更高的低点 → 上升趋势
    higher_highs = len(peaks) >= 2 and peaks[-1]["price"] > peaks[-2]["price"]
    higher_lows = len(troughs) >= 2 and troughs[-1]["price"] > troughs[-2]["price"]

    # 更低的高点和更低的低点 → 下降趋势
    lower_highs = len(peaks) >= 2 and peaks[-1]["price"] < peaks[-2]["price"]
    lower_lows = len(troughs) >= 2 and troughs[-1]["price"] < troughs[-2]["price"]

    if higher_highs and higher_lows:
        return {"direction": "上升", "strength": 2}
    elif higher_highs or higher_lows:
        return {"direction": "上升", "strength": 1}
    elif lower_highs and lower_lows:
        return {"direction": "下降", "strength": 2}
    elif lower_highs or lower_lows:
        return {"direction": "下降", "strength": 1}
    else:
        return {"direction": "盘整", "strength": 0}


# ─────────────────────────────────────────────
# 箱体分析
# ─────────────────────────────────────────────

def analyze_box(closes: List[float]) -> Dict:
    """箱体理论分析

    返回: {
        "high": f, "low": f, "mid": f, "width_pct": f,
        "position": 0-1 (price position in box),
        "breakout": "up"/"down"/"inside"/"bound",
        "breakout_pct": f,  # 突破幅度
    }
    """
    if len(closes) < BOX_PERIOD:
        return {"high": 0, "low": 0, "mid": 0, "position": 0.5,
                "width_pct": 0, "breakout": "inside", "breakout_pct": 0}

    box_high = max(closes[-BOX_PERIOD:])
    box_low = min(closes[-BOX_PERIOD:])
    box_mid = (box_high + box_low) / 2
    price = closes[-1]
    width_pct = (box_high - box_low) / box_low * 100 if box_low > 0 else 0
    position = (price - box_low) / (box_high - box_low) if box_high > box_low else 0.5

    # 突破判定（使用价格穿透 + 持续确认）
    above_pct = (price - box_high) / box_high * 100 if box_high > 0 else 0
    below_pct = (price - box_low) / box_low * 100 if box_low > 0 else 0

    if above_pct > 3:
        breakout = "up"
    elif below_pct < -3:
        breakout = "down"
    elif price >= box_high * 0.97:
        breakout = "bound_up"
    elif price <= box_low * 1.03:
        breakout = "bound_down"
    else:
        breakout = "inside"

    return {
        "high": box_high,
        "low": box_low,
        "mid": box_mid,
        "width_pct": width_pct,
        "position": position,
        "breakout": breakout,
        "breakout_pct": above_pct if breakout in ("up", "bound_up") else below_pct,
    }


# ─────────────────────────────────────────────
# 2B法则：假突破检测
# ─────────────────────────────────────────────

def check_2b_false_breakout(closes: List[float], window: int = 2) -> Optional[Dict]:
    """
    2B法则检测 — 价格突破前高/前低后迅速回撤（假突破）

    返回示例:
        {"type": "bearish_2b", "desc": "突破前高39.14后迅速回落至38.50，疑似假突破"}
        {"type": "bullish_2b",  "desc": "跌破前低26.92后迅速反弹至27.50，疑似假突破"}
        None  (未检测到2B信号)
    """
    if len(closes) < window * 3:
        return None

    recent = closes[-(window * 3):]
    mid = len(recent) // 2

    left_section = recent[:mid]
    right_section = recent[mid:]

    if len(left_section) < 2 or len(right_section) < 2:
        return None

    left_high = max(left_section)
    left_low = min(left_section)
    right_high = max(right_section)
    right_low = min(right_section)
    current = recent[-1]
    recent_max = max(right_section[:-1]) if len(right_section) > 1 else right_section[0]
    recent_min = min(right_section[:-1]) if len(right_section) > 1 else right_section[0]

    # 看跌2B：突破前高后迅速回落
    if right_high > left_high:  # 创出新高
        # 检查是否迅速回到前高下方
        if current < left_high:
            retrace_pct = (right_high - current) / right_high * 100
            if retrace_pct > 2:  # 从新高回落>2%
                return {
                    "type": "bearish_2b",
                    "desc": f"突破前高{left_high:.2f}至{right_high:.2f}后回落到{current:.2f}，疑似假突破",
                    "confidence": "高" if retrace_pct > 5 else "中",
                }

    # 看涨2B：跌破前低后迅速反弹
    if right_low < left_low:  # 创出新低
        if current > left_low:
            bounce_pct = (current - right_low) / right_low * 100
            if bounce_pct > 2:  # 从新低反弹>2%
                return {
                    "type": "bullish_2b",
                    "desc": f"跌破前低{left_low:.2f}至{right_low:.2f}后反弹到{current:.2f}，疑似假突破",
                    "confidence": "高" if bounce_pct > 5 else "中",
                }

    return None


# ─────────────────────────────────────────────
# 量价背离检测
# ─────────────────────────────────────────────

def check_volume_divergence(closes: List[float], volumes: List[float], window: int = 5) -> Optional[Dict]:
    """
    检测量价背离：
    - 顶背离：价格上升但成交量萎缩 → 上涨动能减弱
    - 底背离：价格下降但成交量放大 → 下跌动能衰竭（吸筹）
    - 量价齐升：价格上升且成交量放大 → 健康上涨
    """
    if len(closes) < window * 2 or len(volumes) < window * 2:
        return None

    # 比较近期两段的价格和量能趋势
    recent_price = closes[-window:]
    recent_vol = volumes[-window:]
    prev_price = closes[-(window*2):-window]
    prev_vol = volumes[-(window*2):-window]

    price_up = np.mean(recent_price) > np.mean(prev_price)
    price_down = np.mean(recent_price) < np.mean(prev_price)
    vol_up = np.mean(recent_vol) > np.mean(prev_vol) * 1.1   # 量增10%+
    vol_down = np.mean(recent_vol) < np.mean(prev_vol) * 0.9  # 量缩10%+

    # 最后一周的单独量能
    last_vol = volumes[-1] if len(volumes) >= 1 else 0
    avg_vol = np.mean(volumes[-10:]) if len(volumes) >= 10 else np.mean(volumes)
    vol_surge = last_vol > avg_vol * 1.5

    if price_up and vol_down:
        return {
            "type": "顶背离",
            "desc": "价格上涨但量能萎缩，上涨动能减弱",
            "severity": "警告",
        }
    elif price_up and vol_up:
        return {
            "type": "量价齐升",
            "desc": "量价配合良好，趋势健康",
            "severity": "正面",
        }
    elif price_down and vol_up:
        return {
            "type": "底背离",
            "desc": "价格下跌但成交量放大，可能为吸筹/下跌末端",
            "severity": "关注",
        }
    elif vol_surge and not price_up:
        return {
            "type": "放量滞涨",
            "desc": "成交量异常放大但价格未涨，警惕出货",
            "severity": "警告",
        }

    return None


# ─────────────────────────────────────────────
# 核心：浪型分析（改进版）
# ─────────────────────────────────────────────

def analyze_wave(closes: List[float], daily_closes: Optional[List[float]] = None, volumes: Optional[List[float]] = None) -> Dict:
    """对周线数据进行波浪分析（v2 改进版）

    参数:
        closes: 周线收盘价序列
        daily_closes: 日线收盘价序列（可选，用于当周未完成数据的补充）

    返回:
        Dict with wave_label, position, description, key_levels, ...
    """
    if len(closes) < MIN_WEEKS:
        return {
            "wave_label": "数据不足",
            "position": "无法判断",
            "description": f"周线数据不足{MIN_WEEKS}周",
            "key_levels": {},
            "ma5": "N/A",
            "ma10": "N/A",
            "weekly_trend": "",
        }

    # ════════════════════════════════════════════
    # 1. 基础指标
    # ════════════════════════════════════════════
    price = closes[-1]

    ma5 = float(np.mean(closes[-5:]))
    ma10 = float(np.mean(closes[-10:]) if len(closes) >= 10 else np.mean(closes[-5:]))
    ma20 = float(np.mean(closes[-20:]))
    ma48 = float(np.mean(closes[-48:])) if len(closes) >= 48 else ma20

    # 周线MA乖离
    dist_ma5 = (price - ma5) / ma5 * 100
    dist_ma20 = (price - ma20) / ma20 * 100
    dist_ma48 = (price - ma48) / ma48 * 100 if len(closes) >= 48 else 0

    # 近N周涨幅
    pct_5w = (price - closes[-5]) / closes[-5] * 100 if len(closes) >= 5 else 0
    pct_10w = (price - closes[-10]) / closes[-10] * 100 if len(closes) >= 10 else 0
    pct_20w = (price - closes[-20]) / closes[-20] * 100 if len(closes) >= 20 else 0

    # MA排序状态
    ma_sorted_bull = ma5 > ma10 > ma20
    ma_sorted_bear = ma5 < ma10 < ma20
    ma_cross_bull = ma5 > ma20  # 金叉状态
    ma_cross_bear = ma5 < ma20  # 死叉状态

    # ════════════════════════════════════════════
    # 2. 箱体分析
    # ════════════════════════════════════════════
    box = analyze_box(closes)

    # ════════════════════════════════════════════
    # 3. 波段拐点 & 趋势
    # ════════════════════════════════════════════
    swings = find_swing_points(closes, window=WAVE_WINDOW)
    peaks = [p for p in swings if p["type"] == "peak"]
    troughs = [t for t in swings if t["type"] == "trough"]
    trend_info = find_recent_trend_line(swings)

    # ════════════════════════════════════════════
    # 4. 日线补充（当周未完成的数据）
    # ════════════════════════════════════════════
    current_weekly_return = 0.0
    has_intraweek_data = False
    if daily_closes and len(daily_closes) >= 2:
        # 本周涨幅 = (最新日线收盘 - 上周周线收盘) / 上周周线收盘
        # 先在日线数据中找到与上周周线收盘最接近的日期
        last_weekly_price = closes[-1]  # 周线最后一条 = 上周收盘
        if last_weekly_price > 0:
            current_weekly_return = (daily_closes[-1] - last_weekly_price) / last_weekly_price * 100
            has_intraweek_data = True

    # ════════════════════════════════════════════
    # 5. 波动率 & 动量
    # ════════════════════════════════════════════
    weekly_volatility = np.std(closes[-10:]) / np.mean(closes[-10:]) * 100 if len(closes) >= 10 else 0

    # ════════════════════════════════════════════
    # 6. 浪型分类（决策树）
    # ════════════════════════════════════════════

    result = {
        "wave_label": "盘整/震荡",
        "position": "方向不明",
        "description": "",
        "key_levels": {},
        "ma5": f"{ma5:.2f}",
        "ma10": f"{ma10:.2f}",
        "weekly_trend": f"近5周{'涨' if pct_5w >= 0 else '跌'}{abs(pct_5w):.1f}%",
    }

    desc_parts = []
    levels = {}

    # ── 决策树 ──
    # 条件A：大跌/持续下跌
    is_downtrend = (pct_5w < -8 and pct_10w < -5) or (ma_sorted_bear and pct_5w < -5)

    # 条件B：主升浪（强趋势，高动量）
    is_strong_uptrend = (ma_sorted_bull or (ma_cross_bull and pct_5w > 10)) and pct_5w > 15

    # 条件C：初升段（刚突破箱体或底部反转）
    is_early_uptrend = (
        (box["breakout"] in ("up", "bound_up") and pct_5w > 5) or
        (ma_cross_bull and pct_5w > 5 and box["position"] > 0.6) or
        (pct_5w > 8 and pct_10w > 0 and trend_info["direction"] == "上升")
    )

    # 条件D：回调（短期跌但中期仍涨）
    is_pullback = pct_5w < 0 < pct_10w

    # 条件E：箱体内部盘整
    is_consolidation = box["breakout"] == "inside" and abs(pct_5w) < 10

    # 条件F：突破回踩（箱体突破后回踩上沿）
    is_retest = (box["breakout"] == "bound_up" and pct_5w < 5 and pct_5w > -5)

    # ── 标签赋值 ──
    if is_downtrend:
        # ── 下跌趋势 ──
        result["wave_label"] = "下跌趋势"
        if pct_5w < -15:
            result["position"] = "加速下跌"
        elif pct_5w < -5:
            result["position"] = "持续走弱"
        else:
            result["position"] = "弱势盘整"
        desc_parts.append(f"近5周跌幅{abs(pct_5w):.1f}%")

        # 支撑位
        if troughs:
            levels["关键支撑"] = f"{troughs[-1]['price']:.2f}"
        if box["breakout"] == "down":
            # 跌破箱体
            levels["箱体下沿(阻力)"] = f"{box['high']:.2f}"
            desc_parts.append(f"跌破箱体{abs(box['breakout_pct']):.1f}%")
        elif box["low"] > 0:
            levels["箱体下沿"] = f"{box['low']:.2f}"

    elif is_strong_uptrend:
        # ── 主升段（类似波浪理论的第3浪） ──
        result["wave_label"] = "上升浪(主升段)"
        result["position"] = "强势上攻"
        desc_parts.append(f"近5周涨幅+{pct_5w:.1f}%")

        # 判断是否已进入浪5末端
        if pct_5w > 30 or (dist_ma48 > 50 and pct_5w > 20):
            result["position"] = "加速冲顶"
            desc_parts.append("加速冲顶阶段，警惕浪5末端")

        # 波段支撑
        if troughs:
            last_trough = troughs[-1]["price"]
            swing_dist = (price - last_trough) / last_trough * 100
            levels["波段支撑"] = f"{last_trough:.2f}"
            if swing_dist > 30:
                desc_parts.append(f"距最近波谷已涨{swing_dist:.0f}%")

        # 箱体突破提示
        if box["breakout"] == "up":
            desc_parts.append(f"突破箱体+{box['breakout_pct']:.1f}%")
            levels["箱体上沿(支撑)"] = f"{box['high']:.2f}"

    elif is_early_uptrend:
        # ── 初升段（类似波浪理论第1浪或底部反转） ──
        if box["breakout"] in ("up", "bound_up") and box["breakout_pct"] > 3:
            result["wave_label"] = "箱体突破(初升段)"
            result["position"] = "突破上行"
            desc_parts.append(f"放量突破箱体+{box['breakout_pct']:.1f}%")
            if box["width_pct"] > 20:
                desc_parts.append(f"箱体宽度{box['width_pct']:.0f}%，突破有效性强")
            levels["箱体上沿(支撑)"] = f"{box['high']:.2f}"
        elif pct_5w > 8 and pct_10w > 0:
            result["wave_label"] = "上升趋势(初升段)"
            result["position"] = "底部回升"
            desc_parts.append(f"近5周涨幅+{pct_5w:.1f}%")
        else:
            result["wave_label"] = "上升趋势"
            result["position"] = "缓步上行"
            desc_parts.append(f"近5周涨幅+{pct_5w:.1f}%")

        if troughs:
            levels["波段支撑"] = f"{troughs[-1]['price']:.2f}"

    elif is_pullback:
        # ── 回调浪（类似波浪理论第2浪或第4浪） ──
        result["wave_label"] = "回调浪"
        result["position"] = "短期回调"
        desc_parts.append(f"近5周回调{abs(pct_5w):.1f}%")

        # 计算回撤比例
        if peaks and troughs:
            last_peak = peaks[-1]["price"]
            last_trough = max([t["price"] for t in troughs if t["price"] < last_peak]) if troughs else 0
            if last_trough > 0:
                retrace = (last_peak - price) / (last_peak - last_trough) * 100
                desc_parts.append(f"回撤约{retrace:.0f}%")
                # 判断回调性质
                if 30 <= retrace <= 50:
                    desc_parts.append("正常回调（0.382-0.5）")
                elif 50 < retrace <= 70:
                    desc_parts.append("较深回调（0.5-0.618），关注支撑")
                elif retrace > 70:
                    desc_parts.append("深度回调，警惕趋势转变")
        if troughs:
            levels["回调支撑"] = f"{troughs[-1]['price']:.2f}"

    elif is_retest:
        # ── 突破回踩 ──
        result["wave_label"] = "突破回踩"
        result["position"] = "回踩确认中"
        desc_parts.append(f"近5周涨幅+{pct_5w:.1f}%")
        if box["high"] > 0:
            levels["箱体上沿(回踩支撑)"] = f"{box['high']:.2f}"
        desc_parts.append("突破箱体后回踩确认，观察能否站稳")

    elif is_consolidation:
        # ── 盘整/震荡 ──
        result["wave_label"] = "盘整/震荡"
        result["position"] = "方向不明"
        desc_parts.append(f"近5周涨幅+{pct_5w:.1f}%")

        # 判断在箱体中的位置
        if box["position"] >= 0.7:
            result["position"] = "箱体上沿"
            desc_parts.append("运行至箱体上沿附近")
        elif box["position"] <= 0.3:
            result["position"] = "箱体下沿"
            desc_parts.append("运行至箱体下沿附近，关注支撑")
        else:
            result["position"] = "箱体中部"

        if box["high"] > 0:
            levels["箱体上沿"] = f"{box['high']:.2f}"
            levels["箱体下沿"] = f"{box['low']:.2f}"

        # 底部盘整判断
        if box["position"] <= 0.3 and trend_info["direction"] != "下降":
            desc_parts.append("底部盘整中，等待方向选择")

    else:
        # ── 兜底：盘整 ──
        result["wave_label"] = "盘整/震荡"
        result["position"] = "方向不明"
        desc_parts.append(f"近5周涨幅+{pct_5w:.1f}%")
        if box["high"] > 0:
            levels["箱体上沿"] = f"{box['high']:.2f}"
            levels["箱体下沿"] = f"{box['low']:.2f}"

    # ════════════════════════════════════════════
    # 7. 年线（48周均线）偏离
    # ════════════════════════════════════════════
    if len(closes) >= 48 and abs(dist_ma48) > 10:
        desc_parts.append(f"距周线年线{'上' if dist_ma48 > 0 else '下'}+{abs(dist_ma48):.1f}%")

    # ════════════════════════════════════════════
    # 8. 当周日线补充信息
    # ════════════════════════════════════════════
    if has_intraweek_data and abs(current_weekly_return) > 5:
        if current_weekly_return > 0:
            desc_parts.append(f"本周至今+{current_weekly_return:.1f}%（日线）")
        else:
            desc_parts.append(f"本周至今{current_weekly_return:.1f}%（日线）")

    # ════════════════════════════════════════════
    # 9. 2B法则：假突破检测
    # ════════════════════════════════════════════
    if len(closes) >= 10:
        two_b = check_2b_false_breakout(closes)
        if two_b:
            if two_b["type"] == "bearish_2b" and two_b["confidence"] in ("高", "中"):
                desc_parts.append(f"⚠️2B假突破: {two_b['desc']}")
            elif two_b["type"] == "bullish_2b" and two_b["confidence"] in ("高", "中"):
                desc_parts.append(f"✅2B假跌破: {two_b['desc']}")

    # ════════════════════════════════════════════
    # 10. 量价关系检测
    # ════════════════════════════════════════════
    if volumes and len(volumes) >= 10:
        vol_div = check_volume_divergence(closes, volumes)
        if vol_div and vol_div["severity"] == "警告":
            desc_parts.append(f"⚠️{vol_div['desc']}")
        elif vol_div and vol_div["severity"] == "正面":
            desc_parts.append(f"✅{vol_div['desc']}")

    # ════════════════════════════════════════════
    # 11. 斐波那契参考位
    # ════════════════════════════════════════════
    if len(troughs) >= 1 and len(peaks) >= 1:
        last_trough = troughs[-1]["price"]
        last_peak = peaks[-1]["price"]
        range_ = last_peak - last_trough

        if range_ > 0:
            fib_support = last_peak - range_ * 0.618
            levels["斐波那契支撑"] = f"{fib_support:.2f}"

            # 如果当前价格在高位，也给一个扩展目标
            if price > last_peak * 0.95:
                fib_ext = last_trough + range_ * 1.272
                levels["斐波那契目标"] = f"{fib_ext:.2f}"

    # ════════════════════════════════════════════
    # 10. 打包结果
    # ════════════════════════════════════════════
    result["description"] = " | ".join(desc_parts) if desc_parts else "走势不明朗"
    result["key_levels"] = levels

    return result


# ─────────────────────────────────────────────
# 评分与集成接口
# ─────────────────────────────────────────────

def get_wave_score(wave_label: str, position: str) -> int:
    """
    将浪型标签转换为评分（用于选股评分体系）

    返回: -1 ~ +2 的整数评分
        +2 = 强烈做多（主升段、箱体突破）
        +1 = 偏多（初升段、上升趋势、突破回踩）
         0 = 中性（盘整/震荡）
        -1 = 偏空（回调浪、底部盘整中方向不明）
        -2 = 强烈做空（下跌趋势、加速冲顶有风险）
    """
    label = wave_label or ""

    # 主升段（波浪理论第3浪）— 最强做多信号
    if "主升段" in label:
        # 但如果在加速冲顶阶段，有浪5风险
        if "加速冲顶" in position:
            return 0  # 中性偏谨慎
        return 2

    # 箱体突破（初升段）— 经典突破信号
    if "箱体突破" in label:
        return 2

    # 初升段/上升趋势
    if "初升段" in label:
        return 1
    if label == "上升趋势":
        return 1

    # 突破回踩 — 等待确认
    if "突破回踩" in label:
        return 1

    # 回调浪 — 回调中，不急于介入
    if "回调浪" in label:
        return -1

    # 下跌趋势 — 规避
    if "下跌趋势" in label:
        return -2

    # 盘整
    if "盘整" in label:
        # 箱体上沿附近 → 有可能突破
        if "箱体上沿" in position:
            return 1
        # 箱体下沿附近 → 有可能破位
        if "箱体下沿" in position:
            return -1
        return 0

    return 0


def get_wave_rating_text(score: int) -> str:
    """将浪型评分转为文字说明"""
    rating_map = {
        2: "强势做多区间（主升段/箱体突破）",
        1: "偏多区间（初升段/上升趋势）",
        0: "中性区间（盘整/震荡）",
        -1: "偏空区间（回调/箱体下沿）",
        -2: "规避区间（下跌趋势）",
    }
    return rating_map.get(score, "未知")


# ─────────────────────────────────────────────
# 批量分析（含缓存）
# ─────────────────────────────────────────────

def batch_analyze(codes: List[str]) -> Dict[str, Dict]:
    """批量分析多只股票的浪型（只登录一次，带缓存）"""
    global _wave_cache

    need_fetch = [c for c in codes if c not in _wave_cache]
    if need_fetch:
        data = get_stock_data_batch(need_fetch)
        for code, d in data.items():
            w_closes = d.get("weekly", {}).get("closes", [])
            d_closes = d.get("daily", {}).get("closes", [])
            w_volumes = d.get("weekly", {}).get("volumes", [])
            _wave_cache[code] = analyze_wave(w_closes, daily_closes=d_closes, volumes=w_volumes)

    return {c: _wave_cache.get(c, {}) for c in codes}


def get_wave_analysis_for_review(code: str) -> Dict:
    """供复盘调用的封装函数（单只股票，走缓存）"""
    result = batch_analyze([code])
    return result.get(code, {
        "wave_label": "分析失败",
        "position": "错误",
        "description": "数据获取失败",
        "key_levels": {},
        "ma5": "N/A",
        "ma10": "N/A",
        "weekly_trend": "",
    })


def clear_cache():
    """清理缓存（每天只需调用一次）"""
    global _wave_cache
    _wave_cache = {}


# ========== 测试入口 ==========
if __name__ == "__main__":
    test_stocks = [
        ("300161", "华中数控"),
        ("002081", "金螳螂"),
        ("600110", "诺德股份"),
        ("600719", "大连热电"),
        ("600936", "北投科技"),
        ("600208", "衢州发展"),
    ]

    print("=" * 60)
    print("     个股浪型分析报告 v2")
    print("=" * 60)
    print()

    clear_cache()
    codes = [s[0] for s in test_stocks]
    results = batch_analyze(codes)

    for code, name in test_stocks:
        r = results.get(code, {})
        print(f"【{name}（{code}）】")
        print(f"  浪型: {r.get('wave_label', 'N/A')}")
        print(f"  位置: {r.get('position', 'N/A')}")
        print(f"  描述: {r.get('description', 'N/A')}")
        print(f"  周MA5: {r.get('ma5', 'N/A')}  周MA10: {r.get('ma10', 'N/A')}")
        print(f"  趋势: {r.get('weekly_trend', 'N/A')}")
        levels = r.get("key_levels", {})
        if levels:
            for k, v in levels.items():
                print(f"  {k}: {v}")
        print()
