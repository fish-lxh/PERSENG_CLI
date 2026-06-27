"""
统一置信度评分系统 — Phase 3
==============================
将6种形态的"高/中/低"转换为统一的 0-100 数值评分。

评分结构:
  - 形态专属基础分: 0-60（每种形态独立计算）
  - 跨形态加分项:   0-40（通用因子）
  - 总分:           0-100

等级对照:
  - 高 (≥70):  强烈信号，重点关注
  - 中 (≥40):  有效信号，纳入观察
  - 低 (<40):  边缘信号，仅供参考
"""
from typing import Dict, Optional, Union
import numpy as np


# ── 等级阈值 ──
HIGH_THRESHOLD = 70   # 高
MID_THRESHOLD = 40    # 中
# < 40 = 低


def resolve_level(score: int) -> str:
    """将数值评分映射回等级"""
    if score >= HIGH_THRESHOLD:
        return "高"
    elif score >= MID_THRESHOLD:
        return "中"
    return "低"


# ══════════════════════════════════════════════
# 各形态基础分计算 (0-60)
# ══════════════════════════════════════════════

def _base_a(match: dict) -> int:
    """
    形态A: 首板250
    - 250线在实体中部(30-70%) → +20
    - 量比≥2.0 → +20
    - 涨幅>15% → +10; >12% → +5
    - 首日穿越(days_since_cross=1) → +10
    """
    score = 0
    ma250_pos = match.get("ma250_pos_in_body", 0.5)
    vol_ratio = match.get("vol_ratio", 0)
    pct = match.get("latest_pct", match.get("pct", 0))
    days_since = match.get("days_since_cross", 99)

    # 250线穿越位置
    if 0.3 <= ma250_pos <= 0.7:
        score += 20
    elif 0.15 <= ma250_pos <= 0.85:
        score += 10

    # 量比
    if vol_ratio >= 3.0:
        score += 20
    elif vol_ratio >= 2.0:
        score += 15
    elif vol_ratio >= 1.5:
        score += 10

    # 涨幅
    if pct > 15:
        score += 10
    elif pct > 12:
        score += 5

    # 首日穿越（最佳买点）
    if days_since == 1:
        score += 10

    return min(score, 60)


def _base_b(match: dict) -> int:
    """
    形态B: 上影线试盘
    - 涨幅: 3.8%→0, >10%→20
    - 上影线占比: 30%→5, >60%→20
    - 量比: 2.0→5, >5→20
    """
    score = 0
    pct = match.get("latest_pct", 0)
    shadow_ratio = match.get("shadow_ratio", 0.3)
    vol_ratio = match.get("vol_ratio", 0)

    # 涨幅
    if pct >= 10:
        score += 20
    elif pct >= 7:
        score += 15
    elif pct >= 5:
        score += 10
    elif pct >= 3.8:
        score += 5

    # 上影线占比
    if shadow_ratio >= 0.6:
        score += 20
    elif shadow_ratio >= 0.5:
        score += 15
    elif shadow_ratio >= 0.4:
        score += 10
    elif shadow_ratio >= 0.3:
        score += 5

    # 量比
    if vol_ratio >= 5:
        score += 20
    elif vol_ratio >= 4:
        score += 15
    elif vol_ratio >= 3:
        score += 10
    elif vol_ratio >= 2:
        score += 5

    return min(score, 60)


def _base_c(match: dict) -> int:
    """
    形态C: 小阳线爬升
    - 连涨天数: 9天→10, >15天→20
    - 温和放量: 量比1.3→10, ≥2.0→20
    - 累计涨幅(连涨期间): >15%→20
    """
    score = 0
    consecutive_up = match.get("consecutive_up", match.get("vol_ratio", 0) > 0 and 9 or 0)
    vol_ratio = match.get("vol_ratio", 1.0)
    total_pct = match.get("total_pct", 0)

    # 连涨天数
    if consecutive_up >= 15:
        score += 20
    elif consecutive_up >= 12:
        score += 15
    elif consecutive_up >= 9:
        score += 10

    # 放量程度
    if vol_ratio >= 2.0:
        score += 20
    elif vol_ratio >= 1.5:
        score += 15
    elif vol_ratio >= 1.3:
        score += 10

    # 累计涨幅
    if total_pct > 15:
        score += 20
    elif total_pct > 10:
        score += 10

    return min(score, 60)


