"""
Step 1: 周线定势 — 市场四季判断
====================================
判断市场处于: 冬 → 冬末春初 → 春 → 夏 → 秋

右侧确认信号（冬末春初）需满足至少 3/5 项:
  1. 周K线连续2周站上5周均线
  2. MACD在零轴下方金叉或即将金叉
  3. 周成交量连续2周放大
  4. 周K线突破下降趋势线
  5. 周KDJ金叉且J值从低位拐头向上
"""
import logging
from typing import Optional, Tuple

import pandas as pd

from ..data_sources.baostock_source import BaoStockSource
from ..utils.indicators import (
    calc_ma, calc_macd, calc_kdj_simple,
    check_macd_golden_cross, check_kdj_golden_cross,
    check_volume_expansion,
)
from ..utils.config import CONFIG

logger = logging.getLogger(__name__)

# 市场阶段枚举
PHASE_WINTER = "冬"
PHASE_WINTER_TO_SPRING = "冬末春初"
PHASE_SPRING = "春"
PHASE_SUMMER = "夏"
PHASE_AUTUMN = "秋"


class MarketPhaseResult:
    """市场阶段判定结果"""

    def __init__(self):
        self.phase: str = PHASE_WINTER
        self.confidence: int = 0          # 右侧确认信号触发的数量 (0-5)
        self.signals: dict = {
            "站上5周均线": False,
            "MACD金叉": False,
            "成交量放大": False,
            "突破下降趋势线": False,
            "KDJ金叉": False,
        }
        self.suggested_position: float = 0.0
        self.description: str = ""

    def to_dict(self) -> dict:
        return {
            "phase": self.phase,
            "confidence": f"{self.confidence}/5",
            "signals": self.signals,
            "suggested_position": f"{self.suggested_position*100:.0f}%",
            "description": self.description,
        }


