"""
技术指标计算模块 — MACD / KDJ / MA
"""
import pandas as pd
import numpy as np


def calc_ma(df: pd.DataFrame, period: int = 5, col: str = "close") -> pd.Series:
    """计算移动均线"""
    return df[col].rolling(window=period).mean()


def calc_macd(df: pd.DataFrame, fast: int = 12, slow: int = 26,
              signal: int = 9, col: str = "close"):
    """
    计算 MACD 指标
    返回: (DIF, DEA, MACD柱) 三个 Series
    """
    ema_fast = df[col].ewm(span=fast, adjust=False).mean()
    ema_slow = df[col].ewm(span=slow, adjust=False).mean()
    dif = ema_fast - ema_slow
    dea = dif.ewm(span=signal, adjust=False).mean()
    macd_bar = 2 * (dif - dea)
    return dif, dea, macd_bar


def calc_kdj(df: pd.DataFrame, n: int = 9, k_factor: float = 1/3,
             d_factor: float = 1/3):
    """
    计算 KDJ 指标 (周线常用)
    返回: (K, D, J) 三个 Series
    """
    low_n = df["low"].rolling(window=n).min()
    high_n = df["high"].rolling(window=n).max()

    rsv = (df["close"] - low_n) / (high_n - low_n) * 100

    k = pd.Series(50.0, index=df.index)
    d = pd.Series(50.0, index=df.index)

    for i in range(n, len(df)):
        k.iloc[i] = k_factor * rsv.iloc[i] + (1 - k_factor) * k.iloc[i - 1]
        d.iloc[i] = d_factor * k.iloc[i] + (1 - d_factor) * d.iloc[i - 1]

    j = 3 * k - 2 * d
    return k, d, j


def calc_kdj_simple(df: pd.DataFrame, n: int = 9):
    """
    简化 KDJ 计算（无递归，避免前向依赖问题）
    适用于已按时间排序的 DataFrame
    """
    low_n = df["low"].rolling(window=n).min()
    high_n = df["high"].rolling(window=n).max()
    rsv = (df["close"] - low_n) / (high_n - low_n).replace(0, np.nan) * 100
    k = rsv.ewm(com=2, adjust=False).mean()
    d = k.ewm(com=2, adjust=False).mean()
    j = 3 * k - 2 * d
    return k, d, j


def check_macd_golden_cross(dif: pd.Series, dea: pd.Series) -> bool:
    """判断 MACD 是否金叉（DIF 上穿 DEA）"""
    if len(dif) < 2:
        return False
    return dif.iloc[-2] < dea.iloc[-2] and dif.iloc[-1] > dea.iloc[-1]


def check_macd_death_cross(dif: pd.Series, dea: pd.Series) -> bool:
    """判断 MACD 是否死叉（DIF 下穿 DEA）"""
    if len(dif) < 2:
        return False
    return dif.iloc[-2] > dea.iloc[-2] and dif.iloc[-1] < dea.iloc[-1]


def check_kdj_golden_cross(k: pd.Series, d: pd.Series) -> bool:
    """判断 KDJ 是否金叉（K 上穿 D）"""
    if len(k) < 2:
        return False
    return k.iloc[-2] < d.iloc[-2] and k.iloc[-1] > d.iloc[-1]


def check_volume_expansion(volume: pd.Series, period: int = 5,
                           ratio: float = 1.5) -> bool:
    """判断成交量是否放量（最近一期 vs 之前N期均值）"""
    if len(volume) < period + 1:
        return False
    recent = volume.iloc[-1]
    baseline = volume.iloc[-(period + 1):-1].mean()
    if pd.isna(baseline) or baseline == 0:
        return False
    return recent > baseline * ratio


# ── 大牛有形辅助函数 ──

def calc_ma_multi(closes: np.ndarray, periods: list) -> dict:
    """
    批量计算多条移动均线的最新值
    返回: {period: ma_value}
    """
    result = {}
    n = len(closes)
    for p in periods:
        if n < p:
            result[p] = None
            continue
        ma = np.convolve(closes, np.ones(p) / p, mode='valid')
        result[p] = float(ma[-1])
    return result


def get_ma_value(closes: np.ndarray, period: int) -> float:
    """
    获取最新一条移动均线值
    返回 float，数据不足时返回 None
    """
    if len(closes) < period:
        return None
    ma = np.convolve(closes, np.ones(period) / period, mode='valid')
    return float(ma[-1])


def calc_ma_direction(ma_series: np.ndarray, lookback: int = 5) -> str:
    """
    判断均线方向
    返回: "up" / "down" / "flat"
    """
    if len(ma_series) < lookback * 2:
        return "flat"
    recent = np.mean(ma_series[-lookback:])
    previous = np.mean(ma_series[-(lookback * 2):-lookback])
    diff_pct = (recent - previous) / (previous + 1e-10) * 100
    if diff_pct > 0.5:
        return "up"
    elif diff_pct < -0.5:
        return "down"
    return "flat"


