"""
首板250后低吸跟踪器
======================
首板250模式不是当天买入，而是在首板之后的回调中找低吸机会。

晓胜波段王策略:
  激进型: 回踩5日线不破（强势回调，首板后3-5天）
  稳健型: 回踩10日线企稳（正常回调，5-10天）
  保守型: 回调至年线附近（深度回调，6-15天）
"""
import logging
import json
import os
from typing import Optional, List, Dict
from datetime import datetime, timedelta

import pandas as pd
import numpy as np

from ..data_sources.baostock_source import BaoStockSource
from ..utils.config import CONFIG

logger = logging.getLogger(__name__)

# 默认持久化文件
TRACKER_FILE = "post_first_board_tracker.json"


class PostFirstBoardTracker:
    """
    首板250后低吸跟踪器

    跟踪首板250标的的回调进度，在回踩至关键均线时发出买入信号。
    三种低吸方式:
      1. 激进(aggressive) — 回踩5日线不破，回调3-5%
      2. 稳健(moderate) — 回踩10日线企稳，回调5-8%
      3. 保守(conservative) — 回调至年线附近，回调8%+
    """

    def __init__(self, tracker_file: str = TRACKER_FILE):
        self._tracker_file = tracker_file
        self._tracked: Dict[str, Dict] = {}
        self._load()

    # ── 公开接口 ──

    def add(self, symbol: str, name: str, breakout_price: float,
            ma250: float = 0, sector: str = ""):
        """记录一个新的首板250标的开始跟踪"""
        today = datetime.now().strftime("%Y-%m-%d")
        self._tracked[symbol] = {
            "symbol": symbol,
            "name": name,
            "breakout_date": today,
            "breakout_price": breakout_price,
            "ma250_at_breakout": ma250,
            "highest_since": breakout_price,
            "lowest_since": breakout_price,
            "days_since": 0,
            "sector": sector,
            "status": "tracking",   # tracking / buy_signal / discarded
            "signal_type": "",
        }
        self._save()
        logger.info(f"首板250开始跟踪: {name}({symbol}) 突破价{breakout_price:.2f}")

    def add_from_match(self, match):
        """从 PatternMatch 对象添加跟踪"""
        if match.pattern_type == "A" and match.ma250_price > 0:
            self.add(
                symbol=match.symbol,
                name=match.name,
                breakout_price=match.latest_close,
                ma250=match.ma250_price,
                sector=match.sector,
            )

    def update_all(self) -> List[Dict]:
        """
        更新所有跟踪标的，检查回调进度

        返回: 触发买入信号的标的列表
        """
        signals = []
        cfg = CONFIG.xiaosheng

        for symbol, record in list(self._tracked.items()):
            if record["status"] != "tracking":
                continue

            try:
                df = self._get_data(symbol)
                if df is None or df.empty:
                    continue

                closes = df["close"].values
                highs = df["high"].values
                lows = df["low"].values
                latest_close = float(closes[-1])

                # 更新最高最低
                record["highest_since"] = max(record["highest_since"], float(max(highs)))
                record["lowest_since"] = min(record["lowest_since"], float(min(lows)))
                record["days_since"] += 1

                # 计算均线
                close_series = df["close"]
                ma5 = float(close_series.tail(5).mean())
                ma10 = float(close_series.tail(10).mean()) if len(close_series) >= 10 else ma5
                ma250 = record.get("ma250_at_breakout", 0)

                # 距年线距离
                dist_to_ma250 = ((latest_close - ma250) / ma250 * 100) if ma250 > 0 else 999

                # 回撤幅度
                pullback = (record["highest_since"] - latest_close) / record["highest_since"] * 100

                # 检查三种信号
                signal = None
                pb = pullback

                # 激进: 回踩5日线不破
                if (pb >= cfg.pb_aggressive_pullback
                        and latest_close >= ma5 * 0.98
                        and record["days_since"] <= 10):
                    signal = self._make_signal(
                        record, "aggressive", latest_close,
                        f"回踩5日线不破(回撤{pb:.1f}%)", ma5, ma10, ma250, pb
                    )

                # 稳健: 回踩10日线企稳
                if (signal is None and pb >= cfg.pb_moderate_pullback
                        and latest_close >= ma10 * 0.98
                        and record["days_since"] <= 15):
                    signal = self._make_signal(
                        record, "moderate", latest_close,
                        f"回踩10日线企稳(回撤{pb:.1f}%)", ma5, ma10, ma250, pb
                    )

                # 保守: 回调至年线附近
                if (signal is None and pb >= cfg.pb_conservative_pullback
                        and abs(dist_to_ma250) < 5):
                    signal = self._make_signal(
                        record, "conservative", latest_close,
                        f"回调至年线附近(距年线{dist_to_ma250:.1f}%)", ma5, ma10, ma250, pb
                    )

                # 淘汰: 超过最大跟踪天数
                if signal is None and record["days_since"] > cfg.pb_max_tracking_days:
                    record["status"] = "discarded"
                    logger.info(f"首板后跟踪超时淘汰: {record['name']}({symbol})")

                if signal:
                    record["status"] = "buy_signal"
                    signals.append(signal)
                    logger.info(f"🔔 首板后低吸信号: {record['name']}({symbol}) - {signal['type']}")

                # 已有信号的, 检查是否回调到位后重新上涨
                buy_signaled = [s for s in signals if s["symbol"] == symbol]
                if not buy_signaled:
                    pass  # no signal this round

            except Exception as e:
                logger.warning(f"首板后跟踪更新失败 {symbol}: {e}")

        self._save()
        return signals

    def get_tracking_list(self) -> List[Dict]:
        """获取所有仍在跟踪的标的列表"""
        return [r for r in self._tracked.values() if r["status"] == "tracking"]

    def get_signals_list(self) -> List[Dict]:
        """获取所有已发出信号的标的列表"""
        return [r for r in self._tracked.values() if r["status"] == "buy_signal"]

    def cleanup_old(self, days: int = 60):
        """清理超过指定天数的已淘汰记录"""
        cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        to_delete = []
        for symbol, record in self._tracked.items():
            if record.get("status") == "discarded":
                if record.get("breakout_date", "") < cutoff:
                    to_delete.append(symbol)
        for symbol in to_delete:
            del self._tracked[symbol]
        if to_delete:
            self._save()
            logger.info(f"清理了{len(to_delete)}条过期跟踪记录")

    # ── 内部方法 ──

    def _get_data(self, symbol: str) -> Optional[pd.DataFrame]:
        """获取跟踪标的的最新日线数据"""
        try:
            start = (datetime.now() - timedelta(days=45)).strftime("%Y-%m-%d")
            with BaoStockSource() as bs:
                df = bs.get_stock_daily(symbol, start_date=start)
            return df
        except Exception as e:
            logger.debug(f"首板后获取数据失败 {symbol}: {e}")
            return None

    def _make_signal(self, record: Dict, signal_type: str,
                     current_price: float, reason: str,
                     ma5: float, ma10: float, ma250: float,
                     pullback_pct: float) -> Dict:
        """构造买入信号"""
        return {
            "symbol": record["symbol"],
            "name": record["name"],
            "type": signal_type,
            "reason": reason,
            "current_price": current_price,
            "breakout_price": record["breakout_price"],
            "ma5": ma5,
            "ma10": ma10,
            "ma250": ma250,
            "pullback_pct": pullback_pct,
            "days_since": record["days_since"],
            "sector": record["sector"],
        }

    def _save(self):
        """持久化跟踪数据"""
        try:
            with open(self._tracker_file, "w", encoding="utf-8") as f:
                json.dump(self._tracked, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.warning(f"首板后数据保存失败: {e}")

    def _load(self):
        """加载持久化数据"""
        try:
            if os.path.exists(self._tracker_file):
                with open(self._tracker_file, "r", encoding="utf-8") as f:
                    self._tracked = json.load(f)
        except Exception as e:
            logger.warning(f"首板后数据加载失败: {e}")
