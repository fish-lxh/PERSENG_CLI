"""
Step 4: 排雷引擎
==================
从业绩、公告、交易、板块四个维度进行排雷审查。

风险等级:
  - 🔴 致命雷 → 一票否决
  - 🔴 高风险 → 观察但不介入
  - 🟡 警告   → 仓位减半

数据源协同:
  - BaoStock → 业绩维度（净利润增长率、营收、商誉、ST状态）
  - AKShare  → 交易维度（龙虎榜、大宗交易折价率）
  - 特特股    → 公告维度（牛散减持信号）
"""
import logging
from typing import Optional, List, Dict
from datetime import datetime, timedelta

import pandas as pd

from ..data_sources.baostock_source import BaoStockSource
from ..data_sources.akshare_source import AKShareSource
from ..data_sources.tetegu_source import TeteguSource
from ..utils.config import CONFIG

logger = logging.getLogger(__name__)


class RiskResult:
    """排雷结果"""

    def __init__(self):
        self.symbol: str = ""
        self.name: str = ""
        self.risk_level: str = "无"           # 无 / 警告 / 高风险 / 致命
        self.risk_items: List[Dict] = []      # 具体的风险项
        self.details: Dict = {}                # 各维度详细数据

    def is_fatal(self) -> bool:
        return self.risk_level == "致命"

    def is_high_risk(self) -> bool:
        return self.risk_level in ("致命", "高风险")

    def to_summary(self) -> str:
        """生成排雷摘要"""
        if self.risk_level == "无":
            return f"✅ {self.symbol} {self.name}: 无风险"
        items_str = "; ".join([f"[{r['level']}] {r['detail']}" for r in self.risk_items])
        return f"{'🔴' if self.is_fatal() else '🟡'} {self.symbol} {self.name}: {self.risk_level} | {items_str}"


