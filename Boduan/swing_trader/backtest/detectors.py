"""
纯检测函数（核心）
==================
从 PatternScanner 中提取的检测逻辑，改为接收数据数组而非内部获取数据。

每个 detect_pattern_x 函数接收完整的股价序列，但只使用最后N天的数据。
这样回测引擎可以精确控制每个检测点的数据范围（无未来信息）。

所有函数签名一致:
    def detect_pattern_x(closes, volumes, highs, lows, opens) -> Optional[Dict]
"""
import logging
from typing import Optional, List, Dict
import numpy as np

from ..utils.config import CONFIG
from ..utils.indicators import get_ma_value, calc_weekly_resonance
from ..core.confidence import score_match

logger = logging.getLogger(__name__)


def _calc_detector_resonance(closes: list, volumes: list = None) -> dict:
    """
    为检测函数计算周线共振评分（从日线数组降采样）。

    所有 detect_pattern_x 函数共享此方法，避免重复代码。
    返回: {"resonance_score": int, "weekly_l1_score": int, ...}
    """
    closes_arr = np.array(closes, dtype=float)
    if len(closes_arr) < 320:
        return {"resonance_score": 0, "weekly_l1_score": 0,
                "resonance_level": "极弱", "factors": {}, "details": {}}

    # 降采样日线为周线（与现有检测器一致的降采样逻辑）
    weekly_step = 5
    n_weeks = len(closes_arr) // weekly_step
    weekly_closes = closes_arr[-n_weeks * weekly_step::weekly_step]
    weekly_volumes = None
    if volumes is not None and len(volumes) >= 320:
        vols_arr = np.array(volumes, dtype=float)
        weekly_volumes = vols_arr[-n_weeks * weekly_step::weekly_step]

    return calc_weekly_resonance(
        weekly_closes=weekly_closes,
        weekly_volumes=weekly_volumes,
    )


# ──────────────────────────────────────────────
# 形态A: 首板250
# ──────────────────────────────────────────────

