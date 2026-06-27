"""
Step 5: 热点匹配 · 晓胜三因子评分模型
======================================
升级为晓胜波段王三因子框架：
  1. 流动性 (Liquidity, 30%) — 市场的钱够不够
  2. 价值性 (Value, 40%)     — 筹码的价值够不够硬
  3. 情绪 (Sentiment, 30%)  — 市场情绪是否配合

综合评分 = 流动性×30% + 价值性×40% + 情绪×30%
"""
import logging
from datetime import datetime
from typing import Optional, List, Dict

import pandas as pd

from ..data_sources.akshare_source import AKShareSource
from ..data_sources.baostock_source import BaoStockSource
from ..utils.config import CONFIG

logger = logging.getLogger(__name__)


class HotMatchResult:
    """热点匹配结果（三因子评分版）"""

    def __init__(self):
        self.symbol: str = ""
        self.name: str = ""
        self.industry: str = ""                     # 所属行业
        self.matched_sectors: List[str] = []         # 匹配的板块
        self.resonance_level: str = "低"             # 高 / 中 / 低
        self.score: int = 0                          # 共振度评分 (0-100)

        # 晓胜方向匹配
        self.xiaosheng_directions: List[str] = []    # 匹配到的晓胜主线方向
        self.xiaosheng_score: int = 0                # 晓胜方向额外加分

        # ── 三因子评分 ──
        self.liquidity_score: int = 0       # 流动性评分 (0-100, 权重30%)
        self.value_score: int = 0           # 价值性评分 (0-100, 权重40%)
        self.sentiment_score: int = 0       # 情绪评分 (0-100, 权重30%)
        self.three_factor_score: int = 0    # 三因子综合评分 (0-100)

        # 各因子明细
        self.liquidity_detail: Dict = {}
        self.value_detail: Dict = {}
        self.sentiment_detail: Dict = {}

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "name": self.name,
            "industry": self.industry,
            "matched_sectors": self.matched_sectors,
            "resonance_level": self.resonance_level,
            "score": self.score,
            "xiaosheng_directions": self.xiaosheng_directions,
            "xiaosheng_score": self.xiaosheng_score,
            # 三因子
            "three_factor_score": self.three_factor_score,
            "liquidity_score": self.liquidity_score,
            "value_score": self.value_score,
            "sentiment_score": self.sentiment_score,
            "liquidity_detail": self.liquidity_detail,
            "value_detail": self.value_detail,
            "sentiment_detail": self.sentiment_detail,
        }

    def get_factor_summary(self, show_detail: bool = False) -> str:
        """返回三因子概览文本（用于报告输出）

        参数:
            show_detail: 是否显示财务质量等子项明细
        """
        liq = self.liquidity_score
        val = self.value_score
        sen = self.sentiment_score
        total = self.three_factor_score
        base = f"三因子: {total}分 [流动性{liq} 价值性{val} 情绪{sen}]"

        if show_detail and self.value_detail:
            fin = self.value_detail.get("财务质量", "")
            if fin:
                base += f" 财#{fin}"
            xs = self.value_detail.get("晓胜方向匹配", "")
            if xs:
                base += f" 晓#{xs}"
            # 提取CAGR单独显示
            if isinstance(fin, str) and "CAGR=" in fin:
                for part in fin.split():
                    if part.startswith("CAGR="):
                        cagr_val = part.replace("CAGR=", "").replace("]", "")
                        base += f" CAGR:{cagr_val}"

        return base