class RiskChecker:
    """
    排雷引擎 — 四维度风险排查

    使用方式:
        checker = RiskChecker()
        result = checker.check("000001")
        if result.is_fatal():
            print("一票否决!")
        elif result.is_high_risk():
            print("观察但不介入")
    """

    def __init__(self):
        self._ak = AKShareSource()
        self._ttg = TeteguSource()

    # ──────────────────────────────────────────────
    # 主入口
    # ──────────────────────────────────────────────

    def check(self, symbol: str, name: str = "") -> RiskResult:
        """
        对单个标的执行全维度排雷

        参数:
            symbol: 股票代码
            name: 股票名称（可选）
        """
        result = RiskResult()
        result.symbol = symbol
        result.name = name

        # 四维度排查
        self._check_financial(result)     # 业绩维度
        self._check_announcement(result)  # 公告维度
        self._check_trading(result)       # 交易维度
        self._check_sector(result)        # 板块维度

        # 晓胜风险信号（市场整体层面，仅对第一个标的执行一次以避免重复API调用）
        if not hasattr(self, '_xiaosheng_risk_checked'):
            self._check_xiaosheng_risk(result)
            self._xiaosheng_risk_checked = True

        # 综合评级
        result.risk_level = self._summarize_risk(result.risk_items)

        return result

    def batch_check(self, symbols: List[tuple]) -> List[RiskResult]:
        """
        批量排雷

        参数:
            symbols: [(股票代码, 股票名称), ...]
        """
        results = []
        for symbol, name in symbols:
            try:
                result = self.check(symbol, name)
                results.append(result)
            except Exception as e:
                logger.warning(f"排雷失败 {symbol}: {e}")
                # 排雷失败时不阻断流程，标记为警告
                fallback = RiskResult()
                fallback.symbol = symbol
                fallback.name = name
                fallback.risk_level = "警告"
                fallback.risk_items.append({
                    "dimension": "系统",
                    "level": "警告",
                    "detail": f"排雷执行异常: {e}",
                })
                results.append(fallback)
        return results

    # ──────────────────────────────────────────────
    # 维度1: 业绩排雷
    # ──────────────────────────────────────────────

    def _check_financial(self, result: RiskResult):
        """业绩维度排雷（BaoStock）"""
        cfg = CONFIG.risk

        try:
            with BaoStockSource() as bs:
                now = datetime.now()
                year = now.year
                quarter = (now.month - 1) // 3  # 当前季度

                # 取最近2个季度的数据
                for q_offset in range(2):
                    q = quarter - q_offset
                    y = year
                    if q <= 0:
                        q += 4
                        y -= 1

                    # 成长数据（净利润增长率、营收增长率）
                    growth = bs.get_growth_data(result.symbol, y, q)
                    if not growth.empty:
                        self._check_growth(result, growth)

                    # 资产负债表（商誉占比）
                    balance = bs.get_balance_data(result.symbol, y, q)
                    if not balance.empty:
                        self._check_balance(result, balance)

                # 业绩预告
                forecast = bs.get_forecast_report(result.symbol, year, quarter)
                if not forecast.empty:
                    self._check_forecast(result, forecast)

                # ST状态
                basic = bs.get_stock_basic(result.symbol)
                if basic:
                    self._check_st_status(result, basic)

        except Exception as e:
            logger.warning(f"业绩排雷异常 ({result.symbol}): {e}")
            result.risk_items.append({
                "dimension": "业绩",
                "level": "警告",
                "detail": f"财务数据获取失败: {e}",
            })

    def _check_growth(self, result: RiskResult, growth: pd.DataFrame):
        """检查成长指标"""
        cfg = CONFIG.risk

        # 净利润同比增长率
        if "YOYNI" in growth.columns:
            yoy_ni = pd.to_numeric(growth["YOYNI"].iloc[0], errors="coerce")
            if pd.notna(yoy_ni) and yoy_ni < cfg.profit_decline_threshold:
                result.risk_items.append({
                    "dimension": "业绩",
                    "level": "致命",
                    "detail": f"净利润同比下滑 {yoy_ni:.1f}%（阈值: {cfg.profit_decline_threshold}%）",
                })

        # 营业收入同比增长率
        if "YOYRevenue" in growth.columns:
            yoy_rev = pd.to_numeric(growth["YOYRevenue"].iloc[0], errors="coerce")
            if pd.notna(yoy_rev) and yoy_rev < cfg.revenue_decline_threshold:
                result.risk_items.append({
                    "dimension": "业绩",
                    "level": "警告",
                    "detail": f"营收同比下滑 {yoy_rev:.1f}%（阈值: {cfg.revenue_decline_threshold}%）",
                })

    def _check_balance(self, result: RiskResult, balance: pd.DataFrame):
        """检查资产负债表"""
        cfg = CONFIG.risk

        # 商誉占净资产比
        if "goodwillRatio" in balance.columns:
            goodwill_ratio = pd.to_numeric(balance["goodwillRatio"].iloc[0], errors="coerce")
            if pd.notna(goodwill_ratio) and goodwill_ratio > cfg.goodwill_ratio_threshold:
                result.risk_items.append({
                    "dimension": "业绩",
                    "level": "警告",
                    "detail": f"商誉占净资产 {goodwill_ratio:.1%}（阈值: {cfg.goodwill_ratio_threshold:.0%}）",
                })

    def _check_forecast(self, result: RiskResult, forecast: pd.DataFrame):
        """检查业绩预告"""
        # 业绩预告类型
        if "forecastType" in forecast.columns:
            ftype = str(forecast["forecastType"].iloc[0])
            if "首亏" in ftype or "续亏" in ftype or "预减" in ftype:
                result.risk_items.append({
                    "dimension": "业绩",
                    "level": "致命",
                    "detail": f"业绩预告: {ftype}",
                })
            elif "略减" in ftype:
                result.risk_items.append({
                    "dimension": "业绩",
                    "level": "警告",
                    "detail": f"业绩预告: {ftype}",
                })

        # 净利润变动（由盈转亏）
        if "profitContent" in forecast.columns:
            content = str(forecast["profitContent"].iloc[0])
            if "亏损" in content or "由盈转亏" in content:
                result.risk_items.append({
                    "dimension": "业绩",
                    "level": "致命",
                    "detail": f"业绩预告: 预计亏损",
                })

    def _check_st_status(self, result: RiskResult, basic: dict):
        """检查ST状态"""
        # 通过股票基本资料判断
        code = basic.get("code", "")
        if "ST" in code or result.name.startswith("ST") or result.name.startswith("*ST"):
            result.risk_items.append({
                "dimension": "业绩",
                "level": "致命",
                "detail": f"ST/*ST 状态",
            })

        # 通过 BaoStock K 线中的 isST 字段（在查询时已有）
        # 该检查在 get_kline 时通过 isST 字段定期捕获

    # ──────────────────────────────────────────────
    # 维度2: 公告排雷
    # ──────────────────────────────────────────────

    def _check_announcement(self, result: RiskResult):
        """公告维度排雷（特特股）"""
        try:
            # 特特股检查牛散减持信号
            if self._ttg.login():
                reduction = self._ttg.check_reduction_signal(result.symbol)

                if reduction.get("has_reduction"):
                    for item in reduction.get("niushan_reduction", []):
                        result.risk_items.append({
                            "dimension": "公告",
                            "level": "高风险",
                            "detail": f"牛散减持: {item.get('name', '未知')} ({item.get('change', '减持')})",
                        })

                if reduction.get("total_holder_trend") == "分散":
                    result.risk_items.append({
                        "dimension": "公告",
                        "level": "警告",
                        "detail": f"股东人数持续增加，筹码分散趋势",
                    })

        except Exception as e:
            logger.warning(f"公告排雷异常 ({result.symbol}): {e}")

    # ──────────────────────────────────────────────
    # 维度3: 交易排雷
    # ──────────────────────────────────────────────

    def _check_trading(self, result: RiskResult):
        """交易维度排雷（AKShare）"""
        cfg = CONFIG.risk

        try:
            # 大宗交易折价检查
            end = datetime.now().strftime("%Y%m%d")
            start = (datetime.now() - timedelta(days=30)).strftime("%Y%m%d")
            block_trades = self._ak.get_block_trade(start, end)

            if not block_trades.empty:
                # 筛选当前标的
                symbol_str = result.symbol
                stock_trades = block_trades[
                    block_trades.apply(lambda r: symbol_str in str(r.values), axis=1)
                ]

                if not stock_trades.empty:
                    for _, trade in stock_trades.iterrows():
                        discount = abs(trade.get("折溢率", 0))
                        if discount > cfg.block_trade_discount_threshold:
                            result.risk_items.append({
                                "dimension": "交易",
                                "level": "高风险",
                                "detail": f"大宗交易折价 {discount:.1f}%（阈值: {cfg.block_trade_discount_threshold}%）",
                            })

        except Exception as e:
            logger.warning(f"交易排雷异常 ({result.symbol}): {e}")

    # ──────────────────────────────────────────────
    # 维度4: 板块排雷
    # ──────────────────────────────────────────────

    def _check_sector(self, result: RiskResult):
        """板块维度排雷"""
        try:
            # 获取板块排行，检查该标的所属板块是否降温
            sector_ranking = self._ak.get_sector_ranking(top_n=20)
            if sector_ranking.empty:
                return

            # 如果相关板块没有出现在前20，视为降温信号
            # 这里需要个股所属板块信息，通过 BaoStock 获取
            with BaoStockSource() as bs:
                industry = bs.get_stock_industry(result.symbol)
                if industry:
                    result.details["industry"] = industry
                    # 检查板块是否在前20热门中
                    if industry not in sector_ranking["板块名称"].values:
                        # 板块不在前20，标记为警告
                        # （但这不是致命风险，只是降低权重）
                        pass  # 留待热点匹配模块处理

        except Exception as e:
            logger.warning(f"板块排雷异常 ({result.symbol}): {e}")

    # ──────────────────────────────────────────────
    # 维度5: 晓胜风险信号（市场整体风险）
    # ──────────────────────────────────────────────

    def _check_xiaosheng_risk(self, result: RiskResult):
        """
        晓胜波段王风险信号监测（市场整体层面）

        监测项目:
          1. 融资余额 > 2.2万亿 → 警告（市场过热）
          2. 科技板块成交占比 > 40% → 警告（赛道拥挤）
        """
        cfg = CONFIG.xiaosheng

        try:
            import akshare as ak

            # ── 融资余额监测 ──
            try:
                margin_df = ak.stock_margin_sz_sh()
                if margin_df is not None and not margin_df.empty:
                    # 取最新融资余额（两市合计）
                    # 列名可能为"融资余额"或"融资余额(亿元)"
                    balance_col = None
                    for col in margin_df.columns:
                        col_str = str(col)
                        if "融资余额" in col_str and "亿元" in col_str:
                            balance_col = col
                            break
                    if not balance_col:
                        for col in margin_df.columns:
                            if "融资余额" in col_str:
                                balance_col = col
                                break
                    if balance_col:
                        latest_balance = float(margin_df[balance_col].iloc[-1])
                        if latest_balance > cfg.margin_balance_warning:
                            result.risk_items.append({
                                "dimension": "晓胜风险",
                                "level": "警告",
                                "detail": f"融资余额{latest_balance:.0f}亿 > 阈值{cfg.margin_balance_warning:.0f}亿，市场过热信号",
                            })
                            logger.info(f"晓胜风险: 融资余额{latest_balance:.0f}亿偏高")
            except Exception as e:
                logger.debug(f"融资余额获取失败: {e}")

            # ── 科技成交占比监测 ──
            try:
                # 获取行业资金流向排名
                sector_flow = ak.stock_sector_fund_flow_rank(indicator="今日", sector_type="行业资金流向")
                if sector_flow is not None and not sector_flow.empty:
                    # 计算科技板块成交额占比
                    tech_keywords = ["计算机", "电子", "通信", "半导体", "软件", "互联网"]
                    total_amount = 0
                    tech_amount = 0
                    amount_col = None
                    for col in sector_flow.columns:
                        col_str = str(col)
                        if "成交额" in col_str:
                            amount_col = col
                            break
                    if amount_col:
                        for _, row in sector_flow.iterrows():
                            sector_name = str(row.get("名称", ""))
                            amount = float(row.get(amount_col, 0))
                            total_amount += amount
                            if any(kw in sector_name for kw in tech_keywords):
                                tech_amount += amount
                        if total_amount > 0:
                            tech_ratio = tech_amount / total_amount
                            if tech_ratio > cfg.tech_volume_ratio_warning:
                                result.risk_items.append({
                                    "dimension": "晓胜风险",
                                    "level": "警告",
                                    "detail": f"科技板块成交占比{tech_ratio:.1%} > 阈值{cfg.tech_volume_ratio_warning:.0%}，赛道拥挤信号",
                                })
                                logger.info(f"晓胜风险: 科技成交占比{tech_ratio:.1%}偏高")
            except Exception as e:
                logger.debug(f"科技成交占比获取失败: {e}")

        except Exception as e:
            logger.warning(f"晓胜风险信号检查异常: {e}")

    # ──────────────────────────────────────────────
    # 综合评级
    # ──────────────────────────────────────────────

    @staticmethod
    def _summarize_risk(risk_items: List[Dict]) -> str:
        """
        综合所有风险项，给出最终风险等级

        规则:
          - 存在任意致命雷 → 致命
          - 存在高风险 → 高风险
          - 存在警告 → 警告
          - 全部通过 → 无
        """
        levels = [item["level"] for item in risk_items]
        if "致命" in levels:
            return "致命"
        if "高风险" in levels:
            return "高风险"
        if "警告" in levels:
            return "警告"
        return "无"