def detect_pattern_a(
    closes: List[float],
    volumes: List[float],
    highs: List[float] = None,
    lows: List[float] = None,
    opens: List[float] = None,
    pct_chg: List[float] = None,
) -> Optional[Dict]:
    """
    检测形态A: 首板250 — 纯函数版本

    条件:
      1. 当天涨停（涨幅 ≥ 9.9%）
      2. 涨停阳线实体穿越250日均线（开盘<250线<收盘）
      3. 量比 > 1
    """
    if closes is None or volumes is None or opens is None:
        return None
    if len(closes) < 260 or len(volumes) < 260 or len(opens) < 260:
        return None

    cfg = CONFIG.pattern
    closes_arr = np.array(closes, dtype=float)
    volumes_arr = np.array(volumes, dtype=float)
    opens_arr = np.array(opens, dtype=float)

    latest_close = float(closes_arr[-1])
    latest_open = float(opens_arr[-1])
    if latest_close <= 0 or latest_open <= 0:
        return None

    # 必须是阳线（涨停必然是阳线）
    if latest_close <= latest_open:
        return None

    # 计算250年线
    if len(closes_arr) < 250:
        return None
    ma250 = np.convolve(closes_arr, np.ones(250) / 250, mode='valid')
    ma250_padded = np.full_like(closes_arr, np.nan)
    ma250_padded[249:] = ma250
    latest_ma250 = float(ma250_padded[-1])
    if np.isnan(latest_ma250) or latest_ma250 <= 0:
        return None

    # 条件1: 当天涨停（涨幅 ≥ 9.9%）
    pct = float(pct_chg[-1]) if pct_chg and len(pct_chg) > 0 else 0
    if pct < cfg.pattern_a_pct_threshold:
        return None

    # 条件2: 涨停阳线实体穿越250日均线
    body_bottom = min(latest_open, latest_close)
    body_top = max(latest_open, latest_close)
    if not (body_bottom < latest_ma250 < body_top):
        return None

    # 条件3: 量比 > 1
    if len(volumes_arr) >= 21:
        avg_vol = float(np.mean(volumes_arr[-21:-1]))
    else:
        avg_vol = float(np.mean(volumes_arr[:-1])) if len(volumes_arr) > 1 else 0
    if avg_vol <= 0:
        return None
    latest_vol = float(volumes_arr[-1])
    vol_ratio = latest_vol / avg_vol
    required_vol = max(1.0, cfg.pattern_a_vol_ratio)
    if vol_ratio < required_vol:
        return None

    # 辅助: 周线MA5 > MA10（中期趋势向上）
    if len(closes_arr) >= 320:
        weekly_step = 5
        n_weeks = len(closes_arr) // weekly_step
        weekly_closes = closes_arr[-n_weeks * weekly_step::weekly_step]
        if len(weekly_closes) >= 10:
            w_ma5 = float(np.mean(weekly_closes[-5:]))
            w_ma10 = float(np.mean(weekly_closes[-10:]))
            if w_ma5 <= w_ma10:
                return None

    # 计算250线在实体中的位置比例
    body_height = body_top - body_bottom
    ma250_pos = (latest_ma250 - body_bottom) / body_height if body_height > 0 else 0.5

    # 判断置信度
    perfect_cross = 0.3 <= ma250_pos <= 0.7
    strong_volume = vol_ratio >= 2.0

    if perfect_cross and strong_volume:
        confidence = "高"
    elif perfect_cross or strong_volume:
        confidence = "中"
    else:
        confidence = "低"

    # 统一置信度评分
    _resonance = _calc_detector_resonance(closes, volumes)
    _result = score_match("A", {
        "ma250_pos_in_body": ma250_pos, "vol_ratio": vol_ratio, "latest_pct": pct,
        "days_since_cross": 1,
        "above_ma144": True, "ma144_price": 0, "ma250_price": round(latest_ma250, 2),
        "latest_close": latest_close,
        "weekly_resonance_score": _resonance.get("resonance_score", 0),
    })
    return {
        "pattern_type": "A",
        "confidence": _result["level"],
        "confidence_score": _result["score"],
        "price": latest_close,
        "pct": pct,
        "vol_ratio": round(vol_ratio, 2),
        "ma250": round(latest_ma250, 2),
        "ma144": round(get_ma_value(closes_arr, 144) or 0, 2),
        "description": (f"首板250(涨幅{pct:.1f}%，量比{vol_ratio:.1f}，"
                        f"250线在实体{ma250_pos*100:.0f}%位置)"),
    }


# ──────────────────────────────────────────────
# 形态B: 上影线试盘
# ──────────────────────────────────────────────