class HotMatcher:
    """
    热点匹配器（三因子版本）

    使用方式:
        matcher = HotMatcher()
        result = matcher.match("000001", "股票名", hot_sectors=["半导体", "人工智能"])
        print(result.three_factor_score, result.resonance_level)
    """

    def __init__(self):
        self._ak = AKShareSource()
        self._robin_cache: Optional[Dict] = None              # 知更鸟信号缓存
        self._concept_ranking_cache: Optional[pd.DataFrame] = None  # 概念板块排行缓存
        self._fin_quality_cache: Dict[str, Dict] = {}         # 财务质量评分缓存

    # ──────────────────────────────────────────────
    # 主入口
    # ──────────────────────────────────────────────

    def match(self, symbol: str, name: str = "",
              hot_sectors: Optional[List[str]] = None,
              pattern: str = "",
              market_phase: str = "",
              volume_ratio: Optional[float] = None,
              pct_chg: Optional[float] = None) -> HotMatchResult:
        """
        晓胜三因子共振度评估

        参数:
            symbol: 股票代码
            name: 股票名称
            hot_sectors: 当前热门板块列表（来自 Step 2）
            pattern: 形态信号类型 (A/B/C/D/E)
            market_phase: 市场阶段 (冬/冬末春初/春/夏/秋)
            volume_ratio: 量比（可选，从上游传入）
            pct_chg: 最新涨跌幅（可选，从上游传入）
        """
        result = HotMatchResult()
        result.symbol = symbol
        result.name = name

        if not hot_sectors:
            hot_sectors = []

        try:
            # 0. 获取股所属行业 + 概念板块排行（带缓存）
            with BaoStockSource() as bs:
                result.industry = bs.get_stock_industry(symbol)
            concept_ranking = self._get_concept_ranking()

            # 1. 计算各因子分数
            value_result = self._calc_value(
                symbol, name, result.industry,
                hot_sectors, concept_ranking,
            )
            liq_result = self._calc_liquidity(
                market_phase, volume_ratio,
            )
            sen_result = self._calc_sentiment(
                pattern, hot_sectors, concept_ranking,
                name, market_phase, pct_chg,
            )

            # 4. 填充结果
            # 价值性子项
            result.value_score = min(value_result["total"], 100)
            result.value_detail = value_result["detail"]
            result.matched_sectors = value_result.get("matched_sectors", [])
            result.xiaosheng_directions = value_result.get("xiaosheng_directions", [])
            result.xiaosheng_score = value_result.get("xiaosheng_score", 0)
            result.industry = value_result.get("industry", result.industry)

            # 流动性子项
            result.liquidity_score = min(liq_result["total"], 100)
            result.liquidity_detail = liq_result["detail"]

            # 情绪子项
            result.sentiment_score = min(sen_result["total"], 100)
            result.sentiment_detail = sen_result["detail"]

            # 5. 三因子综合
            liq_w = 0.3
            val_w = 0.4
            sen_w = 0.3
            combined = (
                result.liquidity_score * liq_w
                + result.value_score * val_w
                + result.sentiment_score * sen_w
            )
            result.three_factor_score = round(combined)

            # 6. 兼容旧字段：score 取三因子综合（保持一致）
            result.score = result.three_factor_score

            # 综合评级
            if result.score >= 70:
                result.resonance_level = "高"
            elif result.score >= 40:
                result.resonance_level = "中"
            else:
                result.resonance_level = "低"

            # 详情汇总
            result.details = {
                "industry": result.industry,
                "matched_count": len(result.matched_sectors),
                "xiaosheng_directions": result.xiaosheng_directions,
                "score_breakdown": {
                    "三因子综合": result.three_factor_score,
                    "流动性": result.liquidity_score,
                    "价值性": result.value_score,
                    "情绪": result.sentiment_score,
                },
                "liquidity": result.liquidity_detail,
                "value": result.value_detail,
                "sentiment": result.sentiment_detail,
            }

        except Exception as e:
            logger.warning(f"热点匹配异常 ({symbol}): {e}")
            result.resonance_level = "低"
            result.score = 0
            result.three_factor_score = 0

        return result

    # ──────────────────────────────────────────────
    # 因子一：流动性评分 (权重30%)
    # 晓胜原话: "市场的钱够不够"
    # ──────────────────────────────────────────────

    def _calc_liquidity(self, market_phase: str,
                        volume_ratio: Optional[float]) -> Dict:
        """
        流动性评分 (0-100)

        评分维度:
        - 市场阶段 (max 40): 春=40 冬末春初=20 其他=0
        - 知更鸟信号 (max 30): 偏多=30 中性=15 偏空=0
        - 个股量比 (max 30): >2=30 >1.5=20 >1=10 ≤1=0
        """
        detail = {}
        score = 0

        # 1. 市场阶段 (max 40)
        phase_score = 0
        if market_phase:
            phase_map = {
                "春": 40,
                "冬末春初": 20,
                "夏": 10,
                "冬": 0,
                "秋": 0,
            }
            phase_score = 0
            for key, val in phase_map.items():
                if key in market_phase:
                    phase_score = val
                    break
        else:
            phase_score = 20  # 未知阶段给中性分
        detail["市场阶段"] = phase_score
        score += phase_score

        # 2. 知更鸟信号 (max 30)
        robin_score = 0
        try:
            robin = self._get_robin_signal()
            direction = robin.get("direction", "中性")
            if direction == "偏多":
                robin_score = 30
            elif direction == "中性":
                robin_score = 15
            else:
                robin_score = 0
        except Exception:
            robin_score = 10  # 获取失败给基础分
        detail["知更鸟信号"] = robin_score
        score += robin_score

        # 3. 个股量比 (max 30)
        vol_score = 15  # 默认给中值
        if volume_ratio is not None:
            if volume_ratio > 2.0:
                vol_score = 30
            elif volume_ratio > 1.5:
                vol_score = 20
            elif volume_ratio > 1.0:
                vol_score = 10
            else:
                vol_score = 0
        detail["个股量比"] = vol_score
        score += vol_score

        return {"total": score, "detail": detail}

    # ──────────────────────────────────────────────
    # 因子二：价值性评分 (权重40%)
    # 晓胜原话: "筹码的价值够不够硬"
    # ──────────────────────────────────────────────

    def _calc_value(self, symbol: str, name: str, industry: str,
                    hot_sectors: List[str],
                    concept_ranking: pd.DataFrame) -> Dict:
        """
        价值性评分 (0-100)

        评分维度:
        - 晓胜方向匹配 (max 35): 匹配晓胜核心主线
        - 行业/概念匹配 (max 25): 属于当前热门板块
        - 均线位置(技术面) (max 20): 位置合理，回踩到位
        - 财务质量 (max 20): ROE + ROCE + 现金流 + CAGR (晓胜4指标)
        """
        detail = {}
        score = 0
        matched_sectors = []
        xiaosheng_directions = []
        xiaosheng_score = 0

        # 1. 晓胜方向匹配 (max 35)
        xs_match = self._match_xiaosheng_direction(symbol, name, industry)
        xiaosheng_directions = xs_match["directions"]
        xiaosheng_score = xs_match["score"]
        # 映射晓胜分(0-50)到35分制
        xs_mapped = round(xiaosheng_score / 50 * 35) if xiaosheng_score > 0 else 0
        detail["晓胜方向匹配"] = xs_mapped
        score += xs_mapped

        # 2. 行业/概念匹配 (max 25)
        ind_score = 0
        if industry and hot_sectors:
            for sector in hot_sectors:
                if industry in sector or sector in industry:
                    if sector not in matched_sectors:
                        matched_sectors.append(sector)
                        ind_score += 25  # 行业匹配直接给高分
                        break  # 一次就够了

        # 概念板块匹配（如果行业没匹配到，检查概念）
        if ind_score < 25 and not concept_ranking.empty and hot_sectors:
            hot_concepts = concept_ranking["板块名称"].tolist()[:20]
            for concept in hot_concepts:
                if concept in hot_sectors or any(
                    s in concept or concept in s for s in hot_sectors
                ):
                    if concept not in matched_sectors:
                        matched_sectors.append(concept)
                        ind_score = max(ind_score, 12)  # 概念匹配12分

        detail["行业/概念匹配"] = ind_score
        score += ind_score

        # 3. 均线位置检查 (max 20)
        ma_score = 8  # 默认给中低分
        try:
            ma_info = self._get_ma_position(symbol)
            if ma_info:
                dist5 = ma_info.get("dist_to_ma5", 999)
                dist20 = ma_info.get("dist_to_ma20", 999)
                dist250 = ma_info.get("dist_to_ma250", 999)
                ma5_up = ma_info.get("ma5_dir") == "up"

                # 回踩5日线不破 (偏离0~3%) = 最佳买点
                if 0 <= dist5 <= 3 and ma5_up:
                    ma_score = 20
                # 回踩5日线附近 (偏离3~5%) = 可以接受
                elif 0 <= dist5 <= 5 and ma5_up:
                    ma_score = 16
                # 回踩20日线附近
                elif 0 <= dist20 <= 3:
                    ma_score = 14
                # 年线附近
                elif abs(dist250) <= 5:
                    ma_score = 12
                # 偏离过大 (>8%) = 追高风险
                elif dist5 > 8:
                    ma_score = 0
                elif dist5 > 5:
                    ma_score = 4
        except Exception:
            ma_score = 8  # 获取失败给基础分

        detail["均线位置"] = ma_score
        score += ma_score

        # 4. 财务质量 (max 20) — 晓胜四指标: ROE + ROCE + 现金流 + CAGR
        fin_score = self._calc_financial_quality(symbol)
        # 从缓存获取财务明细用于显示
        fin_cache = self._fin_quality_cache.get(symbol, {})
        fin_detail = fin_cache.get("detail", {})
        fin_parts = []
        for k in ["ROE", "负债率", "经营现金流/净利润", "CAGR"]:
            if k in fin_detail:
                fin_parts.append(f"{k}={fin_detail[k]}")
        detail["财务质量"] = f"{fin_score}分" + (" [" + " ".join(fin_parts) + "]" if fin_parts else "")
        score += fin_score

        return {
            "total": score,
            "detail": detail,
            "matched_sectors": matched_sectors,
            "xiaosheng_directions": xiaosheng_directions,
            "xiaosheng_score": xiaosheng_score,
            "industry": industry,
        }

    # ══════════════════════════════════════════════
    # 财务质量评分 — 晓胜财务四指标
    # 晓胜看财报只看：ROE / ROCE / 现金流 / CAGR
    # ══════════════════════════════════════════════

    def _calc_financial_quality(self, symbol: str) -> int:
        """
        晓胜财务四指标评分 (0-20)

        ROE (6分): 股东回报效率
          ≥15% → 6, ≥10% → 4, ≥5% → 2, <5% → 0

        ROCE效率 (5分): 剔除杠杆干扰的真实回报
          低负债(<40%)+ROE>10% → 5, 中负债+ROE>10% → 3,
          高负债(>60%) → 至多1, 亏损 → 0

        现金流 (5分): 利润的"测谎仪"
          经营现金流/净利润>1 → 5, >0.5 → 3, >0 → 1, <0 → 0

        CAGR (4分): 复合年均增长率 — 真实持续增长能力
          ≥20% → 4, ≥10% → 3, ≥5% → 2, >0% → 1, ≤0% → 0
        """
        # 缓存命中直接返回
        if symbol in self._fin_quality_cache:
            return self._fin_quality_cache[symbol]["score"]

        from ..data_sources.baostock_source import BaoStockSource

        # 获取最新完整财务季度
        now = datetime.now()
        year = now.year
        month = now.month
        if month <= 4:
            # 年报截止日4月底，Q1截止日4月底
            # 1-4月: 用上年Q4 (年报)
            query_year = year - 1
            query_quarter = 4
        elif month <= 8:
            # 5-8月: Q1 (一季报) + 上年年报
            query_year = year
            query_quarter = 1
        else:
            # 9-12月: Q2 (中报) + Q3 (三季报)
            query_year = year
            query_quarter = 2 if month <= 10 else 3

        score = 0
        detail_parts = {}

        try:
            with BaoStockSource() as bs:
                # ── 1. ROE ──
                profit_df = bs.get_profit_data(symbol, query_year, query_quarter)
                if profit_df is not None and not profit_df.empty:
                    row = profit_df.iloc[-1]
                    roe_str = row.get("roeAvg", "0") if "roeAvg" in profit_df.columns else row.get("ROE", "0")
                    try:
                        # roeAvg 已是小数形式 (如 0.242374 = 24.24%)
                        if "roeAvg" in profit_df.columns:
                            roe = float(roe_str)
                        else:
                            # ROE 可能是百分比形式 (如 24.2374)
                            roe = float(roe_str) / 100.0
                    except (ValueError, TypeError):
                        roe = 0.0

                    net_profit_str = row.get("netProfit", "0") if "netProfit" in profit_df.columns else "0"
                    try:
                        net_profit = float(net_profit_str)
                    except (ValueError, TypeError):
                        net_profit = 0.0

                    if roe >= 0.15:
                        roe_score = 6
                    elif roe >= 0.10:
                        roe_score = 4
                    elif roe >= 0.05:
                        roe_score = 2
                    else:
                        roe_score = 0
                    detail_parts["ROE"] = f"{roe*100:.1f}%"
                    score += roe_score

                    # ── 2. ROCE效率 (用资产负债率修正ROE) ──
                    bal_df = bs.get_balance_data(symbol, query_year, query_quarter)
                    leverage = 0.5  # 默认
                    if bal_df is not None and not bal_df.empty:
                        bal_row = bal_df.iloc[-1]
                        # 用 assetToEquity (权益乘数) 推导负债率
                        # 负债率 = 1 - 1/assetToEquity (如1.38→27.5%, 11.66→91.4%)
                        if "assetToEquity" in bal_df.columns:
                            ate_str = bal_row.get("assetToEquity", "2")
                            try:
                                ate = float(ate_str)
                                if ate > 1:
                                    leverage = 1 - 1.0 / ate
                            except (ValueError, TypeError):
                                leverage = 0.5
                        elif "assetLiabilityRatio" in bal_df.columns:
                            alr_str = bal_row.get("assetLiabilityRatio", "50")
                            try:
                                leverage = float(alr_str) / 100.0
                            except (ValueError, TypeError):
                                leverage = 0.5

                    detail_parts["负债率"] = f"{leverage*100:.0f}%"

                    if leverage < 0.4 and roe > 0.10:
                        roce_score = 5  # 低负债+高ROE = 真本事
                    elif leverage < 0.6 and roe > 0.10:
                        roce_score = 3  # 中等负债+高ROE = 还行
                    elif roe > 0:
                        roce_score = 1  # 赚钱但高杠杆
                    else:
                        roce_score = 0  # 亏损
                    score += roce_score

                    # ── 3. 经营现金流 ──
                    cf_df = bs.get_cash_flow_data(symbol, query_year, query_quarter)
                    cf_ratio = 0.0
                    if cf_df is not None and not cf_df.empty:
                        cf_row = cf_df.iloc[-1]
                        # BaoStock 返回 CFOToNP (经营现金流/净利润比率，如1.423)
                        if "CFOToNP" in cf_df.columns:
                            cfo_str = cf_row.get("CFOToNP", "0")
                            try:
                                cf_ratio = float(cfo_str)
                            except (ValueError, TypeError):
                                cf_ratio = 0.0
                        elif "operatingNetCashFlow" in cf_df.columns:
                            ocf_str = cf_row.get("operatingNetCashFlow", "0")
                            try:
                                oper_cf = float(ocf_str)
                                if net_profit > 0 and abs(net_profit) > 0.01:
                                    cf_ratio = oper_cf / abs(net_profit)
                            except (ValueError, TypeError):
                                cf_ratio = 0.0

                    detail_parts["经营现金流/净利润"] = f"{cf_ratio:.1f}" if net_profit > 0 else "N/A"

                    if cf_ratio > 1.0:
                        cf_score = 5
                    elif cf_ratio > 0.5:
                        cf_score = 3
                    elif cf_ratio > 0:
                        cf_score = 1
                    else:
                        cf_score = 0
                    score += cf_score

                    # ── 4. CAGR (复合年均增长率) ──
                    # 晓胜: "看一家公司不止看当期利润，更要看持续增长能力"
                    cagr = None
                    cagr_score = 0
                    try:
                        past_year = query_year - 3
                        past_df = bs.get_profit_data(symbol, past_year, query_quarter)
                        if past_df is not None and not past_df.empty:
                            past_row = past_df.iloc[-1]
                            past_profit_str = past_row.get("netProfit", "0") if "netProfit" in past_df.columns else "0"
                            try:
                                past_net_profit = float(past_profit_str)
                            except (ValueError, TypeError):
                                past_net_profit = 0.0

                            # 要求两期都盈利才能算CAGR
                            if past_net_profit > 0 and net_profit > 0:
                                ratio = net_profit / past_net_profit
                                cagr = (ratio ** (1.0 / 3.0)) - 1.0
                            elif net_profit > 0 and past_net_profit <= 0:
                                # 扭亏为盈也是增长信号，给基础分
                                cagr = None
                            else:
                                cagr = -0.05  # 利润下降
                    except Exception as e:
                        logger.debug(f"CAGR计算异常 ({symbol}): {e}")
                        cagr = None

                    if cagr is not None:
                        detail_parts["CAGR"] = f"{cagr*100:.1f}%"
                        if cagr >= 0.20:
                            cagr_score = 4
                        elif cagr >= 0.10:
                            cagr_score = 3
                        elif cagr >= 0.05:
                            cagr_score = 2
                        elif cagr > 0:
                            cagr_score = 1
                        else:
                            cagr_score = 0  # 负增长
                    else:
                        detail_parts["CAGR"] = "N/A"
                        cagr_score = 1  # 数据不足/扭亏给中性分
                    score += cagr_score

                else:
                    # 财务数据不可用，给基础分
                    score = 10
                    detail_parts["note"] = "财报数据不可用"

        except Exception as e:
            logger.debug(f"财务质量评分异常 ({symbol}): {e}")
            score = 8  # 降级给基础分

        self._fin_quality_cache[symbol] = {
            "score": score,
            "detail": detail_parts,
        }
        return score

    # ──────────────────────────────────────────────
    # 因子三：情绪评分 (权重30%)
    # 晓胜原话: "市场情绪是否配合"
    # ──────────────────────────────────────────────

    def _calc_sentiment(self, pattern: str,
                        hot_sectors: List[str],
                        concept_ranking: pd.DataFrame,
                        name: str,
                        market_phase: str,
                        pct_chg: Optional[float]) -> Dict:
        """
        情绪评分 (0-100)

        评分维度:
        - 形态信号强度 (max 35): D新高>E反包>A首板>B试盘>C爬升
        - 板块热度 (max 35): 所属板块在热点榜前列
        - 领涨股匹配 (max 30): 个股是板块领涨股
        """
        detail = {}
        score = 0

        # 1. 形态信号强度 (max 35)
        pattern_strength = {
            "D": 35,    # 新高模式 — 晓胜最推崇
            "E": 30,    # 反包博弈 — 强势信号
            "A": 25,    # 首板250 — 启动信号
            "B": 20,    # 上影线试盘 — 试探信号
            "C": 18,    # 小阳线爬升 — 缓慢积累
        }
        p_score = pattern_strength.get(pattern, 10) if pattern else 10
        detail["形态信号强度"] = p_score
        score += p_score

        # 2. 板块热度 (max 35)
        sector_score = 0
        if hot_sectors:
            # 热门板块数量越多，说明情绪越高涨
            sector_count = len(hot_sectors)
            if sector_count >= 8:
                sector_score = 35  # 板块全面开花，情绪高涨
            elif sector_count >= 5:
                sector_score = 25  # 板块较多，情绪较好
            elif sector_count >= 3:
                sector_score = 15  # 板块一般
            else:
                sector_score = 5   # 板块少，情绪冷淡
        else:
            sector_score = 0
        detail["板块热度"] = sector_score
        score += sector_score

        # 3. 领涨股匹配 (max 30)
        leader_score = 0
        if not concept_ranking.empty and name:
            try:
                leaders = []
                for col in ["领涨股票", "领涨股票-涨跌幅"]:
                    if col in concept_ranking.columns:
                        leaders.extend(concept_ranking[col].dropna().tolist())
                if name in leaders:
                    leader_score = 30
            except Exception:
                leader_score = 0
        detail["领涨匹配"] = leader_score
        score += leader_score

        return {"total": score, "detail": detail}

    # ──────────────────────────────────────────────
    # 辅助方法
    # ──────────────────────────────────────────────

    def _get_robin_signal(self) -> Dict:
        """获取知更鸟信号（带缓存）"""
        if self._robin_cache is not None:
            return self._robin_cache
        try:
            # 延迟导入避免循环引用
            from ..utils.robin_signal import RobinSignal
            robin = RobinSignal()
            self._robin_cache = robin.analyze(extended=False)
        except Exception as e:
            logger.debug(f"知更鸟信号获取失败: {e}")
            self._robin_cache = {"direction": "中性", "confidence": 0}
        return self._robin_cache

    def _get_concept_ranking(self) -> pd.DataFrame:
        """获取概念板块排行（带缓存）"""
        if self._concept_ranking_cache is not None:
            return self._concept_ranking_cache
        try:
            self._concept_ranking_cache = self._ak.get_concept_sector_ranking(top_n=50)
        except Exception as e:
            logger.debug(f"概念板块排行获取失败: {e}")
            self._concept_ranking_cache = pd.DataFrame()
        return self._concept_ranking_cache

    def _get_ma_position(self, symbol: str) -> Optional[Dict]:
        """
        获取个股均线位置信息

        返回:
        {
            "dist_to_ma5": float,   # 距5日线偏离%
            "dist_to_ma20": float,  # 距20日线偏离%
            "dist_to_ma250": float, # 距年线偏离%
            "ma5_dir": str,         # 5日线方向 "up"/"down"
            "price": float,         # 最新价
        }
        或 None（获取失败）
        """
        try:
            bs_code = f"sh.{symbol}" if symbol.startswith("6") else f"sz.{symbol}"
            with BaoStockSource() as bs:
                df = bs.get_stock_daily(
                    bs_code,
                    start_date="",  # 使用默认（最近1年）
                    adjust="2",
                )
            if df is None or len(df) < 20:
                return None

            closes = df["close"].tolist()
            price = closes[-1]

            result = {}
            for n in [5, 20, 250]:
                if len(closes) >= n:
                    ma = sum(closes[-n:]) / n
                    dist = round((price - ma) / ma * 100, 2)
                    result[f"dist_to_ma{n}"] = dist
                else:
                    result[f"dist_to_ma{n}"] = None

            # 5日线方向
            if len(closes) >= 10:
                ma5_now = sum(closes[-5:]) / 5
                ma5_prev = sum(closes[-10:-5]) / 5
                result["ma5_dir"] = "up" if ma5_now > ma5_prev else "down"
            else:
                result["ma5_dir"] = "unknown"

            result["price"] = price
            return result

        except Exception as e:
            logger.debug(f"均线位置获取失败 ({symbol}): {e}")
            return None

    @staticmethod
    def _match_xiaosheng_direction(symbol: str, name: str, industry: str) -> Dict:
        """
        匹配晓胜波段王重点关注方向

        匹配策略:
            1. 通过个股名称和行业判断
            2. 通过东方财富概念板块判断

        返回:
        {
            "directions": [str, ...],  # 匹配到的方向名称
            "score": int,              # 额外加分 (0-50)
        }
        """
        cfg = CONFIG.xiaosheng
        directions: List[str] = []
        score = 0

        # 构建匹配文本（名称 + 行业）
        match_text = f"{name} {industry}".lower()

        # 算电协同关键词
        cp_keywords = [kw.lower() for kw in cfg.computing_power_keywords]
        if any(kw in match_text for kw in cp_keywords):
            directions.append("算电协同")
            score += cfg.computing_power_weight

        # 功率半导体
        ps_keywords = [kw.lower() for kw in cfg.power_semi_keywords]
        if any(kw in match_text for kw in ps_keywords):
            directions.append("功率半导体")
            score += cfg.power_semi_weight

        # 陶瓷基板
        cs_keywords = [kw.lower() for kw in cfg.ceramic_substrate_keywords]
        if any(kw in match_text for kw in cs_keywords):
            directions.append("陶瓷基板")
            score += cfg.ceramic_weight

        # AI硬件
        ai_keywords = [kw.lower() for kw in cfg.ai_hardware_keywords]
        if any(kw in match_text for kw in ai_keywords):
            directions.append("AI硬件")
            score += cfg.ai_hardware_weight

        return {"directions": directions, "score": min(score, 50)}

    def batch_match(self, symbols: List[tuple],
                    hot_sectors: Optional[List[str]] = None,
                    pattern_map: Optional[Dict[str, str]] = None,
                    market_phase: str = "") -> List[HotMatchResult]:
        """
        批量热点匹配

        参数:
            symbols: [(股票代码, 股票名称), ...]
            hot_sectors: 当前热门板块列表
            pattern_map: {股票代码: 形态类型} 可选
            market_phase: 市场阶段
        """
        results = []
        for symbol, name in symbols:
            try:
                pattern = ""
                if pattern_map:
                    pattern = pattern_map.get(symbol, "")
                result = self.match(
                    symbol, name, hot_sectors,
                    pattern=pattern,
                    market_phase=market_phase,
                )
                results.append(result)
            except Exception as e:
                logger.warning(f"批量热点匹配异常 ({symbol}): {e}")
        return results
