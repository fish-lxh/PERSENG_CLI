"""
Step 3: 个股形态扫描
======================
在通过持续性验证的板块中筛选符合条件的个股。

筛选条件（三层过滤）:
  第1层 (L1): 个股周线处于"春"阶段（周线多头排列，上升初期）
    3选2: A=站上5周均线, B=55>21>13>5多头排列, C=MACD金叉或零轴上

  第2层 (L2): 按形态分别检测

  形态A: 日线上穿250年线 + 涨幅>9.9% + 量比>1
  形态B: 日线上影线 + 涨幅>3.8% + 量比>2 + 平台突破（试盘突破信号）
  形态C: 连续小阳线上涨9天 + 成交量小幅放大 + 年线上方
"""
import logging
from typing import Optional, List, Tuple
from datetime import datetime, timedelta

import pandas as pd
import numpy as np

from ..data_sources.akshare_source import AKShareSource
from ..data_sources.baostock_source import BaoStockSource
from ..utils.indicators import calc_ma, calc_macd, get_ma_value, check_weekly_l1, calc_weekly_resonance
from ..utils.config import CONFIG
from .confidence import score_match

logger = logging.getLogger(__name__)


class PatternMatch:
    """形态匹配结果"""

    def __init__(self):
        self.symbol: str = ""
        self.name: str = ""
        self.pattern_type: str = ""        # "A" / "B" / "C" / "D" / "E" / "F"
        self.confidence: str = ""           # "高" / "中" / "低"
        self.sector: str = ""               # 所属板块
        self.description: str = ""
        self.latest_close: float = 0.0
        self.latest_pct: float = 0.0
        self.above_250ma: bool = False      # 是否在250年线上方
        self.weekly_phase: str = ""         # 个股周线阶段
        # 新高模式专用 (Pattern D)
        self.is_new_high: bool = False
        self.new_high_type: str = ""        # "历史新高" / "阶段新高"
        self.new_high_period_high: float = 0.0  # 阶段最高价
        self.ma5_price: float = 0.0             # 5日均线价格
        self.dist_to_ma5: float = 0.0           # 距5日线百分比
        # 首板250追踪专用 (Pattern A 增强)
        self.days_since_cross: int = 0          # 穿越年线天数
        self.ma250_price: float = 0.0           # 年线价格
        self.dist_to_ma250: float = 0.0         # 距年线百分比
        self.vol_ratio: float = 0.0             # 量比
        # 大牛有形增强字段
        self.ma144_price: float = 0.0            # 144半年线价格
        self.above_ma144: bool = False           # 是否在144半年线上方
        self.dist_to_ma144: float = 0.0          # 距144线百分比
        # 统一置信度评分 (Phase 3)
        self.confidence_score: int = 0            # 0-100 数值评分
        self.ma250_pos_in_body: float = 0.5       # 250线在实体位置(仅A)
        self.shadow_ratio: float = 0.0            # 上影线占比(仅B)
        self.consecutive_up: int = 0              # 连涨天数(仅C)
        self.total_pct: float = 0.0               # 连涨累计涨幅(仅C)
        self.yesterday_pct: float = 0.0           # 前日涨跌幅(仅E)
        self.engulf_ratio: float = 0.0            # 反包覆盖比例(仅E)
        self.first_pct: float = 0.0               # 首阳涨幅(仅F)
        self.all_bearish_interim: bool = False    # 中间全阴(仅F)
        self.interim_vol_ratio: float = 1.0       # 中间缩量比(仅F)
        self.last_vol_ratio: float = 0.0          # 末根量比(仅F)
        # 多周期共振评分 (Phase 4)
        self.weekly_resonance_score: int = 0       # 0-10 周线共振评分
        self.weekly_resonance_level: str = ""      # 强/较强/中等/弱/极弱