def detect_pattern_b(
    closes: List[float],
    volumes: List[float],
    highs: List[float] = None,
    lows: List[float] = None,
    opens: List[float] = None,
    pct_chg: List[float] = None,
) -> Optional[Dict]:
    """
    检测形态B: 上影线试盘突破 — 纯函数版本

    逻辑:
      周线级别多头排列（周MA5 > MA10 > MA20）确认中期趋势向上
      +
      日线级别上影线试盘信号（上涨+上影线+平台突破+放量）

    日线条件:
      1. 当日涨幅 >= 3.8%
      2. 上影线明显（上影线/总振幅 >= 30%）
      3. 突破平台（今日最高 > 过去55日最高）
      4. 放量（量比 > 2）
    """
    if closes is None or volumes is None or highs is None or lows is None or opens is None:
        return None

    cfg = CONFIG.pattern
    need_days = cfg.pattern_b_platform_days + 5
    if len(closes) < need_days or len(highs) < need_days:
        return None

    closes_arr = np.array(closes, dtype=float)
    volumes_arr = np.array(volumes, dtype=float)
    highs_arr = np.array(highs, dtype=float)
    lows_arr = np.array(lows, dtype=float)
    opens_arr = np.array(opens, dtype=float)

    # 条件1: 当日涨幅 >= 3.8%
    pct = float(pct_chg[-1]) if pct_chg and len(pct_chg) > 0 else 0
    if pct < cfg.pattern_b_pct_threshold:
        return None

    open_p = float(opens_arr[-1])
    close_p = float(closes_arr[-1])
    high_p = float(highs_arr[-1])
    low_p = float(lows_arr[-1])

    total_range = high_p - low_p
    if total_range <= 0:
        return None

    # 条件2: 上影线明显
    if close_p >= open_p:  # 阳线
        upper_shadow = high_p - close_p
    else:  # 阴线
        upper_shadow = high_p - open_p

    shadow_ratio = upper_shadow / total_range
    if shadow_ratio < cfg.pattern_b_upper_shadow_ratio:
        return None

    # 条件3: 突破平台（今日最高 > 过去20日最高）
    prev_highs = highs_arr[-cfg.pattern_b_platform_days:-1]
    if len(prev_highs) == 0:
        return None
    platform_high = float(np.max(prev_highs))
    if high_p <= platform_high:
        return None

    # 条件4: 放量（量比 > 2）
    volume = float(volumes_arr[-1])
    if volume <= 0:
        return None
    prev_volumes = volumes_arr[-cfg.pattern_b_platform_days:-1]
    if len(prev_volumes) == 0:
        return None
    avg_volume = float(np.mean(prev_volumes))
    vol_ratio = volume / avg_volume if avg_volume > 0 else 0
    if vol_ratio < cfg.pattern_b_vol_ratio:
        return None

    # 条件5: 周均线多头排列（周MA5 > MA10 > MA20）
    # 将日线降采样为周线（每5个交易日取一个收盘价，约65周数据）
    if len(closes_arr) >= 320:
        weekly_step = 5
        n_weeks = len(closes_arr) // weekly_step
        weekly_closes = closes_arr[-n_weeks * weekly_step::weekly_step]
        if len(weekly_closes) >= 20:
            w_ma5 = float(np.mean(weekly_closes[-5:]))
            w_ma10 = float(np.mean(weekly_closes[-10:]))
            w_ma20 = float(np.mean(weekly_closes[-20:]))
            if not (w_ma5 > w_ma10 > w_ma20):
                return None

    # 判断置信度
    if pct >= 7 and shadow_ratio >= 0.4 and vol_ratio >= 3:
        confidence = "高"
        desc_suffix = "强势试盘突破"
    else:
        confidence = "中"
        desc_suffix = "试盘突破"

    # 统一置信度评分
    _resonance = _calc_detector_resonance(closes, volumes)
    _result = score_match("B", {
        "latest_pct": pct, "shadow_ratio": shadow_ratio, "vol_ratio": vol_ratio,
        "above_ma144": True,
        "weekly_resonance_score": _resonance.get("resonance_score", 0),
    })
    return {
        "pattern_type": "B",
        "confidence": _result["level"],
        "confidence_score": _result["score"],
        "description": f"上影线{desc_suffix}(涨幅{pct:.1f}%，上影线占比{shadow_ratio:.0%}，量比{vol_ratio:.1f})",
        "latest_close": close_p,
        "latest_pct": pct,
        "above_250ma": True,
        "vol_ratio": vol_ratio,
        "ma144": round(get_ma_value(closes_arr, 144) or 0, 2),
    }


# ──────────────────────────────────────────────
# 形态C: 小阳线爬升
# ──────────────────────────────────────────────