def _base_d(match: dict) -> int:
    """
    形态D: 新高模式
    - 历史新高→30, 阶段新高→15
    - 量比: 1.0→0, ≥3→20
    - 贴5日线: dist_to_ma5<2%→10
    """
    score = 0
    new_high_type = match.get("new_high_type", "")
    vol_ratio = match.get("vol_ratio", 1.0)
    dist_ma5 = abs(match.get("dist_to_ma5", 0))

    # 新高类型
    if new_high_type == "历史新高":
        score += 30
    else:
        score += 15

    # 量比
    if vol_ratio >= 3:
        score += 20
    elif vol_ratio >= 2:
        score += 15
    elif vol_ratio >= 1.5:
        score += 10
    elif vol_ratio >= 1.0:
        score += 5

    # 贴5日线博弈（晓胜: 越贴越好）
    if dist_ma5 < 1:
        score += 10
    elif dist_ma5 < 3:
        score += 5

    return min(score, 60)


def _base_e(match: dict) -> int:
    """
    形态E: 反包博弈
    - 前日跌幅: -4%→5, -7%→15, >-10%→25
    - 反包覆盖: 70%→5, >100%→20
    - 量比: ≥1.5→5, ≥3→15
    """
    score = 0
    yesterday_pct = match.get("yesterday_pct", 0)
    engulf_ratio = match.get("engulf_ratio", 0.7)
    vol_ratio = match.get("vol_ratio", 1.5)

    # 前日跌幅（跌越多，反弹动能越强）
    abs_drop = abs(yesterday_pct)
    if abs_drop > 10:
        score += 25
    elif abs_drop > 7:
        score += 20
    elif abs_drop > 5.5:
        score += 15
    elif abs_drop > 4:
        score += 5

    # 反包覆盖程度
    if engulf_ratio >= 1.0:
        score += 20
    elif engulf_ratio >= 0.85:
        score += 15
    elif engulf_ratio >= 0.7:
        score += 5

    # 放量确认
    if vol_ratio >= 3:
        score += 15
    elif vol_ratio >= 2:
        score += 10
    elif vol_ratio >= 1.5:
        score += 5

    return min(score, 60)


def _base_f(match: dict) -> int:
    """
    形态F: 上升三法
    - 首阳涨幅: 4%→0, >10%→20
    - 中间全阴线→10
    - 缩量明显(量比<0.5)→10
    - 末根放量: 量比≥2→20
    """
    score = 0
    first_pct = match.get("first_pct", 4)
    all_bearish = match.get("all_bearish_interim", False)
    interim_vol_ratio = match.get("interim_vol_ratio", 1.0)
    last_vol_ratio = match.get("last_vol_ratio", match.get("vol_ratio", 1.0))

    # 首阳力度
    if first_pct >= 10:
        score += 20
    elif first_pct >= 7:
        score += 15
    elif first_pct >= 5:
        score += 10
    elif first_pct >= 4:
        score += 5

    # 中间K线全阴（经典形态最强）
    if all_bearish:
        score += 10

    # 缩量明显
    if interim_vol_ratio < 0.4:
        score += 10
    elif interim_vol_ratio < 0.5:
        score += 5

    # 末根放量突破
    if last_vol_ratio >= 3:
        score += 20
    elif last_vol_ratio >= 2:
        score += 15
    elif last_vol_ratio >= 1.2:
        score += 5

    return min(score, 60)


# ══════════════════════════════════════════════
# 跨形态加分项 (0-40)
# ══════════════════════════════════════════════