def calc_ma_convergence(closes: np.ndarray, periods: list) -> dict:
    """
    计算均线汇聚程度
    返回:
    {
        "spread_pct": float,      # 最大均线与最下均线的发散百分比
        "is_converging": bool,    # 是否汇聚
        "num_valid": int,         # 有效均线条数
        "mas": {period: value}    # 各均线值
    }
    """
    mas = calc_ma_multi(closes, periods)
    valid_values = [v for v in mas.values() if v is not None]
    if len(valid_values) < 2:
        return {"spread_pct": 0, "is_converging": False, "num_valid": len(valid_values), "mas": mas}

    max_ma = max(valid_values)
    min_ma = min(valid_values)
    latest_close = closes[-1]
    spread_pct = (max_ma - min_ma) / latest_close * 100 if latest_close > 0 else 0

    return {
        "spread_pct": round(spread_pct, 2),
        "is_converging": spread_pct < 8.0,  # 发散 < 8% 视为汇聚
        "num_valid": len(valid_values),
        "mas": mas,
    }


def check_bullish_alignment(mas: dict, min_count: int = 4) -> tuple:
    """
    检查均线多头排列: 按周期从短到长，值从大到小
    例如 MA5 > MA10 > MA20 等

    mas: {period: value}
    返回: (is_aligned, count)  — 是否多头排列，满足条件的均线条数
    """
    periods = sorted(mas.keys())
    values = [mas[p] for p in periods if mas[p] is not None]
    if len(values) < 2:
        return False, 0

    count = 1
    for i in range(1, len(values)):
        if values[i] is not None and values[i-1] is not None and values[i-1] > values[i]:
            count += 1
        else:
            break

    return count >= min_count, count


def check_weekly_l1(daily_df: pd.DataFrame = None,
                     weekly_closes: np.ndarray = None,
                     weekly_volumes: np.ndarray = None) -> tuple:
    """
    多条件周线L1过滤 — 4因子评分系统

    评分因子:
      1. MA5 > MA10（硬性要求，必须满足）
      2. MA10 方向向上（当前MA10 > 3周前MA10）
      3. 周线 MACD > 0（DIF在零轴上方）
      4. 成交量递增（近3周均量 > 前5周均量）

    参数:
        daily_df: 日线DataFrame，自动合成周线（与weekly_closes二选一）
        weekly_closes: 预计算的周线收盘价数组（与daily_df二选一）
        weekly_volumes: 预计算的周线成交量数组（可选）

    返回: (passed: bool, score: int, details: dict)
    通过条件: MA5>MA10 且 总分 ≥ 2（至少满足1个辅助条件）
    """
    # ── 获取周线数据 ──
    if weekly_closes is not None:
        wk_closes = weekly_closes
        wk_volumes = weekly_volumes
    elif daily_df is not None:
        df_temp = daily_df.copy()
        df_temp["date_dt"] = pd.to_datetime(df_temp["date"])
        df_temp["week"] = df_temp["date_dt"].dt.isocalendar().week.astype(str) \
            + "-" + df_temp["date_dt"].dt.isocalendar().year.astype(str)
        agg_map = {"close": "last"}
        if "volume" in df_temp.columns:
            agg_map["volume"] = "sum"
        weekly_df = df_temp.groupby("week").agg(agg_map).reset_index()
        wk_closes = weekly_df["close"].values
        wk_volumes = weekly_df["volume"].values if "volume" in weekly_df.columns else None
    else:
        return False, 0, {"reason": "未提供数据"}

    if len(wk_closes) < 10:
        return False, 0, {"reason": "不足10周数据"}

    # ── 条件1: MA5 > MA10（硬性要求）──
    w_ma5 = float(np.mean(wk_closes[-5:]))
    w_ma10 = float(np.mean(wk_closes[-10:]))
    if w_ma5 <= w_ma10:
        return False, 0, {
            "ma5": round(w_ma5, 2), "ma10": round(w_ma10, 2),
            "reason": "MA5未站上MA10",
            "scores": {"ma5_ma10": 0, "ma10_dir": 0, "macd": 0, "volume": 0},
        }

    score = 0
    details: dict = {"ma5": round(w_ma5, 2), "ma10": round(w_ma10, 2)}

    # ── 条件2: MA10 方向向上（当前MA10 > 3周前MA10）──
    ma10_dir_score = 0
    if len(wk_closes) >= 13:
        ma10_now = w_ma10  # 已计算
        ma10_before = float(np.mean(wk_closes[-13:-3]))
        if ma10_now > ma10_before:
            ma10_dir_score = 1
            score += 1
        details["ma10_now"] = round(ma10_now, 2)
        details["ma10_before"] = round(ma10_before, 2)
    details["cond_ma10_dir"] = ma10_dir_score

    # ── 条件3: 周线 MACD DIF > 0（零轴上方）──
    macd_score = 0
    if len(wk_closes) >= 30:
        closes_f = wk_closes.astype(float)
        ema12 = [float(closes_f[0])]
        ema26 = [float(closes_f[0])]
        for k in range(1, len(closes_f)):
            ema12.append(ema12[-1] * 11/13 + float(closes_f[k]) * 2/13)
            ema26.append(ema26[-1] * 25/27 + float(closes_f[k]) * 2/27)
        dif = ema12[-1] - ema26[-1]
        if dif > 0:
            macd_score = 1
            score += 1
        details["dif"] = round(dif, 4)
    details["cond_macd"] = macd_score

    # ── 条件4: 成交量递增（近3周均量 > 前5周均量）──
    vol_score = 0
    if wk_volumes is not None and len(wk_volumes) >= 15:
        recent_vol = float(np.mean(wk_volumes[-3:]))
        prev_vol = float(np.mean(wk_volumes[-8:-3]))
        if prev_vol > 0 and recent_vol > prev_vol * 1.05:  # 至少5%放量
            vol_score = 1
            score += 1
        details["vol_ratio"] = round(recent_vol / prev_vol, 2) if prev_vol > 0 else 0
    details["cond_vol"] = vol_score

    # ── 综合判定: MA5>MA10 已保证，再满足至少1个辅助条件 ──
    passed = score >= 2
    details["scores"] = {"ma5_ma10": 1, "ma10_dir": ma10_dir_score, "macd": macd_score, "volume": vol_score}
    details["total_score"] = score
    details["reason"] = f"L1评分{score}/4" if passed else f"L1评分{score}/4(辅助条件不足)"

    return passed, score, details