def detect_pattern_c(
    closes: List[float],
    volumes: List[float],
    highs: List[float] = None,
    lows: List[float] = None,
    opens: List[float] = None,
    pct_chg: List[float] = None,
) -> Optional[Dict]:
    """
    检测形态C: 连续小阳线上涨9天 + 年线上方 — 纯函数版本
    """
    if closes is None or volumes is None:
        return None

    cfg = CONFIG.pattern
    need_days = cfg.pattern_c_days + 5
    if len(closes) < need_days or len(volumes) < need_days:
        return None

    closes_arr = np.array(closes, dtype=float)
    volumes_arr = np.array(volumes, dtype=float)

    # 从后往前统计连续小阳天数
    consecutive_up = 0
    for i in range(len(closes_arr) - 1, -1, -1):
        pct = float(pct_chg[i]) if pct_chg and i < len(pct_chg) else 0
        if cfg.pattern_c_min_daily_pct <= pct <= cfg.pattern_c_max_daily_pct:
            consecutive_up += 1
        else:
            break

    if consecutive_up < cfg.pattern_c_days:
        return None

    # 条件2: 成交量小幅放大
    volumes_tail = volumes_arr[-cfg.pattern_c_days:]
    if len(volumes_tail) >= 3:
        last_3_avg = float(np.mean(volumes_tail[-3:]))
        prev_avg = float(np.mean(volumes_tail[:-3])) if len(volumes_tail) > 3 else last_3_avg
        vol_ratio = last_3_avg / prev_avg if prev_avg > 0 else 1.0
    else:
        vol_ratio = 1.0

    # 条件3: 年线上方
    latest_close = float(closes_arr[-1])
    if latest_close <= 0:
        return None

    if len(closes_arr) < 250:
        return None
    ma250 = np.convolve(closes_arr, np.ones(250) / 250, mode='valid')
    ma250_padded = np.full_like(closes_arr, np.nan)
    ma250_padded[249:] = ma250
    latest_ma250 = float(ma250_padded[-1])
    if np.isnan(latest_ma250) or latest_ma250 <= 0:
        return None
    if latest_close <= latest_ma250:
        return None

    # 判断置信度
    if vol_ratio >= 1.3:
        confidence = "高"
        desc = f"连涨{consecutive_up}天，温和放量(量比{vol_ratio:.1f})"
    else:
        confidence = "中"
        desc = f"连涨{consecutive_up}天，量能平稳"

    # 统一置信度评分
    _total_pct = 0.0
    if len(closes) >= consecutive_up + 2:
        _start = float(closes[-consecutive_up]) if consecutive_up > 0 else 0
        _total_pct = (latest_close / _start - 1) * 100 if _start > 0 else 0
    _resonance = _calc_detector_resonance(closes, volumes)
    _result = score_match("C", {
        "vol_ratio": vol_ratio, "consecutive_up": consecutive_up, "total_pct": round(_total_pct, 2),
        "above_ma144": True,
        "weekly_resonance_score": _resonance.get("resonance_score", 0),
    })
    return {
        "pattern_type": "C",
        "confidence": _result["level"],
        "confidence_score": _result["score"],
        "description": desc,
        "latest_close": latest_close,
        "latest_pct": float(pct_chg[-1]) if pct_chg and len(pct_chg) > 0 else 0,
        "above_250ma": True,
        "vol_ratio": vol_ratio,
        "ma144": round(get_ma_value(closes_arr, 144) or 0, 2),
    }


# ──────────────────────────────────────────────
# 形态D: 新高模式
# ──────────────────────────────────────────────