class PatternScanner:
    """
    个股形态扫描器

    使用方式:
        scanner = PatternScanner()
        matches = scanner.scan_in_sectors(["人工智能", "半导体"])
    """

    # 形态检测顺序（同回测引擎一致）
    CHECK_ORDER = ["D", "A", "B", "C", "E", "F"]

    def __init__(self):
        self._ak = AKShareSource()
        # 缓存当前正在扫描的股票的日线数据（scan_stock 内预取）
        self._cached_daily: Optional[pd.DataFrame] = None
        # 多周期共振缓存 (Phase 4)
        self._weekly_resonance: Optional[dict] = None

    def close(self):
        """释放资源"""
        self._cached_daily = None
        self._weekly_resonance = None

    def __del__(self):
        """析构时自动释放资源"""
        self.close()

    # ──────────────────────────────────────────────
    # 条件1: 个股周线是否处于"春"阶段
    # ──────────────────────────────────────────────

    def _check_weekly_spring(self, symbol: str,
                              weekly: Optional[pd.DataFrame] = None) -> Tuple[bool, str]:
        """
        检查个股周线是否处于"春"阶段（多头排列，上升初期）

        判断标准:
          - 周K线在5周均线上方运行
          - MACD处于金叉或零轴上方
          - 均线开始发散（多头排列初期）

        参数:
            symbol: 股票代码
            weekly: 预取的周线数据（scan_stock 内部传入），None 则自动获取
        """
        if weekly is None:
            # 未传入预取数据，独立获取（兼容外部直接调用）
            try:
                weekly = self._ak.get_stock_weekly(symbol)
                if weekly is not None and not weekly.empty:
                    weekly.rename(columns={
                        "日期": "date", "开盘": "open", "收盘": "close",
                        "最高": "high", "最低": "low", "成交量": "volume",
                    }, inplace=True)
            except Exception as e:
                logger.debug(f"AKShare周线获取失败 {symbol}: {e}")
                weekly = None

            if weekly is None or weekly.empty or len(weekly) < 10:
                try:
                    df_daily = self._get_stock_daily_safe(symbol, days_back=400)
                    if df_daily is not None and not df_daily.empty and len(df_daily) >= 60:
                        df_daily = df_daily.copy()
                        df_daily["date"] = pd.to_datetime(df_daily["date"])
                        df_daily["week"] = df_daily["date"].dt.isocalendar().week.astype(str) \
                            + "-" + df_daily["date"].dt.isocalendar().year.astype(str)
                        weekly = df_daily.groupby("week").agg({
                            "open": "first", "close": "last",
                            "high": "max", "low": "min",
                            "volume": "sum",
                        }).reset_index()
                        weekly.rename(columns={"week": "date"}, inplace=True)
                except Exception as e:
                    logger.debug(f"日线合成周线失败 {symbol}: {e}")

        if weekly is None or weekly.empty or len(weekly) < 10:
            return False, "周线数据不足10周"

        # 使用多条件L1评分系统
        wk_closes = weekly["close"].values
        wk_volumes = weekly["volume"].values if "volume" in weekly.columns else None
        passed, score, details = check_weekly_l1(weekly_closes=wk_closes, weekly_volumes=wk_volumes)

        if passed:
            return True, details.get("reason", f"L1评分{score}/4")

        return False, details.get("reason", f"L1评分{score}/4")

    # ──────────────────────────────────────────────
    # 条件2: 日线是否在250年线上方
    # ──────────────────────────────────────────────

    def _get_stock_daily_safe(self, symbol: str, days_back: int = 400) -> pd.DataFrame:
        """
        安全获取个股日线数据（缓存优先 → BaoStock → AKShare 降级）

        统一返回列（英文）: date, open, close, high, low, volume, amount, pctChg
        """
        # 缓存优先：如果 scan_stock 已经预取了日线数据，直接使用
        if self._cached_daily is not None and not self._cached_daily.empty:
            return self._cached_daily

        # 直连 BaoStock
        try:
            start = (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")
            with BaoStockSource() as bs:
                df = bs.get_stock_daily(symbol, start_date=start)
            if df is not None and not df.empty and len(df) >= 20:
                return df
        except Exception as e:
            logger.debug(f"BaoStock 获取日线失败 {symbol}: {e}")

        # 降级: AKShare
        try:
            df = self._ak.get_stock_daily(
                symbol,
                start_date=(datetime.now() - timedelta(days=days_back)).strftime("%Y%m%d"),
            )
            if df is not None and not df.empty:
                # 统一列名为英文
                rename_map = {
                    "日期": "date", "开盘": "open", "收盘": "close",
                    "最高": "high", "最低": "low", "成交量": "volume",
                    "成交额": "amount", "涨跌幅": "pctChg",
                    "涨跌额": "change", "换手率": "turn",
                    "振幅": "amplitude",
                }
                df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns},
                          inplace=True)
                return df
        except Exception as e:
            logger.debug(f"AKShare 获取日线失败 {symbol}: {e}")

        return pd.DataFrame()

    def _check_above_250ma(self, symbol: str) -> Tuple[bool, float, float]:
        """
        检查日线收盘价是否在250年线上方
        需要获取约1年的日线数据

        返回: (above_250: bool, ma250_price: float, distance_pct: float)
              distance_pct > 0 表示在年线上方，< 0 表示在年线下方
        """
        try:
            df = self._get_stock_daily_safe(symbol, days_back=400)
            if df.empty or len(df) < 250:
                return False, 0.0, 0.0

            # 计算250日均线
            close_series = df["close"]
            ma250 = close_series.rolling(window=250).mean()

            latest_close = float(close_series.iloc[-1])
            latest_ma250 = float(ma250.iloc[-1])

            if pd.isna(latest_ma250) or latest_ma250 == 0:
                return False, 0.0, 0.0

            distance_pct = (latest_close - latest_ma250) / latest_ma250
            return latest_close > latest_ma250, latest_ma250, distance_pct

        except Exception as e:
            logger.debug(f"250年线检查失败 {symbol}: {e}")
            return False, 0.0, 0.0

    # ──────────────────────────────────────────────
    # 形态A: 日线上穿250年线 + 涨幅>9.9% + 量比>1
    # ──────────────────────────────────────────────

    def _check_pattern_a(self, symbol: str, name: str = "",
                         sector: str = "") -> Optional[PatternMatch]:
        """
        检查形态A: 首板250（晓胜策略）
        当天涨停 + 涨停阳线实体穿越250日均线 + 量比>1

        条件:
          1. 当天涨停（涨幅 ≥ 9.9%）
          2. 涨停阳线实体刚好穿越250日均线（开盘<250线<收盘）
          3. 量比 > 1（今日量 > 20日均量）
        """
        try:
            df = self._get_stock_daily_safe(symbol, days_back=400)
            if df.empty or len(df) < 260:
                return None

            latest = df.iloc[-1]
            cfg = CONFIG.pattern

            # 条件1: 当天涨停（涨幅 ≥ 9.9%）
            pct = latest.get("pctChg", 0)
            if pd.isna(pct) or pct < cfg.pattern_a_pct_threshold:
                return None

            open_p = float(latest.get("open", 0))
            close_p = float(latest.get("close", 0))
            if open_p <= 0 or close_p <= 0:
                return None

            # 必须是阳线（涨停必然是阳线）
            if close_p <= open_p:
                return None

            # 计算250年线
            close_series = df["close"]
            ma250 = close_series.rolling(window=250).mean()
            latest_ma250 = float(ma250.iloc[-1])
            if pd.isna(latest_ma250) or latest_ma250 <= 0:
                return None

            # 条件2: 涨停阳线实体刚好穿越250日均线
            # 250日线应在开盘价和收盘价之间（开<250线<收）
            # 确保是"首板穿越"，而非站上年线后的再次涨停
            body_bottom = min(open_p, close_p)
            body_top = max(open_p, close_p)
            if not (body_bottom < latest_ma250 < body_top):
                return None

            # 条件3: 量比 > 1（今日量 / 20日均量）
            volume = float(latest.get("volume", 0))
            if volume <= 0:
                return None
            prev_volumes = df["volume"].tail(21).iloc[:-1]
            avg_volume = float(prev_volumes.mean()) if len(prev_volumes) > 0 else 0
            vol_ratio = volume / avg_volume if avg_volume > 0 else 0
            # 用户要求量比>1，若配置更高则用配置值
            required_vol = max(1.0, cfg.pattern_a_vol_ratio)
            if vol_ratio < required_vol:
                return None

            # 计算250日线在阳线实体中的位置比例（判断穿越的精确度）
            body_height = body_top - body_bottom
            ma250_pos_in_body = (latest_ma250 - body_bottom) / body_height if body_height > 0 else 0.5
            # 250线在实体中部30%-70%区间 = 最佳穿越
            perfect_cross = 0.3 <= ma250_pos_in_body <= 0.7

            # 量比充足也是加分项
            strong_volume = vol_ratio >= 2.0

            if perfect_cross and strong_volume:
                confidence = "高"
            elif perfect_cross or strong_volume:
                confidence = "中"
            else:
                confidence = "低"

            desc = (f"首板250(涨幅{pct:.1f}%，量比{vol_ratio:.1f}，"
                    f"250线在实体{ma250_pos_in_body*100:.0f}%位置)")

            # 计算持续站上年线天数（辅助信息）
            days_since = 0
            for i in range(1, min(30, len(df))):
                ma250_val = float(ma250.iloc[-i]) if not pd.isna(ma250.iloc[-i]) else 0
                if float(df.iloc[-i].get("close", 0)) > ma250_val:
                    days_since = i
                else:
                    break

            match = PatternMatch()
            match.symbol = symbol
            match.name = name or symbol
            match.pattern_type = "A"
            match.sector = sector
            match.latest_close = close_p
            match.latest_pct = float(pct)
            match.confidence = confidence
            match.description = desc
            match.above_250ma = True
            match.weekly_phase = "春"
            # 首板250追踪
            match.days_since_cross = days_since
            match.ma250_price = latest_ma250
            match.dist_to_ma250 = (close_p - latest_ma250) / latest_ma250 * 100
            match.vol_ratio = vol_ratio
            # 大牛有形
            ma144_val = get_ma_value(closes_arr, 144)
            match.ma144_price = round(ma144_val, 2) if ma144_val else 0
            match.above_ma144 = ma144_val is not None and close_p > ma144_val
            match.dist_to_ma144 = round((close_p - ma144_val) / ma144_val * 100, 2) if ma144_val and ma144_val > 0 else 0
            # 统一置信度评分
            match.ma250_pos_in_body = ma250_pos_in_body
            # 多周期共振评分 (Phase 4)
            if self._weekly_resonance:
                match.weekly_resonance_score = self._weekly_resonance["resonance_score"]
                match.weekly_resonance_level = self._weekly_resonance["resonance_level"]
                match.weekly_l1_score = self._weekly_resonance.get("weekly_l1_score", 0)
            result = score_match("A", match.__dict__)
            match.confidence_score = result["score"]
            match.confidence = result["level"]
            logger.info(f"  ✅ {name}({symbol}) 形态A {result['level']}({result['score']}分): {desc}")
            return match

        except Exception as e:
            logger.debug(f"形态A检查失败 {symbol}: {e}")
            return None

    # ──────────────────────────────────────────────
    # 形态B: 上影线+涨幅>3.8%+量比>2+平台突破（试盘突破）
    # ──────────────────────────────────────────────

    def _check_pattern_b(self, symbol: str, name: str = "",
                         sector: str = "") -> Optional[PatternMatch]:
        """
        检查形态B:
        上影线 + 涨幅>3.8% + 量比>2 + 平台突破（试盘突破信号）

        判断条件:
          1. 当日涨幅 >= 3.8%
          2. 上影线: 上影线长度 / 总振幅 >= 30%
          3. 突破平台: 今日最高价 > 过去20日最高价
          4. 放量: 量比 > 2（今日量 >= 20日均量 × 2）
        """
        try:
            cfg = CONFIG.pattern
            df = self._get_stock_daily_safe(symbol, days_back=60)
            if df.empty or len(df) < cfg.pattern_b_platform_days + 5:
                return None

            latest = df.iloc[-1]

            # 条件1: 当日涨幅 >= 3.8%
            pct = latest.get("pctChg", 0)
            if pd.isna(pct) or pct < cfg.pattern_b_pct_threshold:
                return None

            open_p = float(latest.get("open", 0))
            close_p = float(latest.get("close", 0))
            high_p = float(latest.get("high", 0))
            low_p = float(latest.get("low", 0))

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
            prev_highs = df.iloc[-cfg.pattern_b_platform_days:-1]["high"]
            if prev_highs.empty:
                return None
            platform_high = float(prev_highs.max())
            if high_p <= platform_high:
                return None

            # 条件4: 放量（量比 > 2）
            volume = float(latest.get("volume", 0))
            if volume <= 0:
                return None
            prev_volumes = df.iloc[-cfg.pattern_b_platform_days:-1]["volume"]
            if prev_volumes.empty:
                return None
            avg_volume = float(prev_volumes.mean())
            vol_ratio = volume / avg_volume if avg_volume > 0 else 0
            if vol_ratio < cfg.pattern_b_vol_ratio:
                return None

            # 判断置信度
            if pct >= 7 and shadow_ratio >= 0.4 and vol_ratio >= 3:
                confidence = "高"
                desc_suffix = "强势试盘突破"
            else:
                confidence = "中"
                desc_suffix = "试盘突破"

            match = PatternMatch()
            match.symbol = symbol
            match.name = name or symbol
            match.pattern_type = "B"
            match.sector = sector
            match.latest_close = close_p
            match.latest_pct = float(pct)
            match.confidence = confidence
            match.description = (
                f"上影线{desc_suffix} "
                f"(涨幅{pct:.1f}%，上影线占比{shadow_ratio:.0%}，量比{vol_ratio:.1f})"
            )
            match.above_250ma = True
            match.weekly_phase = "春"
            # 大牛有形
            closes_arr = df["close"].values
            ma144_val = get_ma_value(closes_arr, 144)
            match.ma144_price = round(ma144_val, 2) if ma144_val else 0
            match.above_ma144 = ma144_val is not None and close_p > ma144_val
            match.dist_to_ma144 = round((close_p - ma144_val) / ma144_val * 100, 2) if ma144_val and ma144_val > 0 else 0
            # 统一置信度评分
            match.shadow_ratio = shadow_ratio
            # 多周期共振评分 (Phase 4)
            if self._weekly_resonance:
                match.weekly_resonance_score = self._weekly_resonance["resonance_score"]
                match.weekly_resonance_level = self._weekly_resonance["resonance_level"]
                match.weekly_l1_score = self._weekly_resonance.get("weekly_l1_score", 0)
            result = score_match("B", match.__dict__)
            match.confidence_score = result["score"]
            match.confidence = result["level"]
            logger.info(f"  ✅ {name}({symbol}) 形态B {result['level']}({result['score']}分): {match.description}")
            return match

        except Exception as e:
            logger.debug(f"形态B检查失败 {symbol}: {e}")
            return None

    # ──────────────────────────────────────────────
    # 形态C: 连续小阳线上涨9天+成交量小幅放大+年线上方
    # ──────────────────────────────────────────────

    def _check_pattern_c(self, symbol: str, name: str = "",
                         sector: str = "") -> Optional[PatternMatch]:
        """
        检查形态C:
        连续小阳线上涨9天 + 成交量小幅放大 + 年线上方

        判断条件:
          1. 连续9天小阳线上涨（0.1% <= 单日涨幅 <= 5.0%）
          2. 成交量小幅放大（末端3日均量 > 前期均量）
          3. 收盘价在250年线上方
        """
        try:
            cfg = CONFIG.pattern
            df = self._get_stock_daily_safe(symbol, days_back=45)
            if df.empty or len(df) < cfg.pattern_c_days + 5:
                return None

            # 从后往前统计连续小阳天数
            recent = df.tail(cfg.pattern_c_days + 5)
            consecutive_up = 0
            for i in range(len(recent) - 1, -1, -1):
                pct = recent.iloc[i].get("pctChg", 0)
                if pd.notna(pct) and cfg.pattern_c_min_daily_pct <= pct <= cfg.pattern_c_max_daily_pct:
                    consecutive_up += 1
                else:
                    break

            if consecutive_up < cfg.pattern_c_days:
                return None

            # 条件2: 成交量小幅放大
            volumes = recent.tail(cfg.pattern_c_days)["volume"]
            if len(volumes) >= 3:
                last_3_avg = float(volumes.tail(3).mean())
                prev_avg = float(volumes.iloc[:-3].mean())
                vol_ratio = last_3_avg / prev_avg if prev_avg > 0 else 1.0
            else:
                vol_ratio = 1.0

            # 条件3: 年线上方
            latest_close = float(recent.iloc[-1].get("close", 0))
            if latest_close <= 0:
                return None

            close_series = df["close"]
            ma250 = close_series.rolling(window=250).mean()
            latest_ma250 = float(ma250.iloc[-1]) if len(ma250) > 0 else 0
            if pd.isna(latest_ma250) or latest_ma250 <= 0:
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

            match = PatternMatch()
            match.symbol = symbol
            match.name = name or symbol
            match.pattern_type = "C"
            match.sector = sector
            match.latest_close = latest_close
            match.latest_pct = float(recent.iloc[-1].get("pctChg", 0))
            match.confidence = confidence
            match.description = desc
            match.above_250ma = True
            match.weekly_phase = "春"
            # 大牛有形
            closes_arr = df["close"].values
            ma144_val = get_ma_value(closes_arr, 144)
            match.ma144_price = round(ma144_val, 2) if ma144_val else 0
            match.above_ma144 = ma144_val is not None and latest_close > ma144_val
            match.dist_to_ma144 = round((latest_close - ma144_val) / ma144_val * 100, 2) if ma144_val and ma144_val > 0 else 0
            # 统一置信度评分
            match.consecutive_up = consecutive_up
            total_pct = 0.0
            recent_start = len(recent) - consecutive_up
            if recent_start >= 0:
                start_close = float(recent.iloc[recent_start]["close"])
                total_pct = (latest_close / start_close - 1) * 100 if start_close > 0 else 0
            match.total_pct = round(total_pct, 2)
            # 多周期共振评分 (Phase 4)
            if self._weekly_resonance:
                match.weekly_resonance_score = self._weekly_resonance["resonance_score"]
                match.weekly_resonance_level = self._weekly_resonance["resonance_level"]
                match.weekly_l1_score = self._weekly_resonance.get("weekly_l1_score", 0)
            result = score_match("C", match.__dict__)
            match.confidence_score = result["score"]
            match.confidence = result["level"]
            logger.info(f"  ✅ {name}({symbol}) 形态C {result['level']}({result['score']}分): {desc}")
            return match

        except Exception as e:
            logger.debug(f"形态C检查失败 {symbol}: {e}")
            return None

    # ──────────────────────────────────────────────
    # 形态D: 新高模式 — 晓胜波段王核心策略
    # ──────────────────────────────────────────────

    def _check_pattern_d(self, symbol: str, name: str = "",
                         sector: str = "") -> Optional[PatternMatch]:
        """
        检查形态D: 新高模式（晓胜波段王核心策略）

        两种类型:
          1. 历史新高 — 股价创上市以来新高（如上不封顶）
          2. 阶段新高 — 股价来到近N个月高点附近（重点关注）

        晓胜操作三要点:
          ① 带止损博弈
          ② 贴着5日线博弈，止损在5日线下5%
          ③ 乘胜追击，预备队2成上限
        """
        try:
            cfg = CONFIG.pattern
            # 需要750天数据计算阶段新高
            df = self._get_stock_daily_safe(symbol, days_back=750)
            if df.empty or len(df) < 500:
                return None

            latest = df.iloc[-1]
            closes = df["close"].values
            highs = df["high"].values
            volumes = df["volume"].values if "volume" in df.columns else None

            latest_close = float(closes[-1])
            if latest_close <= 0:
                return None

            # 计算5日线
            close_series = df["close"]
            ma5_series = close_series.rolling(window=5).mean()
            latest_ma5 = float(ma5_series.iloc[-1])
            if pd.isna(latest_ma5) or latest_ma5 <= 0:
                return None
            dist_to_ma5 = (latest_close - latest_ma5) / latest_ma5 * 100

            # 条件1: 距5日线不能太远（晓胜: 贴着5日线博弈）
            if dist_to_ma5 > cfg.pattern_d_max_ma5_deviation:
                return None

            # 计算阶段新高: 回溯N个月的最高价
            lookback_days = min(cfg.pattern_d_lookback_months * 20, len(closes) - 60)
            period_high = float(np.max(highs[-lookback_days:]))

            # 全量历史新高
            all_time_high = float(np.max(highs))
            is_all_time_high = latest_close >= all_time_high * 0.99

            # 距阶段高点距离（负值=还没突破，正值=已突破）
            dist_to_period_high = (latest_close - period_high) / period_high * 100

            # 判定: 距阶段高点 -3% ~ +5% 范围内视为新高模式
            is_near_high = -3 <= dist_to_period_high <= 5
            if not is_near_high:
                return None

            # 量比检查
            vol_ratio = 1.0
            if volumes is not None and len(volumes) >= 20:
                vol = float(volumes[-1])
                avg_vol = float(np.mean(volumes[-21:-1]))
                vol_ratio = vol / avg_vol if avg_vol > 0 else 1.0

            if vol_ratio < cfg.pattern_d_min_vol_ratio:
                return None

            # 判断类型和置信度
            if is_all_time_high:
                new_high_type = "历史新高"
                confidence = "高" if vol_ratio >= 2 else "中"
                desc = (f"历史新高突破(距5日线{dist_to_ma5:.1f}%|"
                        f"量比{vol_ratio:.1f})")
            else:
                new_high_type = "阶段新高"
                confidence = "高" if vol_ratio >= 1.5 else "中"
                desc = (f"阶段新高(距{cfg.pattern_d_lookback_months}月高点"
                        f"{dist_to_period_high:.1f}%|距5日线{dist_to_ma5:.1f}%|"
                        f"量比{vol_ratio:.1f})")

            match = PatternMatch()
            match.symbol = symbol
            match.name = name or symbol
            match.pattern_type = "D"
            match.sector = sector
            match.latest_close = latest_close
            match.latest_pct = float(latest.get("pctChg", 0))
            match.confidence = confidence
            match.description = desc
            match.above_250ma = True
            match.weekly_phase = "春"
            match.is_new_high = True
            match.new_high_type = new_high_type
            match.new_high_period_high = period_high
            match.ma5_price = latest_ma5
            match.dist_to_ma5 = dist_to_ma5
            match.vol_ratio = vol_ratio
            # 大牛有形
            ma144_val = get_ma_value(closes, 144)
            match.ma144_price = round(ma144_val, 2) if ma144_val else 0
            match.above_ma144 = ma144_val is not None and latest_close > ma144_val
            match.dist_to_ma144 = round((latest_close - ma144_val) / ma144_val * 100, 2) if ma144_val and ma144_val > 0 else 0
            # 统一置信度评分
            # 多周期共振评分 (Phase 4)
            if self._weekly_resonance:
                match.weekly_resonance_score = self._weekly_resonance["resonance_score"]
                match.weekly_resonance_level = self._weekly_resonance["resonance_level"]
                match.weekly_l1_score = self._weekly_resonance.get("weekly_l1_score", 0)
            result = score_match("D", match.__dict__)
            match.confidence_score = result["score"]
            match.confidence = result["level"]
            logger.info(f"  ✅ {name}({symbol}) 形态D({new_high_type}) {result['level']}({result['score']}分): {desc}")
            return match

        except Exception as e:
            logger.debug(f"形态D新高检查失败 {symbol}: {e}")
            return None

    # ──────────────────────────────────────────────
    # 形态E: 反包博弈K线 — 晓胜波段王策略
    # ──────────────────────────────────────────────

    def _check_pattern_e(self, symbol: str, name: str = "",
                         sector: str = "") -> Optional[PatternMatch]:
        """
        检查形态E: 大跌反包（晓胜波段王策略）

        条件:
          1. 前一天跌幅 > 4%
          2. 今日阳线实体覆盖昨日阴线实体 ≥ 70%
          3. 量比 ≥ 1.5（放量确认）
          4. 周线MA5 > MA10（中期趋势向上）
        """
        try:
            df = self._get_stock_daily_safe(symbol, days_back=400)
            if df.empty or len(df) < 20:
                return None
            if len(df) < 3:
                return None

            latest = df.iloc[-1]
            prev = df.iloc[-2]
            cfg = CONFIG.pattern

            closes = df["close"].values
            opens = df["open"].values
            volumes = df["volume"].values if "volume" in df.columns else None

            today_open = float(opens[-1])
            today_close = float(closes[-1])
            yesterday_open = float(opens[-2])
            yesterday_close = float(closes[-2])

            # ── 条件1: 前一天跌幅 > 4% ──
            yesterday_pct = (yesterday_close / float(closes[-3]) - 1) * 100 if len(closes) >= 3 else 0
            if yesterday_pct >= -4:
                return None

            # ── 条件2: 今日阳线反包覆盖 ≥ 70% ──
            is_yang = today_close > today_open
            if not is_yang or today_close <= 0:
                return None

            yesterday_entity = abs(yesterday_close - yesterday_open)
            if yesterday_entity <= 0:
                return None

            overlap_bottom = max(today_open, min(yesterday_open, yesterday_close))
            overlap_top = min(today_close, max(yesterday_open, yesterday_close))
            overlap = max(0, overlap_top - overlap_bottom)
            engulf_ratio = overlap / yesterday_entity

            if engulf_ratio < cfg.pattern_e_engulf_ratio:
                return None

            # ── 条件3: 放量确认（量比 ≥ 1.5） ──
            vol_ratio = 0
            if volumes is not None and len(volumes) >= 20:
                vol = float(volumes[-1])
                avg_vol = float(np.mean(volumes[-21:-1]))
                vol_ratio = vol / avg_vol if avg_vol > 0 else 0

            if vol_ratio < cfg.pattern_e_min_vol_ratio:
                return None

            # ── 条件5: MA20向上（若配置启用）──
            if cfg.pattern_e_require_ma20_up and len(closes) >= 25:
                close_series = df["close"]
                ma20 = close_series.rolling(window=20).mean()
                if len(ma20) >= 6 and not ma20.iloc[-6:].isna().any():
                    if float(ma20.iloc[-1]) <= float(ma20.iloc[-6]):
                        return None

            # 跌幅越大，置信度越高
            if yesterday_pct < -7:
                confidence = "高"
            elif yesterday_pct < -5.5:
                confidence = "中"
            else:
                confidence = "低"

            latest_pct = float(latest.get("pctChg", 0))

            match = PatternMatch()
            match.symbol = symbol
            match.name = name or symbol
            match.pattern_type = "E"
            match.sector = sector
            match.latest_close = today_close
            match.latest_pct = latest_pct
            match.confidence = confidence
            match.description = (
                f"大跌反包(前日跌{abs(yesterday_pct):.1f}%"
                f"|阳包阴覆盖{engulf_ratio:.0%}"
                f"|涨幅{latest_pct:.1f}%|量比{vol_ratio:.1f})"
            )
            match.above_250ma = True
            match.weekly_phase = "春"
            match.vol_ratio = vol_ratio
            # 大牛有形
            ma144_val = get_ma_value(closes, 144)
            match.ma144_price = round(ma144_val, 2) if ma144_val else 0
            match.above_ma144 = ma144_val is not None and today_close > ma144_val
            match.dist_to_ma144 = round((today_close - ma144_val) / ma144_val * 100, 2) if ma144_val and ma144_val > 0 else 0
            # 统一置信度评分
            match.yesterday_pct = round(yesterday_pct, 2)
            match.engulf_ratio = round(engulf_ratio, 2)
            # 多周期共振评分 (Phase 4)
            if self._weekly_resonance:
                match.weekly_resonance_score = self._weekly_resonance["resonance_score"]
                match.weekly_resonance_level = self._weekly_resonance["resonance_level"]
                match.weekly_l1_score = self._weekly_resonance.get("weekly_l1_score", 0)
            result = score_match("E", match.__dict__)
            match.confidence_score = result["score"]
            match.confidence = result["level"]
            logger.info(f"  ✅ {name}({symbol}) 形态E {result['level']}({result['score']}分): {match.description}")
            return match

        except Exception as e:
            logger.debug(f"形态E反包检查失败 {symbol}: {e}")
            return None

    # ──────────────────────────────────────────────
    # 形态F: 上升三法（周线版）— 晓胜波段王策略
    # ──────────────────────────────────────────────

    def _get_weekly_data(self, symbol: str, days_back: int = 400) -> Optional[pd.DataFrame]:
        """
        获取周线数据（从日线聚合）

        Returns:
            DataFrame with columns: date, open, close, high, low, volume
            注意: pctChg 由周收盘价计算得出（相对于前一周收盘）
        """
        df = self._get_stock_daily_safe(symbol, days_back=days_back)
        if df.empty or len(df) < 120:
            return None

        try:
            df = df.copy()
            df["date"] = pd.to_datetime(df["date"])
            # ISO 周数标识
            df["week"] = df["date"].dt.isocalendar().week.astype(str) \
                + "-" + df["date"].dt.isocalendar().year.astype(str)

            weekly = df.groupby("week").agg({
                "open": "first", "close": "last",
                "high": "max", "low": "min",
                "volume": "sum",
            }).reset_index()

            # 计算周涨跌幅
            weekly["pctChg"] = weekly["close"].pct_change() * 100
            weekly["pctChg"] = weekly["pctChg"].fillna(0)
            return weekly
        except Exception as e:
            logger.debug(f"日线合成周线失败 {symbol}: {e}")
            return None

    def _check_pattern_f(self, symbol: str, name: str = "",
                         sector: str = "") -> Optional[PatternMatch]:
        """
        检查形态F: 上升三法 — 周线版

        经典持续看涨K线组合，在周线级别识别:
          首阳(放量大阳线) → 2~5根缩量小K线(不破首阳低点) → 末根(放量突破首阳高点)

        相比日线版，周线级别的上升三法信号更少但更可靠，
        捕捉的是中长期的持续上涨趋势。

        条件（全部在周K线上判断）:
          1. 末根为阳线，涨幅≥3%，量比≥1.2（放量突破确认）
          2. 中间2~5根小K线，每根涨跌幅≤7%，且最低价≥首根最低价
          3. 首根为大阳线，涨幅≥4%，量能显著
          4. 中间K线缩量：每根量≤首根量的90%
          5. 末根收盘价>首根最高价（突破确认）
          （L1周线春阶段已保证中期多头趋势，不再单独要求年线）
        """
        try:
            cfg = CONFIG.pattern
            wk = self._get_weekly_data(symbol, days_back=400)
            if wk is None or len(wk) < 52:
                return None

            closes = wk["close"].values
            opens = wk["open"].values
            highs = wk["high"].values
            lows = wk["low"].values
            volumes = wk["volume"].values if "volume" in wk.columns else None
            pct_chg = wk["pctChg"].values if "pctChg" in wk.columns else None

            if volumes is None or pct_chg is None:
                return None
            if len(closes) < cfg.pattern_f_lookback_days + 5:
                return None

            # ── 从末根往前找 ──
            n = len(closes)

            # 条件1: 末根为阳线，涨幅≥min_last_pct
            idx_last = n - 1
            last_close = float(closes[idx_last])
            last_open = float(opens[idx_last])
            last_high = float(highs[idx_last])
            last_volume = float(volumes[idx_last])
            last_pct = float(pct_chg[idx_last]) if pct_chg is not None else 0

            if last_close <= last_open:
                return None
            if last_pct < cfg.pattern_f_min_last_pct:
                return None

            # 末根量比（vs 过去20周均量）
            if len(volumes) >= 21:
                avg_vol = float(np.mean(volumes[-22:-1]))
                last_vol_ratio = last_volume / avg_vol if avg_vol > 0 else 0
            elif len(volumes) >= 5:
                avg_vol = float(np.mean(volumes[:-1]))
                last_vol_ratio = last_volume / avg_vol if avg_vol > 0 else 0
            else:
                last_vol_ratio = 0
            if last_vol_ratio < cfg.pattern_f_last_vol_ratio:
                return None

            # ── 从idx_last-1开始往前找中间小K线 ──
            interim_start = None
            for i in range(idx_last - 1, max(0, idx_last - cfg.pattern_f_max_interim_days - 3), -1):
                pct = float(pct_chg[i]) if pct_chg is not None else 0
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

            # ── 首根大阳线（在interim_start-1位置） ──
            idx_first = interim_start - 1
            if idx_first < 0:
                return None

            first_close = float(closes[idx_first])
            first_open = float(opens[idx_first])
            first_high = float(highs[idx_first])
            first_low = float(lows[idx_first])
            first_volume = float(volumes[idx_first])
            first_pct = float(pct_chg[idx_first]) if pct_chg is not None else 0

            # 条件3: 首根为大阳线
            if first_close <= first_open:
                return None
            if first_pct < cfg.pattern_f_min_first_pct:
                return None

            # ── 验证条件2+4: 中间小K线 ──
            for i in range(interim_start, idx_last):
                if float(lows[i]) < first_low:
                    return None
                if float(volumes[i]) > first_volume * cfg.pattern_f_vol_shrink_ratio:
                    return None

            # ── 验证条件5: 末根收盘价>首根最高价（突破确认） ──
            if last_close <= first_high:
                return None

            # ── 判断置信度 ──
            all_bearish_interim = True
            for i in range(interim_start, idx_last):
                if float(closes[i]) >= float(opens[i]):
                    all_bearish_interim = False
                    break

            interim_vol_ratio = 1.0
            if first_volume > 0:
                interim_avg_vol = float(np.mean([float(volumes[i]) for i in range(interim_start, idx_last)]))
                interim_vol_ratio = interim_avg_vol / first_volume if first_volume > 0 else 1.0

            if all_bearish_interim and interim_vol_ratio < 0.5 and first_pct >= 7:
                confidence = "高"
                desc_suffix = "经典缩量回踩+放量突破"
            elif first_pct >= 7 and last_vol_ratio >= 2:
                confidence = "中"
                desc_suffix = "放量突破"
            else:
                confidence = "低"
                desc_suffix = "上升三法"

            desc = (
                f"上升三法(周线)(首阳{first_pct:.1f}%"
                f"|中间{interim_count}周缩量整理"
                f"|末涨{last_pct:.1f}%"
                f"|量比{last_vol_ratio:.1f})"
            )

            match = PatternMatch()
            match.symbol = symbol
            match.name = name or symbol
            match.pattern_type = "F"
            match.sector = sector
            match.latest_close = last_close
            match.latest_pct = last_pct
            match.confidence = confidence
            match.description = desc
            match.above_250ma = True
            match.weekly_phase = "春"
            match.vol_ratio = last_vol_ratio
            # 本周线级别不再计算144日均线
            match.ma144_price = 0
            match.above_ma144 = True
            match.dist_to_ma144 = 0
            # 统一置信度评分
            match.first_pct = round(first_pct, 2)
            match.all_bearish_interim = all_bearish_interim
            match.interim_vol_ratio = round(interim_vol_ratio, 2)
            match.last_vol_ratio = round(last_vol_ratio, 2)
            # 多周期共振评分 (Phase 4)
            if self._weekly_resonance:
                match.weekly_resonance_score = self._weekly_resonance["resonance_score"]
                match.weekly_resonance_level = self._weekly_resonance["resonance_level"]
                match.weekly_l1_score = self._weekly_resonance.get("weekly_l1_score", 0)
            result = score_match("F", match.__dict__)
            match.confidence_score = result["score"]
            match.confidence = result["level"]
            logger.info(f"  ✅ {name}({symbol}) 形态F(周线) {result['level']}({result['score']}分): {desc}")
            return match

        except Exception as e:
            logger.debug(f"形态F上升三法(周线)检查失败 {symbol}: {e}")
            return None

    # ──────────────────────────────────────────────
    # 综合扫描入口（三层过滤）
    # ──────────────────────────────────────────────

    def scan_stock(self, symbol: str, name: str = "",
                   sector: str = "") -> List[PatternMatch]:
        """
        对单只个股执行完整的三层过滤，返回所有匹配形态。

        在一个 Baostock 连接内批量获取日线+周线数据，
        所有形态检测共享缓存数据，避免重复 login/logout。

        第1层: 周线是否处于春阶段（L1）
        第2层: 运行全部6种形态检测，收集所有非None结果
        """
        # ── 批量获取数据（一次 BaoStock 连接）──
        weekly = None
        try:
            with BaoStockSource() as bs:
                # 取足够覆盖大多形态检测的天数（750d 仅形态D需要，单独请求）
                start_400 = (datetime.now() - timedelta(days=400)).strftime("%Y-%m-%d")
                daily_df = bs.get_stock_daily(symbol, start_date=start_400)
                if daily_df is not None and not daily_df.empty and len(daily_df) >= 20:
                    self._cached_daily = daily_df
                # 顺便取周线
                weekly = bs.get_stock_weekly(symbol, start_date="", adjust="2")
        except Exception:
            self._cached_daily = None
            weekly = None

        # 第1层过滤: 周线春阶段（传入预取的周线数据）
        is_spring, spring_reason = self._check_weekly_spring(symbol, weekly=weekly)
        if not is_spring:
            self._cached_daily = None
            logger.debug(f"{name}({symbol}) 周线非春阶段: {spring_reason}")
            return []

        # ── Phase 4: 计算多周期共振评分 ──
        if weekly is not None and not weekly.empty:
            self._weekly_resonance = calc_weekly_resonance(
                weekly_closes=weekly["close"].values,
                weekly_volumes=weekly["volume"].values if "volume" in weekly.columns else None,
            )
        else:
            self._weekly_resonance = None

        # 第2层: 运行全部6种形态检测
        pattern_checkers = [
            self._check_pattern_d,   # 新高模式
            self._check_pattern_a,   # 首板250
            self._check_pattern_b,   # 上影线试盘
            self._check_pattern_c,   # 小阳线爬升
            self._check_pattern_e,   # 反包博弈K线
            self._check_pattern_f,   # 上升三法
        ]

        matches = []
        for checker in pattern_checkers:
            match = checker(symbol, name, sector)
            if match:
                matches.append(match)

        # 清理缓存（下一个股票用新数据）
        self._cached_daily = None
        self._weekly_resonance = None

        if matches:
            types = "+".join(m.pattern_type for m in matches)
            logger.info(f"✅ {name}({symbol}) 通过三层过滤，匹配形态: {types}")
        else:
            logger.debug(f"{name}({symbol}) 通过L1周线春阶段但未匹配任何形态")

        return matches

    # ──────────────────────────────────────────────
    # 批量扫描
    # ──────────────────────────────────────────────

    def scan_in_sectors(self, sector_names: List[str],
                        top_n_per_sector: int = 30) -> List[PatternMatch]:
        """
        在指定板块内扫描（含三层过滤）

        参数:
            sector_names: 板块名称列表（已通过持续性验证）
            top_n_per_sector: 每个板块取前N只股票检查
        """
        all_matches = []

        for sector in sector_names:
            logger.info(f"   扫描板块: {sector}")
            try:
                stocks = self._get_sector_stocks(sector, top_n_per_sector)
                logger.info(f"   板块 {sector} 获取到 {len(stocks)} 只候选股")
                for code, name in stocks:
                    matches = self.scan_stock(code, name, sector)
                    if matches:
                        all_matches.extend(matches)
            except Exception as e:
                logger.warning(f"扫描板块 {sector} 失败: {e}")
                import traceback
                logger.debug(traceback.format_exc())
                continue

        # 按置信度排序
        confidence_order = {"高": 0, "中": 1, "低": 2}
        all_matches.sort(key=lambda m: confidence_order.get(m.confidence, 9))

        return all_matches

    # ──────────────────────────────────────────────
    # 辅助方法
    # ──────────────────────────────────────────────

    @staticmethod
    def _get_sector_stocks(sector_name: str, top_n: int = 30) -> List[tuple]:
        """
        获取概念板块内的成分股（代码, 名称）

        数据源优先级:
            1. 东方财富概念板块成分股 (stock_board_concept_cons_em)
            2. 板块异动数据 (stock_board_change_em)
            3. 概念板块资金流向 (stock_fund_flow_concept) — 含领涨股
            4. 行业板块实时行情 (stock_sector_spot)
        """
        stocks = []
        import akshare as ak
        import re

        # 板块名作为正则匹配时需转义特殊字符（如 (CPO)）
        _safe_name = re.escape(sector_name)

        # ── 尝试1: 东方财富成分股接口 ──
        try:
            sectors_df = ak.stock_board_concept_name_em()
            sector_row = sectors_df[sectors_df["板块名称"] == sector_name]
            if not sector_row.empty:
                sector_code = sector_row.iloc[0]["板块代码"]
                members = ak.stock_board_concept_cons_em(symbol=sector_code)
                if not members.empty:
                    if "涨跌幅" in members.columns:
                        members = members.sort_values("涨跌幅", ascending=False)
                    for _, row in members.head(top_n).iterrows():
                        stocks.append((row.get("股票代码", ""), row.get("股票名称", "")))
                    if stocks:
                        return stocks
        except Exception:
            logger.debug(f"东方财富成分股接口获取失败 ({sector_name})，尝试备选")

        # ── 尝试A2: 同花顺概念板块详情页（全成分股）──
        try:
            import requests as req_lib
            ths_sectors = ak.stock_board_concept_name_ths()
            if not ths_sectors.empty and "name" in ths_sectors.columns:
                matched = ths_sectors[ths_sectors["name"].str.contains(_safe_name, na=False, regex=True)]
                if not matched.empty:
                    ths_code = matched.iloc[0]["code"]
                    logger.info(f"从同花顺获取 {sector_name}({ths_code})")
                    url = f"http://q.10jqka.com.cn/gn/detail/code/{ths_code}/"
                    req_headers = {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Referer": "http://q.10jqka.com.cn/",
                    }
                    resp = req_lib.get(url, headers=req_headers, timeout=15)
                    codes_found = re.findall(r"(?:60[0135]\d{3}|00[0-3]\d{4}|30[01]\d{3}|688\d{3})", resp.text)
                    valid_codes = list(set(codes_found))
                    logger.info(f"  同花顺 {sector_name}: 找到 {len(valid_codes)} 只候选股")
                    if valid_codes:
                        for code in valid_codes[:top_n]:
                            stocks.append((code, ""))
                        return stocks
        except Exception as e:
            logger.debug(f"同花顺概念板块详情页获取失败 ({sector_name}): {e}")

        # ── 尝试3: 板块异动数据匹配（仅有领涨股）──
        try:
            change_df = ak.stock_board_change_em()
            if not change_df.empty and "板块名称" in change_df.columns:
                matched = change_df[change_df["板块名称"].str.contains(_safe_name, na=False, regex=True)]
                seen = set()
                for _, row in matched.iterrows():
                    code = row.get("板块异动最频繁个股及所属类型-股票代码", "")
                    name = row.get("板块异动最频繁个股及所属类型-股票名称", "")
                    if code and code not in seen:
                        seen.add(code)
                        stocks.append((code, name))
                if stocks:
                    logger.info(f"从板块异动数据获取 {sector_name}: {len(stocks)}只")
                    return stocks[:top_n]
        except Exception as e:
            logger.debug(f"板块异动数据获取失败: {e}")

        # ── 尝试4: 概念板块资金流向（仅领涨股名）──
        try:
            flow_df = ak.stock_fund_flow_concept()
            if not flow_df.empty and "行业" in flow_df.columns:
                matched = flow_df[flow_df["行业"].str.contains(_safe_name, na=False, regex=True)]
                if not matched.empty:
                    seen = set()
                    for _, row in matched.iterrows():
                        code = ""  # 资金流向接口不返回股票代码
                        name = row.get("领涨股", "")
                        if name and name not in seen:
                            seen.add(name)
                            stocks.append((code, name))
                    if stocks:
                        logger.info(f"从概念资金流向获取 {sector_name}: {len(stocks)}只")
                        return stocks[:top_n]
        except Exception as e:
            logger.debug(f"概念资金流向获取失败: {e}")

        # ── 尝试5: 行业板块实时行情（仅领涨股）──
        try:
            spot_df = ak.stock_sector_spot()
            if not spot_df.empty and "板块" in spot_df.columns:
                matched = spot_df[spot_df["板块"].str.contains(_safe_name, na=False, regex=True)]
                if not matched.empty:
                    row = matched.iloc[0]
                    code = row.get("股票代码", "")
                    name = row.get("股票名称", "")
                    if code:
                        stocks.append((code, name))
                        logger.info(f"从行业板块实时行情获取 {sector_name}: {name}({code})")
                        return stocks
        except Exception as e:
            logger.debug(f"行业板块实时行情获取失败: {e}")

        logger.warning(f"所有数据源均无法获取板块 {sector_name} 的成分股")
        return stocks
