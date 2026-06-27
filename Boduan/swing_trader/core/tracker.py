"""
Step 6: 走势跟踪
==================
将标的状态标记为: 观察中 / 可介入 / 已介入 / 已了结
动态监控走势变化。
"""
import logging
import json
import os
from typing import Optional, List, Dict
from datetime import datetime

import pandas as pd

from ..data_sources.akshare_source import AKShareSource
from ..utils.config import CONFIG

logger = logging.getLogger(__name__)

# 状态枚举
STATUS_WATCHING = "观察中"
STATUS_READY = "可介入"
STATUS_ENTERED = "已介入"
STATUS_EXITED = "已了结"
STATUS_DISCARDED = "已淘汰"


class TrackedStock:
    """跟踪的标的"""

    def __init__(self):
        self.symbol: str = ""
        self.name: str = ""
        self.status: str = STATUS_WATCHING
        self.pattern_type: str = ""           # A / B / C / D / E
        self.entry_date: Optional[str] = None
        self.exit_date: Optional[str] = None
        self.entry_price: float = 0.0
        self.current_price: float = 0.0
        self.stop_loss: float = 0.0           # 止损价
        self.watch_start: str = ""             # 开始观察日期
        self.notes: str = ""
        self.resonance_level: str = "低"
        self.risk_level: str = "无"
        # 乘胜追击（晓胜策略加仓）
        self.highest_price: float = 0.0        # 介入后最高价
        self.total_added_pct: float = 0.0      # 已加仓比例（占初始资金）
        self.follow_up_count: int = 0          # 加仓次数