def detect_pattern_d(
    closes: List[float],
    volumes: List[float],
    highs: List[float] = None,
    lows: List[float] = None,
    opens: List[float] = None,
    pct_chg: List[float] = None,
) -> Optional[Dict]:
    """
    检测形态D: 新高模式（晓胜波段王核心策略）— 纯函数版本

    两种类型:
      1. 历史新高
      2. 阶段新高（N个月高点附近）
    """
    if closes is None or highs is None:
        return None
    if len(closes) < 500 or len(highs) < 500:
        return None

    cfg = CONFIG.pattern
    closes_arr = np.array(closes, dtype=float)
    highs_arr = np.array(highs, dtype=float)
    volumes_arr = np.array(volumes, dtype=float) if volumes else None

    latest_close = float(closes_arr[-1])
    if latest_close <= 0:
        return None

    # 计算5日线
    if len(closes_arr) < 5:
        return None
    ma5_series = np.convolve(closes_arr, np.ones(5) / 5, mode='valid')
    ma5_padded = np.full_like(closes_arr, np.nan)
    ma5_padded[4:] = ma5_series
    latest_ma5 = float(ma5_padded[-1])
    if np.isnan(latest_ma5) or latest_ma5 <= 0:
        return None
    dist_to_ma5 = (latest_close - latest_ma5) / latest_ma5 * 100

    # 条件1: 距5日线不能太远
    if dist_to_ma5 > cfg.pattern_d_max_ma5_deviation:
        return None

    # 计算阶段新高
    lookback_days = min(cfg.pattern_d_lookback_months * 20, len(closes_arr) - 60)
    period_high = float(np.max(highs_arr[-lookback_days:]))

    # 全量历史新高
    all_time_high = float(np.max(highs_arr))
    is_all_time_high = latest_close >= all_time_high * 0.99

    # 距阶段高点距离
    dist_to_period_high = (latest_close - period_high) / period_high * 100

    # 判定: 距阶段高点 -3% ~ +5% 范围内视为新高模式
    is_near_high = -3 <= dist_to_period_high <= 5
    if not is_near_high:
        return None

    # 量比检查
    vol_ratio = 1.0
    if volumes_arr is not None and len(volumes_arr) >= 20:
        vol = float(volumes_arr[-1])
        avg_vol = float(np.mean(volumes_arr[-21:-1]))
        vol_ratio = vol / avg_vol if avg_vol > 0 else 1.0

    if vol_ratio < cfg.pattern_d_min_vol_ratio:
        return None

    # 周线MA5在MA10上方（中期趋势向上）
    if len(closes_arr) >= 320:
        weekly_step = 5
        n_weeks = len(closes_arr) // weekly_step
        weekly_closes = closes_arr[-n_weeks * weekly_step::weekly_step]
        if len(weekly_closes) >= 10:
            w_ma5 = float(np.mean(weekly_closes[-5:]))
            w_ma10 = float(np.mean(weekly_closes[-10:]))
            if w_ma5 <= w_ma10:
                return None

    # 判断类型和置信度
    if is_all_time_high:
        new_high_type = "历史新高"
        confidence = "高" if vol_ratio >= 2 else "中"
        desc = f"历史新高突破(距5日线{dist_to_ma5:.1f}%|量比{vol_ratio:.1f})"
    else:
        new_high_type = "阶段新高"
        confidence = "高" if vol_ratio >= 1.5 else "中"
        desc = (f"阶段新高(距{cfg.pattern_d_lookback_months}月高点"
                f"{dist_to_period_high:.1f}%|距5日线{dist_to_ma5:.1f}%|量比{vol_ratio:.1f})")

    # 统一置信度评分
    _resonance = _calc_detector_resonance(closes, volumes)
    _result = score_match("D", {
        "new_high_type": new_high_type, "vol_ratio": vol_ratio, "dist_to_ma5": dist_to_ma5,
        "above_ma144": True,
        "weekly_resonance_score": _resonance.get("resonance_score", 0),
    })
    return {
        "pattern_type": "D",
        "confidence": _result["level"],
        "confidence_score": _result["score"],
        "description": desc,
        "latest_close": latest_close,
        "latest_pct": float(pct_chg[-1]) if pct_chg and len(pct_chg) > 0 else 0,
        "above_250ma": True,
        "is_new_high": True,
        "new_high_type": new_high_type,
        "new_high_period_high": period_high,
        "ma5_price": latest_ma5,
        "dist_to_ma5": dist_to_ma5,
        "vol_ratio": vol_ratio,
        "ma144": round(get_ma_value(closes_arr, 144) or 0, 2),
    }


# ──────────────────────────────────────────────
# 形态E: 大跌反包（前一天跌>4%，第二天阳线反包）
# ──────────────────────────────────────────────

