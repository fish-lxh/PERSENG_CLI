"""
Swing-Trader 主入口
=====================
A股右侧波段交易辅助系统

用法:
    # 生成每日盘前简报
    python -m swing_trader.main

    # 指定指数
    python -m swing_trader.main --index sh000001

    # 全流程运行（含全市场扫描 + 排雷）
    python -m swing_trader.main --full-scan
"""
import sys
import io

# Windows GBK 终端兼容：将 stdout/stderr 设为 UTF-8
if sys.platform == "win32":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass

# 绕过 Windows 系统代理（如 Clash/V2Ray）对东方财富 API 的影响
# AKShare 多个接口依赖 push2.eastmoney.com 等域名，系统代理不可用时会导致 ProxyError
import os
_no_proxy = os.environ.get("NO_PROXY", "")
_eastmoney_domains = [
    "push2.eastmoney.com", "push2his.eastmoney.com",
    "79.push2.eastmoney.com", "91.push2.eastmoney.com",
    "29.push2.eastmoney.com",
    "datacenter.eastmoney.com", "datacenter-web.eastmoney.com",
    "quote.eastmoney.com", "data.eastmoney.com",
]
for domain in _eastmoney_domains:
    if domain not in _no_proxy:
        _no_proxy = f"{_no_proxy},{domain}" if _no_proxy else domain
os.environ["NO_PROXY"] = _no_proxy
os.environ["no_proxy"] = _no_proxy

import argparse
import logging
from datetime import datetime
from typing import Optional, List

from .data_sources import AKShareSource, BaoStockSource, TeteguSource
from .core.market_phase import (
    MarketPhaseAnalyzer,
    PHASE_WINTER, PHASE_WINTER_TO_SPRING, PHASE_SPRING,
    PHASE_SUMMER, PHASE_AUTUMN,
)
from .core.sector_hot import SectorHotScanner
from .core.pattern_scan import PatternScanner
from .core.risk_check import RiskChecker
from .core.hot_match import HotMatcher
from .core.plan_generator import PlanGenerator, TradePlan
from .core.post_first_board_tracker import PostFirstBoardTracker
from .core.backtest_stats import get_pattern_win_rates
from .utils.wave_analyzer import batch_analyze as wave_batch_analyze

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("Swing-Trader")