def _bonus(match: dict) -> int:
    """
    跨形态通用加分:
    - 站上MA144 (半年线上方) → +8
    - MA多头排列(5>10>20>55) → +8
    - 144>250 (中线>长线) → +8
    - 周线L1评分≥3 → +8
    - 量价配合 (上涨放量) → +8
    """
    bonus = 0

    # 1. 站上MA144
    above_ma144 = match.get("above_ma144", False)
    if above_ma144:
        bonus += 8

    # 2. MA多头排列
    ma_alignment = match.get("ma_alignment", 0)
    if ma_alignment >= 4:
        bonus += 8
    elif ma_alignment >= 3:
        bonus += 4

    # 3. 144>250 (中线趋势强于长线)
    ma144 = match.get("ma144", match.get("ma144_price", 0))
    ma250 = match.get("ma250", match.get("ma250_price", 0))
    if ma144 and ma250 and ma144 > ma250:
        bonus += 8

    # 4. 周线共振评分 (Phase 4: 多周期共振)
    # 优先使用新的 weekly_resonance_score(0-10)，fallback 旧 weekly_l1_score(0-4)
    weekly_resonance = match.get("weekly_resonance_score", 0)
    if weekly_resonance == 0:
        wk_old = match.get("weekly_l1_score", 0)
        if wk_old >= 4:
            weekly_resonance = 10
        elif wk_old == 3:
            weekly_resonance = 8
        elif wk_old == 2:
            weekly_resonance = 4
    if weekly_resonance >= 8:
        bonus += 10
    elif weekly_resonance >= 6:
        bonus += 8
    elif weekly_resonance >= 4:
        bonus += 4
    elif weekly_resonance >= 2:
        bonus += 2

    # 5. 量价配合 (放量上涨)
    pct = abs(match.get("latest_pct", match.get("pct", 0)))
    vol_ratio = match.get("vol_ratio", 0)
    if pct >= 5 and vol_ratio >= 2:
        bonus += 8
    elif vol_ratio >= 2:
        bonus += 4

    # 6. 多周期共振加分 (Phase 4: 日线+周线同时确认)
    ma_alignment = match.get("ma_alignment", 0)
    if ma_alignment >= 4 and weekly_resonance >= 6:
        bonus += 6
    elif ma_alignment >= 3 and weekly_resonance >= 4:
        bonus += 4
    elif ma_alignment >= 3 or weekly_resonance >= 4:
        bonus += 2

    return min(bonus, 40)


# ══════════════════════════════════════════════
# 主入口
# ══════════════════════════════════════════════

# 形态基础分函数映射
_BASE_FUNCS = {
    "A": _base_a,
    "B": _base_b,
    "C": _base_c,
    "D": _base_d,
    "E": _base_e,
    "F": _base_f,
}


def score_match(pattern_type: str, match: dict) -> Dict[str, Union[int, str, dict]]:
    """
    对单个匹配结果计算统一置信度评分。

    参数:
        pattern_type: 形态类型 ("A"-"F")
        match: 匹配结果字典（含字段随形态不同）

    返回:
        {
            "score": 0-100,
            "level": "高"/"中"/"低",
            "base": 基础分,
            "bonus": 加分,
            "factors": {各分项明细}
        }
    """
    base_func = _BASE_FUNCS.get(pattern_type)
    if not base_func:
        return {"score": 0, "level": "低", "base": 0, "bonus": 0, "factors": {}}

    base = base_func(match)
    bonus = _bonus(match)
    total = min(base + bonus, 100)
    level = resolve_level(total)

    return {
        "score": total,
        "level": level,
        "base": base,
        "bonus": bonus,
        "factors": {
            "base": base,
            "bonus": bonus,
            "total": total,
            "resonance_score": match.get("weekly_resonance_score", 0),
            "resonance_level": match.get("weekly_resonance_level", ""),
        },
    }


def batch_score(matches: list) -> list:
    """
    批量评分（原地添加评分字段）

    参数:
        matches: PatternMatch 对象列表或字典列表

    返回: 原始列表（每个元素新增 confidence_score, confidence_level, confidence_detail）
    """
    for m in matches:
        if hasattr(m, "pattern_type"):
            # PatternMatch 对象
            result = score_match(m.pattern_type, m.__dict__)
            m.confidence_score = result["score"]
            m.confidence_level = result["level"]
            m.confidence_detail = result
        elif isinstance(m, dict):
            # 字典
            result = score_match(m.get("pattern_type", ""), m)
            m["confidence_score"] = result["score"]
            m["confidence_level"] = result["level"]
            m["confidence_detail"] = result
    return matches