def detect_pattern_e(
    closes: List[float],
    volumes: List[float],
    highs: List[float] = None,
    lows: List[float] = None,
    opens: List[float] = None,
    pct_chg: List[float] = None,
) -> Optional[Dict]:
    """
    检测形态E: 大跌反包

    条件:
      1. 前一天跌幅 > 4%
      2. 今天阳线，且阳线实体覆盖前一天阴线实体 ≥ 70%
      3. 放量确认（量比 ≥ 1.5）
    """
    if (closes is None or volumes is None or highs is None
            or lows is None or opens is None):
        return None
    if len(closes) < 20:
        return None

    cfg = CONFIG.pattern
    closes_arr = np.array(closes, dtype=float)
    highs_arr = np.array(highs, dtype=float)
    lows_arr = np.array(lows, dtype=float)
    opens_arr = np.array(opens, dtype=float)
    volumes_arr = np.array(volumes, dtype=float)

    if len(closes_arr) < 3:
        return None

    today_open = float(opens_arr[-1])
    today_close = float(closes_arr[-1])

    yesterday_open = float(opens_arr[-2])
    yesterday_close = float(closes_arr[-2])

    # ── 条件1: 前一天跌幅 > 4% ──
    yesterday_pct = (yesterday_close / closes_arr[-3] - 1) * 100 if len(closes_arr) >= 3 else 0
    if yesterday_pct >= -4:
        return None

    # ── 条件2: 今天阳线反包 ──
    is_yang = today_close > today_open
    if not is_yang or today_close <= 0:
        return None

    yesterday_entity = abs(yesterday_close - yesterday_open)
    if yesterday_entity <= 0:
        return None

    # 阳线实体覆盖阴线实体的比例
    overlap_bottom = max(today_open, min(yesterday_open, yesterday_close))
    overlap_top = min(today_close, max(yesterday_open, yesterday_close))
    overlap = max(0, overlap_top - overlap_bottom)
    engulf_ratio = overlap / yesterday_entity

    if engulf_ratio < cfg.pattern_e_engulf_ratio:
        return None

    # ── 条件3: 放量确认 ──
    volume = float(volumes_arr[-1])
    vol_ratio = 0
    if volume > 0 and len(volumes_arr) >= 20:
        prev_vols = volumes_arr[-21:-1]
        avg_vol = float(np.mean(prev_vols)) if len(prev_vols) > 0 else 0
        vol_ratio = volume / avg_vol if avg_vol > 0 else 0

    if vol_ratio < cfg.pattern_e_min_vol_ratio:
        return None

    # ── 条件4: 周线MA5 > MA10（中期趋势向上） ──
    # 将日线近似转为周线（每5个交易日采样），检查周均线
    weekly_ma_bullish = False
    if len(closes_arr) >= 320:
        weekly_step = 5
        n_weeks = len(closes_arr) // weekly_step
        weekly_closes = closes_arr[-n_weeks * weekly_step::weekly_step]
        if len(weekly_closes) >= 10:
            w_ma5 = float(np.mean(weekly_closes[-5:]))
            w_ma10 = float(np.mean(weekly_closes[-10:]))
            if w_ma5 > w_ma10:
                weekly_ma_bullish = True

    if not weekly_ma_bullish:
        return None

    # ── MA20向上检查（若配置启用）──
    if cfg.pattern_e_require_ma20_up:
        if len(closes_arr) >= 25:
            ma20 = np.convolve(closes_arr, np.ones(20) / 20, mode='valid')
            if len(ma20) >= 6:
                if ma20[-1] <= ma20[-6]:
                    return None

    # 跌幅越大，置信度越高
    if yesterday_pct < -7:
        confidence = "高"
    elif yesterday_pct < -5.5:
        confidence = "中"
    else:
        confidence = "低"

    latest_pct = float(pct_chg[-1]) if pct_chg and len(pct_chg) > 0 else 0

    # 统一置信度评分
    _resonance = _calc_detector_resonance(closes, volumes)
    _result = score_match("E", {
        "yesterday_pct": yesterday_pct, "engulf_ratio": engulf_ratio, "vol_ratio": vol_ratio,
        "above_ma144": True,
        "weekly_resonance_score": _resonance.get("resonance_score", 0),
    })
    return {
        "pattern_type": "E",
        "confidence": _result["level"],
        "confidence_score": _result["score"],
        "description": (f"大跌反包(前日跌{abs(yesterday_pct):.1f}%"
                        f"|阳包阴覆盖{engulf_ratio:.0%}"
                        f"|涨幅{latest_pct:.1f}%|量比{vol_ratio:.1f})"),
        "latest_close": today_close,
        "latest_pct": latest_pct,
        "above_250ma": False,
        "vol_ratio": vol_ratio,
        "ma144": round(get_ma_value(closes_arr, 144) or 0, 2),
    }