class MarketPhaseAnalyzer:
    """
    市场阶段分析器

    使用方式:
        analyzer = MarketPhaseAnalyzer()
        result = analyzer.analyze(index_code="sh000001")
        print(result.phase)  # "冬" / "冬末春初" / "春" / "夏" / "秋"
    """

    def __init__(self):
        self._bs: Optional[BaoStockSource] = None

    def analyze(self, index_code: str = "sh000001") -> MarketPhaseResult:
        """
        执行周线定势分析

        参数:
            index_code: 指数代码，默认上证指数
        """
        result = MarketPhaseResult()

        with BaoStockSource() as bs:
            # 获取周K线（需要至少26周数据用于MACD计算）
            weekly = bs.get_index_weekly(index_code, start_date="")
            if weekly.empty or len(weekly) < 26:
                logger.warning(f"周线数据不足（{len(weekly)}行），无法准确判断市场阶段")
                result.description = "数据不足"
                return result

            # 计算技术指标
            weekly = self._calc_indicators(weekly)

            # 获取最近一行数据
            latest = weekly.iloc[-1]
            prev = weekly.iloc[-2] if len(weekly) >= 2 else latest

            # 逐一检查右侧确认信号
            self._check_ma_signal(weekly, result)
            self._check_macd_signal(weekly, result)
            self._check_volume_signal(weekly, result)
            self._check_trendline_signal(weekly, result)
            self._check_kdj_signal(weekly, result)

            # 综合判定市场阶段
            result.confidence = sum(1 for v in result.signals.values() if v)

            # 判定市场阶段
            result.phase = self._determine_phase(weekly, result.confidence)

            # 确定建议仓位
            result.suggested_position = self._get_suggested_position(result.phase)

            # 生成描述
            result.description = self._generate_description(result)

        return result

    # ──────────────────────────────────────────────
    # 技术指标计算
    # ──────────────────────────────────────────────

    @staticmethod
    def _calc_indicators(weekly: pd.DataFrame) -> pd.DataFrame:
        """计算周线级别的技术指标"""
        df = weekly.copy()

        # 5周均线
        df["ma5"] = calc_ma(df, period=5, col="close")

        # MACD
        df["dif"], df["dea"], df["macd"] = calc_macd(df, fast=12, slow=26, signal=9, col="close")

        # KDJ
        df["k"], df["d"], df["j"] = calc_kdj_simple(df, n=9)

        return df

    # ──────────────────────────────────────────────
    # 信号检查
    # ──────────────────────────────────────────────

    @staticmethod
    def _check_ma_signal(weekly: pd.DataFrame, result: MarketPhaseResult):
        """信号1: 周K线连续2周站上5周均线"""
        if len(weekly) < 2:
            return
        latest_two = weekly.tail(2)
        # 收盘价 > 5周均线
        if (latest_two["close"] > latest_two["ma5"]).all():
            result.signals["站上5周均线"] = True

    @staticmethod
    def _check_macd_signal(weekly: pd.DataFrame, result: MarketPhaseResult):
        """信号2: MACD在零轴下方金叉或即将金叉"""
        dif = weekly["dif"]
        dea = weekly["dea"]

        # 检查是否金叉
        if check_macd_golden_cross(dif, dea):
            result.signals["MACD金叉"] = True
        # 或者即将金叉（DIF在DEA下方但非常接近）
        elif len(dif) >= 2 and dif.iloc[-1] < dea.iloc[-1]:
            gap = abs(dif.iloc[-1] - dea.iloc[-1])
            avg_price = weekly["close"].iloc[-1]
            if avg_price > 0 and gap / avg_price < 0.005:  # 差距小于0.5%
                result.signals["MACD金叉"] = True

    @staticmethod
    def _check_volume_signal(weekly: pd.DataFrame, result: MarketPhaseResult):
        """信号3: 周成交量连续2周放大"""
        volume = weekly["volume"]
        if len(volume) >= 6:
            # 最近2周 vs 之前4周均值
            recent_2 = volume.iloc[-2:].mean()
            prev_4 = volume.iloc[-6:-2].mean()
            if prev_4 > 0 and recent_2 > prev_4 * 1.2:  # 放量20%以上
                result.signals["成交量放大"] = True

    @staticmethod
    def _check_trendline_signal(weekly: pd.DataFrame, result: MarketPhaseResult):
        """信号4: 突破下降趋势线（简化版：最近3个高点连线）"""
        if len(weekly) < 20:
            return

        # 取最近20周的收盘价
        recent = weekly.tail(20).copy()
        # 找3个阶段性高点
        high_points = []
        for i in range(1, len(recent) - 1):
            if (recent["high"].iloc[i] > recent["high"].iloc[i - 1] and
                    recent["high"].iloc[i] > recent["high"].iloc[i + 1]):
                high_points.append((i, recent["high"].iloc[i]))

        if len(high_points) < 3:
            # 高点半不够，改用简化的趋势线判断
            # 如果最近收盘价 > 20周期前的收盘价，视为突破
            if recent["close"].iloc[-1] > recent["close"].iloc[0]:
                result.signals["突破下降趋势线"] = True
            return

        # 取最近3个高点
        last_3_highs = high_points[-3:]
        # 计算趋势线斜率
        x_vals = [p[0] for p in last_3_highs]
        y_vals = [p[1] for p in last_3_highs]
        if len(x_vals) >= 2:
            slope = (y_vals[-1] - y_vals[0]) / (x_vals[-1] - x_vals[0]) if x_vals[-1] != x_vals[0] else 0
            # 斜率由负转正 = 突破下降趋势
            if slope > 0 or (slope > -0.5 and recent["close"].iloc[-1] > y_vals[-1]):
                result.signals["突破下降趋势线"] = True

    @staticmethod
    def _check_kdj_signal(weekly: pd.DataFrame, result: MarketPhaseResult):
        """信号5: 周KDJ金叉且J值从低位拐头向上"""
        k = weekly["k"]
        d = weekly["d"]
        j = weekly["j"]

        # KDJ金叉
        if check_kdj_golden_cross(k, d):
            result.signals["KDJ金叉"] = True
        # 或J值从低位(<20)拐头向上
        elif len(j) >= 2 and j.iloc[-2] < 20 and j.iloc[-1] > j.iloc[-2]:
            result.signals["KDJ金叉"] = True

    # ──────────────────────────────────────────────
    # 综合判定
    # ──────────────────────────────────────────────

    @staticmethod
    def _determine_phase(weekly: pd.DataFrame, confidence: int) -> str:
        """根据信号数量和K线形态综合判定市场阶段"""
        latest = weekly.iloc[-1]
        prev = weekly.iloc[-2] if len(weekly) >= 2 else latest

        # 检查放量滞涨 / 顶背离（秋的特征）
        if len(weekly) >= 3:
            recent_3 = weekly.tail(3)
            price_up = recent_3["close"].iloc[-1] > recent_3["close"].iloc[0]
            volume_up = recent_3["volume"].iloc[-1] > recent_3["volume"].iloc[0]
            if not price_up and volume_up:
                # 放量滞涨
                if confidence <= 2:
                    return PHASE_AUTUMN

        # 检查加速远离5周均线（夏的特征）
        ma5 = latest.get("ma5", 0)
        close = latest["close"]
        if ma5 > 0 and (close - ma5) / ma5 > 0.08:  # 偏离8%以上
            if confidence >= 3:
                return PHASE_SUMMER

        # 根据右侧确认信号数量判定
        if confidence >= 3:
            # 检查是否多头排列（春的特征）
            if len(weekly) >= 3:
                ma5_now = latest.get("ma5", 0)
                # 简单的多头判断
                if ma5_now > 0 and close > ma5_now:
                    return PHASE_SPRING
            return PHASE_WINTER_TO_SPRING
        elif confidence == 2:
            return PHASE_WINTER_TO_SPRING
        else:
            return PHASE_WINTER

    @staticmethod
    def _get_suggested_position(phase: str) -> float:
        """根据市场阶段返回建议仓位"""
        cfg = CONFIG.position
        position_map = {
            PHASE_WINTER: cfg.winter_max,
            PHASE_WINTER_TO_SPRING: cfg.spring_early_min,
            PHASE_SPRING: cfg.spring_min,
            PHASE_SUMMER: cfg.summer_max,
            PHASE_AUTUMN: cfg.autumn_max,
        }
        return position_map.get(phase, 0.0)

    @staticmethod
    def _generate_description(result: MarketPhaseResult) -> str:
        """生成阶段描述"""
        phase_descriptions = {
            PHASE_WINTER: "市场处于下跌阶段，空仓观望，坚决不做左侧抄底",
            PHASE_WINTER_TO_SPRING: "右侧确认信号触发，市场即将转暖，开始逐步建仓",
            PHASE_SPRING: "市场处于上升初期，积极加仓，持有为主",
            PHASE_SUMMER: "市场处于主升阶段，持有现有仓位，逐步减仓锁定收益",
            PHASE_AUTUMN: "市场出现见顶信号，准备清仓离场",
        }
        return phase_descriptions.get(result.phase, "未知阶段")