class SwingTrader:
    """
    Swing-Trader 主控类
    协调七步流程，生成盘前简报和交易计划书
    """

    def __init__(self, index_code: str = "sh000001"):
        self.index_code = index_code
        self.date_str = datetime.now().strftime("%Y-%m-%d")

        # 各模块实例
        self.phase_analyzer = MarketPhaseAnalyzer()
        self.sector_scanner = SectorHotScanner()
        self.pattern_scanner = PatternScanner()
        self.risk_checker = RiskChecker()
        self.hot_matcher = HotMatcher()
        self.plan_generator = PlanGenerator()

        # 运行结果缓存
        self.market_result = None
        self.sector_result = None
        self.candidates = []

        # 首板后低吸跟踪器
        self.post_board_tracker = PostFirstBoardTracker()

    # ──────────────────────────────────────────────
    # 精选最佳形态（每只股票保留回测胜率最高的形态）
    # ──────────────────────────────────────────────

    @staticmethod
    def _pick_best_per_stock(all_matches: List["PatternMatch"],
                              win_rates: dict) -> List["PatternMatch"]:
        """
        从多形态匹配结果中，每只股票只保留回测胜率最高的形态。

        策略:
          1. 按 symbol 分组
          2. 每组优先保留回测胜率最高的形态
          3. 胜率相同或数据不可用时，按 CHECK_ORDER 检测顺序保留
        """
        check_order = PatternScanner.CHECK_ORDER

        # 按股票代码分组
        stock_groups: dict = {}
        for m in all_matches:
            sym = m.symbol
            if sym not in stock_groups:
                stock_groups[sym] = []
            stock_groups[sym].append(m)

        # 每组选最优形态
        best_matches = []
        for sym, matches in stock_groups.items():
            if len(matches) == 1:
                best_matches.append(matches[0])
                continue

            # 按 (胜率, 检测顺序) 排序
            def _best_key(m):
                rate = win_rates.get(m.pattern_type, 0)
                order_idx = check_order.index(m.pattern_type) if m.pattern_type in check_order else 99
                # 胜率相同的按检测顺序排（D优先于A等）
                return (rate, -order_idx)

            matches.sort(key=_best_key, reverse=True)
            best_matches.append(matches[0])

        return best_matches

    # ──────────────────────────────────────────────
    # 完整七步流程
    # ──────────────────────────────────────────────

    def run_full_scan(self) -> str:
        """
        执行完整的七步流程，生成盘前简报

        返回: 格式化后的简报文本
        """
        logger.info(f"🚀 Swing-Trader 启动 — {self.date_str}")

        # ── Step 1: 周线定势 ──
        logger.info("📊 Step 1/7: 周线定势...")
        self.market_result = self.phase_analyzer.analyze(self.index_code)

        # 冬阶段直接结束，不出选股
        if self.market_result.phase == PHASE_WINTER:
            return self._generate_winter_report()

        # ── Step 2: 板块扫描 ──
        logger.info("📊 Step 2/7: 热门板块扫描...")
        self.sector_result = self.sector_scanner.scan(top_n=10)

        if not self.sector_result.hot_sectors:
            logger.warning("未扫描到热门板块，终止流程")
            return self._generate_no_sector_report()

        logger.info(f"   热门板块: {', '.join(self.sector_result.hot_sectors[:5])}")

        # ── Step 3: 形态扫描（多形态并行检测）──
        logger.info("📊 Step 3/7: 个股形态扫描（多形态并行）...")
        all_matches: List[PatternMatch] = []
        if self.market_result.phase in (PHASE_WINTER_TO_SPRING, PHASE_SPRING):
            # 冬末春初/春：在热门板块内扫描（热钱在哪就去哪）
            all_matches = self.pattern_scanner.scan_in_sectors(
                self.sector_result.hot_sectors[:5],  # 只取前5个板块
                top_n_per_sector=20,
            )
        elif self.market_result.phase in (PHASE_SUMMER, PHASE_AUTUMN):
            # 夏/秋：不新建仓，不扫描选股
            logger.info(f"   市场处于{self.market_result.phase}阶段，不新建仓")
            return self._generate_no_new_position_report()

        if not all_matches:
            logger.warning("未扫描到符合形态的个股")
            return self._generate_no_candidate_report()

        match_count_by_stock = len(set(m.symbol for m in all_matches))
        total_matches = len(all_matches)
        logger.info(f"   发现 {match_count_by_stock} 只个股，{total_matches} 个形态匹配")

        # ── Step 3a: 首板后低吸跟踪（先用全部原始匹配喂给跟踪器）──
        logger.info("📊 Step 3a/7: 首板后低吸跟踪更新...")
        tracked_count = 0
        for m in all_matches:
            if m.pattern_type == "A" and m.ma250_price > 0:
                self.post_board_tracker.add_from_match(m)
                tracked_count += 1
        buy_signals = self.post_board_tracker.update_all()
        if buy_signals:
            logger.info(f"   🔔 {len(buy_signals)} 个首板后低吸信号触发!")
            for sig in buy_signals:
                logger.info(f"       {sig['name']}({sig['symbol']}): {sig['reason']}")
        else:
            logger.info(f"   首板跟踪: {tracked_count} 新加入, {len(self.post_board_tracker.get_tracking_list())} 在跟踪")

        # ── Step 3b: 精选最佳形态（每只股票保留回测胜率最高的形态）──
        logger.info("📊 Step 3b/7: 精选最佳形态...")
        win_rates = get_pattern_win_rates()
        best_per_stock = self._pick_best_per_stock(all_matches, win_rates)
        stock_candidates = [(m.symbol, m.name, m) for m in best_per_stock]
        logger.info(f"   精选后: {len(stock_candidates)} 只个股（原{total_matches}个形态匹配）")

        # ── Step 4: 排雷引擎 ──
        logger.info("📊 Step 4/7: 排雷引擎启动...")
        risk_results = self.risk_checker.batch_check([
            (s, n) for s, n, _ in stock_candidates
        ])

        # 过滤掉致命雷
        clean_candidates = []
        for (symbol, name, match), risk in zip(stock_candidates, risk_results):
            if risk.is_fatal():
                logger.info(f"   🔴 {name}({symbol}): 致命雷 — 剔除")
                continue
            clean_candidates.append({
                "symbol": symbol,
                "name": name,
                "match": match,
                "risk": risk,
            })

        if not clean_candidates:
            logger.warning("所有候选标的均被排雷引擎过滤")
            return self._generate_all_filtered_report()

        logger.info(f"   排雷后剩余 {len(clean_candidates)} 个标的")

        # ── Step 5: 热点匹配 (晓胜三因子模型) ──
        logger.info("📊 Step 5/7: 热点匹配 (三因子模型)...")
        phase_label = self.market_result.phase  # 已经是 "春"/"冬末春初" 等中文
        for item in clean_candidates:
            match_obj = item.get("match")
            hot_result = self.hot_matcher.match(
                item["symbol"],
                item["name"],
                self.sector_result.hot_sectors,
                pattern=match_obj.pattern_type if match_obj else "",
                market_phase=phase_label,
                volume_ratio=match_obj.vol_ratio if match_obj else None,
                pct_chg=match_obj.latest_pct if match_obj else None,
            )
            item["hot_match"] = hot_result

        # 按回测收益率 + 共振度排序
        # 规则: 共振度>=70(高)优先，同共振度内按形态回测胜率降序
        win_rates = get_pattern_win_rates()  # 模块级缓存，第二次调用不重复读取
        check_order = PatternScanner.CHECK_ORDER

        def _sort_key(item):
            hm = item["hot_match"]
            ptype = item["match"].pattern_type
            # 共振度分级: 高=3, 中=2, 低=1
            level_score = {"高": 3, "中": 2, "低": 1}.get(hm.resonance_level, 0)
            # 回测胜率（没有数据时用检测顺序索引作为降级）
            rate = win_rates.get(ptype, 0)
            order_idx = check_order.index(ptype) if ptype in check_order else 99
            # 降级: 有胜率时用胜率，没有时用检测顺序
            tie_breaker = rate if rate > 0 else (100 - order_idx)
            return (level_score, tie_breaker)

        clean_candidates.sort(key=_sort_key, reverse=True)

        # ── Step 6: 走势跟踪 ──
        logger.info("📊 Step 6/7: 走势跟踪...")
        # （跟踪数据持久化，在 Tracker 中管理）
        # 此处将候选标的信息输出到跟踪列表

        # ── Step 7: 生成交易计划书 ──
        logger.info("📊 Step 7/7: 生成交易计划书...")
        self.candidates = clean_candidates

        return self._generate_full_report()

    # ──────────────────────────────────────────────
    # 简报生成
    # ──────────────────────────────────────────────

    def _generate_winter_report(self) -> str:
        """冬阶段简报"""
        lines = [
            f"【Swing-Trader · 盘前简报】{self.date_str}",
            "",
            "一、市场温度",
            f"├─ 阶段: {self.market_result.phase}",
            f"├─ 右侧信号: {self.market_result.confidence}/5",
            f"├─ 建议仓位: {self.market_result.suggested_position}",
            "└─ 操作: 空仓观望，坚决不做左侧抄底",
            "",
            "⚠️ 当前市场处于冬阶段，停止选股操作。",
            "右侧确认信号触发后将自动恢复。",
            "",
            "【Swing-Trader】数据驱动 · 右侧交易 · 严格风控",
        ]
        return "\n".join(lines)

    def _generate_no_sector_report(self) -> str:
        """无热门板块时的简报"""
        lines = [
            f"【Swing-Trader · 盘前简报】{self.date_str}",
            "",
            "一、市场温度",
            f"├─ 阶段: {self.market_result.phase}",
            f"├─ 右侧信号: {self.market_result.confidence}/5",
            f"└─ 建议仓位: {self.market_result.suggested_position}",
            "",
            "二、热门板块",
            "└─ 数据获取异常或无热门板块",
            "",
            "⚠️ 无法扫描到有效的热门板块，暂停选股。",
        ]
        return "\n".join(lines)

    def _generate_no_candidate_report(self) -> str:
        """无候选标的时的简报"""
        lines = [
            f"【Swing-Trader · 盘前简报】{self.date_str}",
            "",
            "一、市场温度",
            f"├─ 阶段: {self.market_result.phase}",
            f"├─ 右侧信号: {self.market_result.confidence}/5",
            f"└─ 建议仓位: {self.market_result.suggested_position}",
            "",
            "二、热门板块 Top5：",
        ]
        for sector in self.sector_result.hot_sectors[:5]:
            lines.append(f"   {sector}")
        lines.append("")
        lines.append("三、候选股票池")
        lines.append("└─ 当前板块内未扫描到符合形态的标的")

        return "\n".join(lines)

    def _generate_no_new_position_report(self) -> str:
        """夏/秋阶段不新建仓的简报"""
        lines = [
            f"【Swing-Trader · 盘前简报】{self.date_str}",
            "",
            "一、市场温度",
            f"├─ 阶段: {self.market_result.phase}",
            f"├─ 右侧信号: {self.market_result.confidence}/5",
            f"├─ 建议仓位: {self.market_result.suggested_position}",
            f"└─ {self.market_result.description}",
            "",
            "二、操作策略",
            f"├─ 当前市场处于{self.market_result.phase}阶段",
            f"├─ {'持有现有仓位，逐步减仓，不新建仓' if self.market_result.phase == '夏' else '准备清仓离场，锁定收益'}",
            "└─ 暂停选股扫描，以持仓管理为主",
            "",
            "⚠️ 本阶段不宜新建仓位，请专注于现有持仓的风控和止盈。",
            "",
            "【Swing-Trader】数据驱动 · 右侧交易 · 严格风控",
        ]
        return "\n".join(lines)

    def _generate_all_filtered_report(self) -> str:
        """所有标的被排雷过滤后的简报"""
        lines = [
            f"【Swing-Trader · 盘前简报】{self.date_str}",
            "",
            "一、市场温度",
            f"├─ 阶段: {self.market_result.phase}",
            f"├─ 右侧信号: {self.market_result.confidence}/5",
            f"└─ 建议仓位: {self.market_result.suggested_position}",
            "",
            "二、热门板块 Top5：",
        ]
        for sector in self.sector_result.hot_sectors[:5]:
            lines.append(f"   {sector}")
        lines.append("")
        lines.append("三、排雷结果")
        lines.append("└─ 所有候选标的均被排雷引擎过滤（致命雷/高风险），无建议标的")
        lines.append("")
        lines.append("✅ 排雷引擎正常运行，成功规避潜在风险标的")

        return "\n".join(lines)

    def _generate_full_report(self) -> str:
        """完整盘前简报"""
        lines = [
            f"【Swing-Trader · 盘前简报】{self.date_str}",
            "",
            "一、市场温度",
            f"├─ 阶段: {self.market_result.phase}",
            f"├─ 右侧确认信号: {self.market_result.confidence}/5",
            f"├─ 建议仓位: {self.market_result.suggested_position}",
            f"└─ {self.market_result.description}",
            "",
            "二、热门板块 Top5：",
        ]

        # 热门板块
        for i, sector in enumerate(self.sector_result.hot_sectors[:5], 1):
            lines.append(f"   {i}. {sector}")

        lines.append("")
        lines.append("三、候选股票池：")

        # 分类输出
        top_tier = [c for c in self.candidates if c["hot_match"].resonance_level == "高"]
        mid_tier = [c for c in self.candidates if c["hot_match"].resonance_level == "中"]
        low_tier = [c for c in self.candidates if c["hot_match"].resonance_level == "低"]

        if top_tier:
            lines.append("   ⭐⭐⭐【优先关注】")
            for c in top_tier[:5]:
                match = c["match"]
                risk = c["risk"]
                hot = c["hot_match"]
                risk_str = f" 🟡{risk.risk_level}" if risk.risk_level != "无" else ""
                factor_str = hot.get_factor_summary() if hasattr(hot, 'get_factor_summary') else f"共振:{hot.resonance_level}"
                lines.append(
                    f"    {c['name']}（{c['symbol']}）"
                    f" | 形态{match.pattern_type} | {factor_str}"
                    f"{risk_str}"
                )

        if mid_tier:
            lines.append("   ⭐⭐【观察中】")
            for c in mid_tier[:5]:
                match = c["match"]
                risk = c["risk"]
                hot = c["hot_match"]
                risk_str = f" 🟡{risk.risk_level}" if risk.risk_level != "无" else ""
                factor_str = hot.get_factor_summary() if hasattr(hot, 'get_factor_summary') else f"共振:{hot.resonance_level}"
                lines.append(
                    f"    {c['name']}（{c['symbol']}）"
                    f" | 形态{match.pattern_type} | {factor_str}"
                    f"{risk_str}"
                )

        if low_tier:
            lines.append("   ⭐【备选池】")
            for c in low_tier[:3]:
                match = c["match"]
                lines.append(
                    f"    {c['name']}（{c['symbol']}）"
                    f" | 形态{match.pattern_type}"
                )

        lines.append("")
        lines.append("四、排雷提示")

        # 输出排雷汇总
        fatal_count = sum(1 for c in self.candidates if c["risk"].risk_level == "致命")
        high_count = sum(1 for c in self.candidates if c["risk"].risk_level == "高风险")
        warn_count = sum(1 for c in self.candidates if c["risk"].risk_level == "警告")
        lines.append(f"   ✅ 已过滤 {fatal_count + high_count} 个高风险标的")
        if warn_count > 0:
            lines.append(f"   🟡 {warn_count} 个标的存在警告类风险（仓位减半）")
        lines.append("")

        lines.append("")
        lines.append("五、首板后低吸跟踪")
        tracking_list = self.post_board_tracker.get_tracking_list()
        buy_signals = self.post_board_tracker.get_signals_list()
        if buy_signals:
            lines.append(f"   🔔 **买入信号触发** ({len(buy_signals)} 个):")
            for sig in buy_signals:
                lines.append(
                    f"       {sig['name']}({sig['symbol']})"
                    f" | {sig['type']}"
                    f" | 现价:{sig['current_price']:.2f}"
                    f" | {sig['reason']}"
                )
        elif tracking_list:
            lines.append(f"   📊 跟踪中: {len(tracking_list)} 个标的")
            for t in tracking_list[:5]:
                lines.append(
                    f"       {t['name']}({t['symbol']})"
                    f" | 突破价:{t['breakout_price']:.2f}"
                    f" | {t['days_since']}天"
                )
        else:
            lines.append("   暂无首板250标的跟踪")
        lines.append("")
        lines.append("六、风险提示")
        lines.append("   ⚠️ 本简报仅为辅助决策，不构成投资建议。")
        lines.append("   ⚠️ 请严格执行止损纪律，市场有风险，投资需谨慎。")
        lines.append("")
        lines.append("【Swing-Trader】数据驱动 · 右侧交易 · 严格风控")

        return "\n".join(lines)

    def generate_plans(self) -> List[TradePlan]:
        """为候选标的生成交易计划书（含浪型分析）"""
        plans = []
        candidates = self.candidates[:5]  # 最多生成5份

        # 批量获取浪型数据（只登录一次）
        try:
            codes_list = [c["symbol"] for c in candidates]
            wave_results = wave_batch_analyze(codes_list)
        except Exception as e:
            logger.warning(f"浪型分析失败: {e}")
            wave_results = {}

        for c in candidates:
            match = c["match"]
            risk = c["risk"]
            hot = c["hot_match"]

            # 浪型分析
            wave = wave_results.get(c["symbol"], {})
            wave_label = wave.get("wave_label", "")
            wave_position = wave.get("position", "")

            plan = self.plan_generator.generate(
                symbol=c["symbol"],
                name=c["name"],
                market_phase=self.market_result.phase,
                hot_sector=hot.matched_sectors[0] if hot.matched_sectors else "",
                pattern_type=match.pattern_type,
                pattern_desc=match.description,
                resonance_level=hot.resonance_level,
                risk_level=risk.risk_level,
                wave_label=wave_label,
                wave_position=wave_position,
                # 晓胜策略增强参数
                ma5_price=getattr(match, 'ma5_price', 0.0),
                ma250_price=getattr(match, 'ma250_price', 0.0),
                new_high_type=getattr(match, 'new_high_type', ''),
                dist_to_ma5=getattr(match, 'dist_to_ma5', 0.0),
                dist_to_ma250=getattr(match, 'dist_to_ma250', 0.0),
                vol_ratio=getattr(match, 'vol_ratio', 0.0),
            )
            plans.append(plan)
        return plans


def main():
    """主入口"""
    parser = argparse.ArgumentParser(description="Swing-Trader — A股右侧波段交易辅助系统")
    parser.add_argument("--index", default="sh000001", help="指数代码 (默认: sh000001 上证指数)")
    parser.add_argument("--full-scan", action="store_true", help="执行全流程扫描")
    args = parser.parse_args()

    trader = SwingTrader(index_code=args.index)

    print(f"\n{'='*50}")
    print(f"  Swing-Trader v1.0.0")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"{'='*50}\n")

    if args.full_scan:
        report = trader.run_full_scan()
        print(report)
        print()

        if trader.candidates:
            print("\n📋 交易计划书：")
            plans = trader.generate_plans()
            for plan in plans:
                print()
                print(plan.to_text())
                print()
    else:
        # 快速模式：只做市场温度判断
        result = trader.phase_analyzer.analyze(args.index)
        info = result.to_dict()
        print(f"[市场温度] {info['phase']}")
        print(f"   右侧信号: {info['confidence']}")
        print(f"   建议仓位: {info['suggested_position']}")
        print(f"   描述: {info['description']}")
        print()

    print(f"{'='*50}")


if __name__ == "__main__":
    main()