def calc_weekly_resonance(daily_df: pd.DataFrame = None,
                          weekly_closes: np.ndarray = None,
                          weekly_volumes: np.ndarray = None) -> dict:
    """
    多因子周线共振评分 (0-10)

    用于多周期共振加权（Phase 4），替代旧的 binary L1 加分。
    评分越高，周线与日线共振程度越强。

    5个评分因子:
      1. MA趋势对齐 (0-3): MA5>MA10>MA20 / MA5>MA10且gap>2% / MA5>MA10
      2. MACD多头状态 (0-2): DIF>0且DIF上升 / DIF>0
      3. 成交量验证 (0-2): 近3周均量>前5周110% / >105%
      4. 收盘动量 (0-2): 收>MA5且MA5向上 / 二者之一
      5. MA10方向 (0-1): 当前MA10 > 3周前MA10

    参数:
        daily_df: 日线DataFrame（与weekly_closes二选一，优先使用本参数）
        weekly_closes: 周线收盘价数组（与daily_df二选一）
        weekly_volumes: 周线成交量数组（可选）

    返回:
        {
            "resonance_score": 0-10,
            "resonance_level": str,  # 强/较强/中等/弱/极弱
            "weekly_l1_score": 0-4,  # 兼容旧字段
            "factors": {ma_alignment, macd, volume, momentum, ma10_direction},
            "details": {w_ma5, w_ma10, w_ma20, dif, vol_ratio, ...}
        }
    """
    # ── 获取周线数据 ──
    if weekly_closes is not None:
        wk_closes = weekly_closes
        wk_volumes = weekly_volumes
    elif daily_df is not None:
        df_temp = daily_df.copy()
        df_temp["date_dt"] = pd.to_datetime(df_temp["date"])
        df_temp["week"] = df_temp["date_dt"].dt.isocalendar().week.astype(str) \
            + "-" + df_temp["date_dt"].dt.isocalendar().year.astype(str)
        agg_map = {"close": "last"}
        if "volume" in df_temp.columns:
            agg_map["volume"] = "sum"
        weekly_df = df_temp.groupby("week").agg(agg_map).reset_index()
        wk_closes = weekly_df["close"].values
        wk_volumes = weekly_df["volume"].values if "volume" in weekly_df.columns else None
    else:
        return {
            "resonance_score": 0, "resonance_level": "极弱", "weekly_l1_score": 0,
            "factors": {"ma_alignment": 0, "macd": 0, "volume": 0, "momentum": 0, "ma10_direction": 0},
            "details": {"reason": "未提供数据"},
        }

    if len(wk_closes) < 10:
        return {
            "resonance_score": 0, "resonance_level": "极弱", "weekly_l1_score": 0,
            "factors": {"ma_alignment": 0, "macd": 0, "volume": 0, "momentum": 0, "ma10_direction": 0},
            "details": {"reason": f"不足10周数据(当前{len(wk_closes)}周)"},
        }

    # ── 通用计算 ──
    w_ma5 = float(np.mean(wk_closes[-5:]))
    w_ma10 = float(np.mean(wk_closes[-10:]))
    details = {"w_ma5": round(w_ma5, 2), "w_ma10": round(w_ma10, 2)}

    resonance_score = 0
    factors = {"ma_alignment": 0, "macd": 0, "volume": 0, "momentum": 0, "ma10_direction": 0}

    # ── 因子1: MA趋势对齐 (0-3) ──
    if w_ma5 > w_ma10:
        gap_pct = (w_ma5 - w_ma10) / w_ma10 * 100
        # 检查MA20
        if len(wk_closes) >= 20:
            w_ma20 = float(np.mean(wk_closes[-20:]))
            details["w_ma20"] = round(w_ma20, 2)
            if w_ma10 > w_ma20:
                factors["ma_alignment"] = 3  # MA5>MA10>MA20
            elif gap_pct > 2:
                factors["ma_alignment"] = 2  # MA5>MA10 且 gap>2%
            else:
                factors["ma_alignment"] = 1
        else:
            if gap_pct > 2:
                factors["ma_alignment"] = 2
            else:
                factors["ma_alignment"] = 1
    resonance_score += factors["ma_alignment"]

    # ── 因子2: MACD多头 (0-2) ──
    if len(wk_closes) >= 30:
        closes_f = wk_closes.astype(float)
        ema12 = [float(closes_f[0])]
        ema26 = [float(closes_f[0])]
        for k in range(1, len(closes_f)):
            ema12.append(ema12[-1] * 11/13 + float(closes_f[k]) * 2/13)
            ema26.append(ema26[-1] * 25/27 + float(closes_f[k]) * 2/27)
        dif = ema12[-1] - ema26[-1]
        dif_prev = ema12[-2] - ema26[-2] if len(ema12) >= 2 else 0
        details["dif"] = round(dif, 4)
        if dif > 0:
            if dif > dif_prev:
                factors["macd"] = 2  # DIF>0 且 上升
            else:
                factors["macd"] = 1  # DIF>0
    resonance_score += factors["macd"]

    # ── 因子3: 成交量验证 (0-2) ──
    if wk_volumes is not None and len(wk_volumes) >= 15:
        recent_vol = float(np.mean(wk_volumes[-3:]))
        prev_vol = float(np.mean(wk_volumes[-8:-3]))
        vol_ratio = recent_vol / prev_vol if prev_vol > 0 else 1.0
        details["vol_ratio"] = round(vol_ratio, 2)
        if vol_ratio > 1.10:
            factors["volume"] = 2
        elif vol_ratio > 1.05:
            factors["volume"] = 1
    resonance_score += factors["volume"]

    # ── 因子4: 收盘动量 (0-2) ──
    close_above_ma5 = wk_closes[-1] > w_ma5
    # MA5斜率: 比较近5周均值与之前5周均值
    if len(wk_closes) >= 15:
        ma5_slope_up = float(np.mean(wk_closes[-5:])) > float(np.mean(wk_closes[-10:-5]))
    else:
        ma5_slope_up = wk_closes[-1] > wk_closes[-6] if len(wk_closes) >= 6 else False
    details["close_above_ma5"] = bool(close_above_ma5)
    details["ma5_slope_up"] = bool(ma5_slope_up)
    if close_above_ma5 and ma5_slope_up:
        factors["momentum"] = 2
    elif close_above_ma5 or ma5_slope_up:
        factors["momentum"] = 1
    resonance_score += factors["momentum"]

    # ── 因子5: MA10方向 (0-1) ──
    if len(wk_closes) >= 13:
        ma10_before = float(np.mean(wk_closes[-13:-3]))
        ma10_up = w_ma10 > ma10_before
        details["ma10_up"] = bool(ma10_up)
        if ma10_up:
            factors["ma10_direction"] = 1
        resonance_score += factors["ma10_direction"]

    # ── 综合评定 ──
    if resonance_score >= 8:
        level = "强"
    elif resonance_score >= 6:
        level = "较强"
    elif resonance_score >= 4:
        level = "中等"
    elif resonance_score >= 2:
        level = "弱"
    else:
        level = "极弱"

    # 兼容旧字段: weekly_l1_score (0-4, 映射check_weekly_l1的评分)
    wk_score = 1 if w_ma5 > w_ma10 else 0  # MA5>MA10
    wk_score += factors.get("ma10_direction", 0)
    wk_score += 1 if factors.get("macd", 0) > 0 else 0
    wk_score += 1 if factors.get("volume", 0) > 0 else 0

    result = {
        "resonance_score": resonance_score,
        "resonance_level": level,
        "weekly_l1_score": wk_score,
        "factors": factors,
        "details": details,
    }
    return result