class Tracker:
    """
    走势跟踪器

    使用方式:
        tracker = Tracker()
        # 添加跟踪标的
        tracker.add("000001", "平安银行", pattern_type="A")
        # 更新所有标的状态
        tracker.update_all()
        # 获取可介入列表
        ready = tracker.get_ready_stocks()
    """

    def __init__(self, data_file: str = "tracker_data.json"):
        self._ak = AKShareSource()
        self._data_file = data_file
        self._stocks: Dict[str, TrackedStock] = {}
        self._load()

    # ──────────────────────────────────────────────
    # 增删改查
    # ──────────────────────────────────────────────

    def add(self, symbol: str, name: str, pattern_type: str = "",
            resonance_level: str = "低", risk_level: str = "无",
            notes: str = "") -> TrackedStock:
        """添加跟踪标的"""
        stock = TrackedStock()
        stock.symbol = symbol
        stock.name = name
        stock.pattern_type = pattern_type
        stock.resonance_level = resonance_level
        stock.risk_level = risk_level
        stock.notes = notes
        stock.watch_start = datetime.now().strftime("%Y-%m-%d")
        stock.status = STATUS_WATCHING

        self._stocks[symbol] = stock
        self._save()
        logger.info(f"添加跟踪: {name}({symbol})")
        return stock

    def remove(self, symbol: str):
        """移除跟踪标的"""
        if symbol in self._stocks:
            name = self._stocks[symbol].name
            del self._stocks[symbol]
            self._save()
            logger.info(f"移除跟踪: {name}({symbol})")

    def mark_entered(self, symbol: str, price: float, date: Optional[str] = None):
        """标记为已介入"""
        if symbol in self._stocks:
            stock = self._stocks[symbol]
            stock.status = STATUS_ENTERED
            stock.entry_price = price
            stock.entry_date = date or datetime.now().strftime("%Y-%m-%d")
            stock.highest_price = price  # 初始化最高价
            stock.stop_loss = round(price * 0.97, 2)  # 默认止损3%
            self._save()

    def mark_exited(self, symbol: str, price: float, date: Optional[str] = None):
        """标记为已了结"""
        if symbol in self._stocks:
            stock = self._stocks[symbol]
            stock.status = STATUS_EXITED
            stock.exit_date = date or datetime.now().strftime("%Y-%m-%d")
            stock.current_price = price
            self._save()

    def mark_discarded(self, symbol: str, reason: str = ""):
        """标记为已淘汰"""
        if symbol in self._stocks:
            stock = self._stocks[symbol]
            stock.status = STATUS_DISCARDED
            stock.notes = reason
            self._save()

    def get(self, symbol: str) -> Optional[TrackedStock]:
        """获取指定标的信息"""
        return self._stocks.get(symbol)

    def list_all(self) -> List[TrackedStock]:
        """获取所有跟踪标的"""
        return list(self._stocks.values())

    def get_by_status(self, status: str) -> List[TrackedStock]:
        """按状态筛选"""
        return [s for s in self._stocks.values() if s.status == status]

    def get_ready_stocks(self) -> List[TrackedStock]:
        """获取可介入的标的"""
        return self.get_by_status(STATUS_READY)

    def get_active_stocks(self) -> List[TrackedStock]:
        """获取活跃跟踪（观察中 + 可介入 + 已介入）"""
        return [
            s for s in self._stocks.values()
            if s.status in (STATUS_WATCHING, STATUS_READY, STATUS_ENTERED)
        ]

    # ──────────────────────────────────────────────
    # 乘胜追击加仓（晓胜波段王策略）
    # ──────────────────────────────────────────────

    def check_follow_up_signals(self) -> List[Dict]:
        """
        晓胜"乘胜追击"加仓信号检测

        条件:
          1. 买入后涨幅 > 10%
          2. 从最高点回撤至5日线附近（约-3%）
          3. 总加仓不超过预备队2成上限（total_added_pct < 20%）
          4. 加仓不超过2次

        返回: 可加仓的标的列表
        """
        cfg = CONFIG.xiaosheng
        signals = []

        for symbol, stock in self._stocks.items():
            if stock.status != STATUS_ENTERED:
                continue
            if stock.entry_price <= 0:
                continue

            # 条件1: 买入后涨幅 > 10%
            gain_pct = (stock.current_price - stock.entry_price) / stock.entry_price * 100
            if gain_pct < cfg.follow_up_gain_threshold:
                continue

            # 条件2: 总加仓不超过预备队2成上限
            if stock.total_added_pct >= cfg.follow_up_max_add_pct:
                continue

            # 条件3: 加仓不超过2次
            if stock.follow_up_count >= 2:
                continue

            # 条件4: 从最高点回撤至5日线附近（回撤约-3%）
            if stock.highest_price > stock.current_price:
                pullback = (stock.highest_price - stock.current_price) / stock.highest_price * 100
                if pullback >= abs(cfg.follow_up_ma5_reentry):
                    signals.append({
                        "symbol": symbol,
                        "name": stock.name,
                        "entry_price": stock.entry_price,
                        "gain_pct": round(gain_pct, 1),
                        "current_price": stock.current_price,
                        "highest_price": stock.highest_price,
                        "pullback_pct": round(pullback, 1),
                        "follow_up_count": stock.follow_up_count,
                        "total_added_pct": stock.total_added_pct,
                        "reason": (
                            f"涨幅+{gain_pct:.1f}%后回撤{pullback:.1f}%"
                            f"（已加仓{stock.follow_up_count}次/上限2次）"
                        ),
                    })

        return signals

    def get_follow_up_signals(self) -> List[Dict]:
        """获取所有已介入标的的加仓信号（简版）"""
        return self.check_follow_up_signals()

    # ──────────────────────────────────────────────
    # 状态更新
    # ──────────────────────────────────────────────

    def update_all(self) -> List[str]:
        """
        更新所有跟踪标的的最新价格和状态

        返回: 状态发生变化的标的列表
        """
        changed = []

        for symbol, stock in self._stocks.items():
            if stock.status in (STATUS_EXITED, STATUS_DISCARDED):
                continue  # 已结束的不再更新

            try:
                df = self._ak.get_stock_daily(
                    symbol,
                    start_date=(datetime.now() - timedelta(days=5)).strftime("%Y%m%d"),
                )
                if df.empty:
                    continue

                latest = df.iloc[-1]
                new_price = float(latest.get("收盘", stock.current_price))
                old_price = stock.current_price
                stock.current_price = new_price

                # 更新最高价（用于加仓判断）
                if stock.status == STATUS_ENTERED:
                    if new_price > stock.highest_price:
                        stock.highest_price = new_price

                # 状态迁移判断
                old_status = stock.status
                new_status = self._decide_status(stock, df)

                if new_status != old_status:
                    stock.status = new_status
                    changed.append(f"{stock.name}({symbol}): {old_status} → {new_status}")
                    logger.info(f"状态变更: {stock.name}({symbol}) {old_status} → {new_status}")

            except Exception as e:
                logger.warning(f"更新跟踪状态失败 ({symbol}): {e}")

        self._save()
        return changed

    @staticmethod
    def _decide_status(stock: TrackedStock, df: pd.DataFrame) -> str:
        """
        根据最新K线判断状态

        规则:
          - 已介入 → 检查是否触发止损（跌3%）→ 已了结
          - 观察中 → 检查是否出现买点信号 → 可介入
          - 已介入 → 正常持有
          - 超过3个交易日未启动 → 淘汰
        """
        if stock.status == STATUS_ENTERED:
            # 检查止损
            if stock.stop_loss > 0 and stock.current_price < stock.stop_loss:
                return STATUS_EXITED
            return STATUS_ENTERED

        if stock.status == STATUS_WATCHING:
            # 检查观察期
            if stock.watch_start:
                try:
                    start = datetime.strptime(stock.watch_start, "%Y-%m-%d")
                    days_watched = (datetime.now() - start).days
                    if days_watched > 5:
                        return STATUS_DISCARDED
                except (ValueError, TypeError):
                    pass

            # 检查买点信号: 早盘放量突破
            if len(df) >= 2:
                latest = df.iloc[-1]
                prev = df.iloc[-2]

                pct = latest.get("涨跌幅", 0)
                volume = latest.get("成交量", 0)
                prev_volume = prev.get("成交量", 0)

                if (pd.notna(pct) and pct > 2 and
                        pd.notna(volume) and pd.notna(prev_volume) and
                        prev_volume > 0 and volume > prev_volume * 1.3):
                    return STATUS_READY

        return stock.status

    # ──────────────────────────────────────────────
    # 持久化
    # ──────────────────────────────────────────────

    def _save(self):
        """保存跟踪数据到文件"""
        try:
            data = {}
            for symbol, stock in self._stocks.items():
                data[symbol] = {
                    "symbol": stock.symbol,
                    "name": stock.name,
                    "status": stock.status,
                    "pattern_type": stock.pattern_type,
                    "entry_date": stock.entry_date,
                    "exit_date": stock.exit_date,
                    "entry_price": stock.entry_price,
                    "current_price": stock.current_price,
                    "stop_loss": stock.stop_loss,
                    "watch_start": stock.watch_start,
                    "notes": stock.notes,
                    "resonance_level": stock.resonance_level,
                    "risk_level": stock.risk_level,
                    "highest_price": stock.highest_price,
                    "total_added_pct": stock.total_added_pct,
                    "follow_up_count": stock.follow_up_count,
                }

            os.makedirs(os.path.dirname(self._data_file) or ".", exist_ok=True)
            with open(self._data_file, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

        except Exception as e:
            logger.warning(f"保存跟踪数据失败: {e}")

    def _load(self):
        """从文件加载跟踪数据"""
        try:
            if not os.path.exists(self._data_file):
                return

            with open(self._data_file, "r", encoding="utf-8") as f:
                data = json.load(f)

            for symbol, item in data.items():
                stock = TrackedStock()
                for key, value in item.items():
                    if hasattr(stock, key):
                        setattr(stock, key, value)
                self._stocks[symbol] = stock

        except Exception as e:
            logger.warning(f"加载跟踪数据失败: {e}")