# ──────────────────────────────────────────────
# 形态F: 上升三法（持续看涨K线组合）
# ──────────────────────────────────────────────

def detect_pattern_f(
    closes: List[float],
    volumes: List[float],
    highs: List[float] = None,
    lows: List[float] = None,
    opens: List[float] = None,
    pct_chg: List[float] = None,
) -> Optional[Dict]:
    """
    检测形态F: 上升三法 — 纯函数版本

    结构:
      大阳线(放量) → 2~5根缩量小K线(不破首阳低点) → 大阳线(放量突破)

    条件:
      1. 末根阳线，涨幅≥3%，量比≥1.2
      2. 中间2~5根小K线，|涨跌幅|≤7%，最低≥首阳最低价
      3. 首根大阳线，涨幅≥4%
      4. 中间缩量：每根量≤首根量的90%
      5. 末根收盘>首根最高（突破确认）
      （周线春阶段已保证中期多头趋势，不单独要求年线）
    """
    if (closes is None or volumes is None or highs is None
            or lows is None or opens is None or pct_chg is None):
        return None
    if len(closes) < 60 or len(volumes) < 60:
        return None

    cfg = CONFIG.pattern
    closes_arr = np.array(closes, dtype=float)
    opens_arr = np.array(opens, dtype=float)
    highs_arr = np.array(highs, dtype=float)
    lows_arr = np.array(lows, dtype=float)
    volumes_arr = np.array(volumes, dtype=float)
    pct_arr = np.array(pct_chg, dtype=float)

    n = len(closes_arr)
    idx_last = n - 1

    # 条件1: 末根阳线
    last_close = float(closes_arr[idx_last])
    last_open = float(opens_arr[idx_last])
    last_high = float(highs_arr[idx_last])
    last_volume = float(volumes_arr[idx_last])
    last_pct = float(pct_arr[idx_last])

    if last_close <= last_open:
        return None
    if last_pct < cfg.pattern_f_min_last_pct:
        return None

    # 末根量比
    if len(volumes_arr) >= 20:
        avg_vol = float(np.mean(volumes_arr[-21:-1]))
        last_vol_ratio = last_volume / avg_vol if avg_vol > 0 else 0
    else:
        last_vol_ratio = 0
    if last_vol_ratio < cfg.pattern_f_last_vol_ratio:
        return None

    # ── 找中间小K线段 ──
    interim_start = None
    for i in range(idx_last - 1, max(0, idx_last - cfg.pattern_f_max_interim_days - 3), -1):
        pct = float(pct_arr[i])
        if abs(pct) <= cfg.pattern_f_max_interim_pct:
            interim_start = i
        else:
            break

    if interim_start is None:
        return None

    interim_count = idx_last - interim_start
    if interim_count < cfg.pattern_f_min_interim_days:
        return None
    if interim_count > cfg.pattern_f_max_interim_days:
        return None

    # ── 首根大阳线 ──
    idx_first = interim_start - 1
    if idx_first < 0:
        return None

    first_close = float(closes_arr[idx_first])
    first_open = float(opens_arr[idx_first])
    first_high = float(highs_arr[idx_first])
    first_low = float(lows_arr[idx_first])
    first_volume = float(volumes_arr[idx_first])
    first_pct = float(pct_arr[idx_first])

    if first_close <= first_open:
        return None
    if first_pct < cfg.pattern_f_min_first_pct:
        return None

    # ── 验证中间K线: 不破首阳低点 + 缩量 ──
    for i in range(interim_start, idx_last):
        if float(lows_arr[i]) < first_low:
            return None
        if float(volumes_arr[i]) > first_volume * cfg.pattern_f_vol_shrink_ratio:
            return None

    # ── 末根收盘 > 首根最高（突破确认） ──
    if last_close <= first_high:
        return None

    # ── 周线MA5 > MA10（中期趋势向上） ──
    if len(closes_arr) >= 320:
        weekly_step = 5
        n_weeks = len(closes_arr) // weekly_step
        weekly_closes = closes_arr[-n_weeks * weekly_step::weekly_step]
        if len(weekly_closes) >= 10:
            w_ma5 = float(np.mean(weekly_closes[-5:]))
            w_ma10 = float(np.mean(weekly_closes[-10:]))
            if w_ma5 <= w_ma10:
                return None

    # ── 置信度 ──
    all_bearish_interim = True
    for i in range(interim_start, idx_last):
        if float(closes_arr[i]) >= float(opens_arr[i]):
            all_bearish_interim = False
            break

    interim_vol_ratio = 1.0
    if first_volume > 0:
        interim_avg_vol = float(np.mean([float(volumes_arr[i]) for i in range(interim_start, idx_last)]))
        interim_vol_ratio = interim_avg_vol / first_volume if first_volume > 0 else 1.0

    if all_bearish_interim and interim_vol_ratio < 0.5 and first_pct >= 7:
        confidence = "高"
    elif first_pct >= 7 and last_vol_ratio >= 2:
        confidence = "中"
    else:
        confidence = "低"

    # 统一置信度评分
    _resonance = _calc_detector_resonance(closes, volumes)
    _result = score_match("F", {
        "first_pct": first_pct, "all_bearish_interim": all_bearish_interim,
        "interim_vol_ratio": interim_vol_ratio, "last_vol_ratio": last_vol_ratio,
        "vol_ratio": last_vol_ratio, "above_ma144": True,
        "weekly_resonance_score": _resonance.get("resonance_score", 0),
    })
    return {
        "pattern_type": "F",
        "confidence": _result["level"],
        "confidence_score": _result["score"],
        "description": (
            f"上升三法(首阳{first_pct:.1f}%"
            f"|中间{interim_count}天缩量"
            f"|末涨{last_pct:.1f}%|量比{last_vol_ratio:.1f})"
        ),
        "latest_close": last_close,
        "latest_pct": last_pct,
        "above_250ma": True,
        "vol_ratio": last_vol_ratio,
        "ma144": round(get_ma_value(closes_arr, 144) or 0, 2),
    }


# ──────────────────────────────────────────────
# 调度器
# ──────────────────────────────────────────────

DETECTOR_MAP = {
    "A": detect_pattern_a,
    "B": detect_pattern_b,
    "C": detect_pattern_c,
    "D": detect_pattern_d,
    "E": detect_pattern_e,
    "F": detect_pattern_f,
}


def get_detector(pattern_type: str):
    """根据模式类型获取对应的检测函数"""
    return DETECTOR_MAP.get(pattern_type)


def detect_all(
    closes: List[float],
    volumes: List[float],
    highs: List[float] = None,
    lows: List[float] = None,
    opens: List[float] = None,
    pct_chg: List[float] = None,
    patterns: tuple = ("A", "B", "C", "D", "E", "F"),
) -> Optional[Dict]:
    """
    按优先级检测所有模式，返回第一个匹配的结果。

    优先级: D → A → B → C → E → F
    """
    priority = {"D": 0, "A": 1, "B": 2, "C": 3, "E": 4, "F": 5}
    sorted_patterns = sorted(patterns, key=lambda p: priority.get(p, 9))

    for p in sorted_patterns:
        detector = get_detector(p)
        if detector:
            result = detector(closes, volumes, highs, lows, opens, pct_chg)
            if result:
                return result
    return None
