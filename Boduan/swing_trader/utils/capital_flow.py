"""
主力运作阶段识别
==================
基于晓胜波段王的主力运作4阶段理论:
1. 蛰伏吸筹 — 底部横盘超过3个月，主力进场收集筹码
2. 第一波启动 — 放量涨停/大涨突破年线，主力正式发动行情
3. 阴跌洗盘 — 第一波上涨后震荡下跌，成交量萎缩
4. 再次吸引 — 洗盘结束后，价格再次放量上涨创新高
"""
import logging
from typing import List, Dict, Optional

import numpy as np

logger = logging.getLogger(__name__)


def identify_capital_phase(closes: List[float],
                           volumes: List[float],
                           highs: Optional[List[float]] = None,
                           lows: Optional[List[float]] = None,
                           ma250: float = 0) -> Dict:
    """
    识别主力运作阶段

    参数:
        closes: 日线收盘价序列（至少60个交易日）
        volumes: 日线成交量序列
        highs: 日线最高价（可选）
        lows: 日线最低价（可选）
        ma250: 250日均线价格（可选）

    返回:
    {
        "phase": str,        # "蛰伏吸筹"/"第一波启动"/"阴跌洗盘"/"再次吸引"/"方向不明"
        "confidence": float, # 0-1
        "indicators": {...}, # 各维度检测指标
        "description": str,  # 中文描述
    }
    """
    if len(closes) < 60:
        return {
            "phase": "数据不足",
            "confidence": 0,
            "indicators": {},
            "description": "需要至少60个交易日数据",
        }

    closes_arr = np.array(closes, dtype=float)
    volumes_arr = np.array(volumes, dtype=float) if volumes else np.array([])
    price = float(closes_arr[-1])

    # ========== 特征提取 ==========

    # 60日价格区间
    low_60 = float(np.min(closes_arr[-60:]))
    high_60 = float(np.max(closes_arr[-60:]))
    range_60 = (high_60 - low_60) / low_60 * 100 if low_60 > 0 else 0
    price_position = (price - low_60) / (high_60 - low_60) if (high_60 - low_60) > 0 else 0.5

    # 成交量间歇放大检测（60日内）
    vol_spikes = 0
    if len(volumes_arr) >= 60:
        vol_mean = float(np.mean(volumes_arr[-60:]))
        vol_std = float(np.std(volumes_arr[-60:]))
        if vol_std > 0:
            vol_spikes = int(sum(1 for v in volumes_arr[-60:] if v > vol_mean + vol_std * 1.5))

    # 近期涨幅
    recent_5_pct = (price / float(closes_arr[-5]) - 1) * 100 if len(closes_arr) >= 5 else 0
    recent_20_pct = (price / float(closes_arr[-20]) - 1) * 100 if len(closes_arr) >= 20 else 0
    recent_60_pct = (price / float(closes_arr[-60]) - 1) * 100 if len(closes_arr) >= 60 else 0

    # 近期量比
    vol_ratio = 1.0
    if len(volumes_arr) >= 20:
        recent_vol = float(volumes_arr[-1])
        avg_vol = float(np.mean(volumes_arr[-21:-1]))
        vol_ratio = recent_vol / avg_vol if avg_vol > 0 else 1.0

    # ========== 阶段判定 ==========

    is_first_wave = recent_5_pct > 15 and vol_ratio > 1.5  # 急涨+放量
    is_near_high = price > high_60 * 0.95                   # 接近60日高点
    is_near_low = price_position < 0.3                      # 在60日区间低位

    # 洗盘特征: 第一波上涨后20日回撤5-20%
    has_wash = (recent_20_pct < -5 and recent_20_pct > -20
                and vol_ratio < 1.2)  # 缩量

    # 再次吸引: 洗盘后再次放量上涨
    re_attract = has_wash and recent_5_pct > 8 and vol_ratio > 1.3 and is_near_high

    # 年线附近判定
    near_ma250 = False
    if ma250 > 0:
        near_ma250 = abs(price - ma250) / ma250 * 100 < 10

    # 综合判定
    indicators = {
        "range_60_pct": round(range_60, 1),
        "price_position_60": round(price_position, 2),
        "vol_spikes_60d": vol_spikes,
        "recent_5d_pct": round(recent_5_pct, 1),
        "recent_20d_pct": round(recent_20_pct, 1),
        "vol_ratio": round(vol_ratio, 1),
        "near_ma250": near_ma250,
    }

    # 诊断
    diagnoses = []
    if range_60 < 15:
        diagnoses.append("窄幅震荡")
    elif range_60 < 30:
        diagnoses.append("正常波动")
    elif range_60 < 50:
        diagnoses.append("波动较大")
    else:
        diagnoses.append("剧烈波动")

    if vol_spikes >= 5:
        diagnoses.append("间歇放量")
    elif vol_spikes >= 3:
        diagnoses.append("温和放量")
    else:
        diagnoses.append("量能平稳")

    if re_attract:
        phase = "再次吸引"
        confidence = 0.75
        desc = f"洗盘结束再启动，放量突破60日高点，第二波主升浪可能开启"
    elif has_wash and recent_5_pct > 3 and is_near_high:
        phase = "再次吸引"
        confidence = 0.6
        desc = f"洗盘后有止跌回升迹象"
    elif has_wash:
        phase = "阴跌洗盘"
        confidence = 0.7
        desc = f"第一波上涨后缩量回调{abs(recent_20_pct):.0f}%，追涨者离场"
    elif is_first_wave and is_near_high:
        phase = "第一波启动"
        confidence = 0.8
        desc = f"放量拉升突破，主力发动行情，涨幅{recent_5_pct:.0f}%"
    elif range_60 < 30 and is_near_low and vol_spikes >= 3:
        phase = "蛰伏吸筹"
        confidence = 0.65
        desc = f"底部{diagnoses[0]}，{diagnoses[1]}，主力收集筹码"
    else:
        phase = "方向不明"
        confidence = 0.3
        desc = f"股价在60日区间中部，成交量无明显特征"

    return {
        "phase": phase,
        "confidence": round(confidence, 2),
        "indicators": indicators,
        "diagnoses": diagnoses,
        "description": desc,
    }
