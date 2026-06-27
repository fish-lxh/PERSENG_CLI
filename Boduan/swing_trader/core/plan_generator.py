"""
Step 7: 交易计划书生成
=========================
整合所有分析结果，输出完整的交易计划书。
"""
import logging
from datetime import datetime
from typing import Optional, List, Dict

from ..utils.config import CONFIG
from ..utils.wave_analyzer import get_wave_score, get_wave_rating_text

logger = logging.getLogger(__name__)


class TradePlan:
    """交易计划书"""

    def __init__(self):
        self.symbol: str = ""
        self.name: str = ""
        self.date: str = datetime.now().strftime("%Y-%m-%d")

        # 选股逻辑
        self.market_phase: str = ""
        self.hot_sector: str = ""
        self.pattern_type: str = ""       # A / B
        self.pattern_desc: str = ""
        self.resonance_level: str = ""    # 高 / 中 / 低
        self.risk_level: str = ""          # 无 / 警告 / 高风险 / 致命
        self.wave_label: str = ""          # 浪型判断（新增）
        self.wave_score: int = 0           # 浪型评分（新增）

        # 买点条件
        self.buy_condition: str = "早盘30分钟内放量突破昨收 → 介入"

        # 风控
        self.stop_loss_pct: float = 3.0      # 止损百分比
        self.stop_loss_price: float = 0.0    # 止损价格
        self.observation_days: int = 3       # 观察期

        # 优先级
        self.stars: int = 1                   # ⭐⭐⭐/⭐⭐/⭐

        # 选股逻辑明细
        self.logic_items: List[Dict] = []

    def add_logic(self, label: str, status: bool, detail: str = ""):
        """添加选股逻辑条目"""
        self.logic_items.append({
            "label": label,
            "status": "✅" if status else "❌",
            "detail": detail,
        })

    def to_text(self) -> str:
        """生成文本格式交易计划书"""
        lines = []
        lines.append(f"📋 交易计划书")
        lines.append(f"标的：{self.name}（{self.symbol}）")
        lines.append(f"日期：{self.date}")
        lines.append("")

        # 评级
        stars_str = "⭐" * self.stars
        lines.append(f"【优先级】{stars_str}")
        lines.append("")

        # 选股逻辑
        lines.append("【选股逻辑】")
        for item in self.logic_items:
            detail_str = f"（{item['detail']}）" if item["detail"] else ""
            lines.append(f"├─ {item['status']} {item['label']} {detail_str}")

        # 浪型分析
        if self.wave_label:
            lines.append(f"├─ 🎯 浪型分析: {self.wave_label}（评分:{self.wave_score}）{get_wave_rating_text(self.wave_score)}")
        lines.append("")

        # 买点条件
        lines.append(f"【买点条件】")
        lines.append(f"└─ {self.buy_condition}")
        lines.append("")

        # 风控
        lines.append("【风控】")
        lines.append(f"├─ 止损：买入价下方 {self.stop_loss_pct}%（约 {self.stop_loss_price}）")
        lines.append(f"└─ 观察期：{self.observation_days} 个交易日不启动 → 移出")
        lines.append("")

        # 晓胜交易检查清单
        lines.append("")
        lines.append("【晓胜波段王 · 交易检查清单】")
        lines.append("□ 方向对吗？ — 是否在算电协同/科技主线上？")
        lines.append("□ 形态对吗？ — 首板250/新高模式/反包博弈K线？")
        lines.append("□ 位置对吗？ — 靠近年线还是远离？5日线上方？")
        lines.append("□ 仓位对吗？ — 留预备队了吗？止损设好了？")
        lines.append("□ 心态对吗？ — '一份清醒一份醉'，不追日内热点")

        # 风险提示
        lines.append("")
        lines.append("⚠️ 风险提示：本计划仅为辅助决策，不构成投资建议。市场有风险，请严格执行止损纪律。")

        return "\n".join(lines)

    def to_markdown(self) -> str:
        """生成 Markdown 格式交易计划书"""
        lines = []
        lines.append("---")
        lines.append(f"### 📋 交易计划书：{self.name}（{self.symbol}）")
        lines.append(f"**日期**：{self.date}")
        lines.append("")

        # 评级
        stars_str = "⭐" * self.stars
        lines.append(f"**优先级**：{stars_str}")
        lines.append("")

        # 选股逻辑
        lines.append("**选股逻辑**：")
        for item in self.logic_items:
            detail_str = f"（{item['detail']}）" if item["detail"] else ""
            lines.append(f"- {item['status']} {item['label']} {detail_str}")

        # 浪型分析
        if self.wave_label:
            lines.append(f"- 🎯 **浪型分析**: {self.wave_label} | 评分: {self.wave_score}（{get_wave_rating_text(self.wave_score)}）")
        lines.append("")

        # 买点条件
        lines.append(f"**买点条件**：")
        lines.append(f"- {self.buy_condition}")
        lines.append("")

        # 风控
        lines.append("**风控**：")
        lines.append(f"- 止损：买入价下方 {self.stop_loss_pct}%（约 {self.stop_loss_price}）")
        lines.append(f"- 观察期：{self.observation_days} 个交易日不启动 → 移出")
        lines.append("")

        # 晓胜检查清单（Markdown版）
        lines.append("")
        lines.append("**晓胜波段王 · 交易检查清单**：")
        lines.append("- [ ] **方向对吗？** — 是否在算电协同/科技主线上？")
        lines.append("- [ ] **形态对吗？** — 首板250/新高模式/反包博弈K线？")
        lines.append("- [ ] **位置对吗？** — 靠近年线还是远离？5日线上方？")
        lines.append("- [ ] **仓位对吗？** — 留预备队了吗？止损设好了？")
        lines.append("- [ ] **心态对吗？** — '一份清醒一份醉'，不追日内热点")

        # 风险提示
        lines.append("> ⚠️ 风险提示：本计划仅为辅助决策，不构成投资建议。市场有风险，请严格执行止损纪律。")
        lines.append("---")

        return "\n".join(lines)


class PlanGenerator:
    """
    交易计划书生成器

    使用方式:
        generator = PlanGenerator()
        plan = generator.generate(
            symbol="000001", name="平安银行",
            market_phase="冬末春初",
            hot_sector="银行",
            pattern_type="A",
            resonance_level="高",
            risk_level="无",
        )
        print(plan.to_text())
    """

    def generate(self, symbol: str, name: str,
                 market_phase: str = "",
                 hot_sector: str = "",
                 pattern_type: str = "",
                 pattern_desc: str = "",
                 resonance_level: str = "低",
                 risk_level: str = "无",
                 wave_label: str = "",
                 wave_position: str = "",
                 # 晓胜策略增强参数
                 ma5_price: float = 0.0,
                 ma250_price: float = 0.0,
                 new_high_type: str = "",
                 dist_to_ma5: float = 0.0,
                 dist_to_ma250: float = 0.0,
                 vol_ratio: float = 0.0) -> TradePlan:
        """
        生成交易计划书

        参数:
            symbol: 股票代码
            name: 股票名称
            market_phase: 市场阶段
            hot_sector: 热门板块
            pattern_type: 形态类型 (A/B)
            pattern_desc: 形态描述
            resonance_level: 热点共振度 (高/中/低)
            risk_level: 风险等级 (无/警告/高风险/致命)
        """
        plan = TradePlan()
        plan.symbol = symbol
        plan.name = name
        plan.market_phase = market_phase
        plan.hot_sector = hot_sector
        plan.pattern_type = pattern_type
        plan.pattern_desc = pattern_desc
        plan.resonance_level = resonance_level
        plan.risk_level = risk_level

        # 浪型分析（新增）
        plan.wave_label = wave_label
        plan.wave_score = get_wave_score(wave_label, wave_position)

        # 构建选股逻辑
        is_good_phase = market_phase in ("冬末春初", "春")
        is_hot = resonance_level in ("高", "中")
        is_clean = risk_level == "无"
        is_warning = risk_level == "警告"

        plan.add_logic("市场阶段", is_good_phase, market_phase)
        plan.add_logic("热门板块", bool(hot_sector), hot_sector)
        plan.add_logic("个股形态", bool(pattern_type), f"形态{pattern_type}: {pattern_desc}" if pattern_desc else f"形态{pattern_type}")
        plan.add_logic("热点匹配", is_hot, resonance_level)
        plan.add_logic("排雷结论", is_clean or is_warning, risk_level)

        # 浪型逻辑
        if wave_label:
            plan.add_logic("浪型分析", True,
                           f"{wave_label} | 评分:{plan.wave_score} {get_wave_rating_text(plan.wave_score)}")

        # 确定优先级（⭐⭐⭐/⭐⭐/⭐）
        plan.stars = self._calc_stars(market_phase, pattern_type, risk_level, resonance_level,
                                      wave_label=wave_label, wave_position=wave_position)
        # 新高模式在牛市中额外+1星（晓胜策略）
        if pattern_type == "D" and new_high_type:
            plan.stars = min(3, plan.stars + 1)

        # 确定止损价（从价格传入，暂设为0由调用方更新）
        plan.stop_loss_price = 0.0
        plan.stop_loss_pct = 3.0

        # 风险等级影响观察期
        if risk_level == "警告":
            plan.observation_days = 5  # 有警告的标的延长观察期

        # ── 形态差异化买点条件和止损（晓胜策略） ──
        if pattern_type == "D":
            # 新高模式（晓胜三要点）
            if new_high_type == "历史新高":
                plan.buy_condition = (
                    f"贴着5日线博弈(5日线{ma5_price:.2f})"
                    f" | 止损5日线下5%({ma5_price*0.95:.2f})"
                    f" | 预备队2成上限"
                )
            else:
                plan.buy_condition = (
                    f"阶段新高博弈: 贴5日线{ma5_price:.2f}附近介入"
                    f" | 止损{ma5_price*0.95:.2f}(5日线下5%)"
                    f" | 乘胜追击加仓不超2成"
                )
            plan.stop_loss_pct = 5.0
            if ma5_price > 0:
                plan.stop_loss_price = round(ma5_price * 0.95, 2)
            plan.observation_days = 5

        elif pattern_type == "E":
            # 反包博弈K线
            plan.buy_condition = (
                f"反包次日缩量回踩不破阳线实体下沿"
                f" | 止损在反包K线最低价下方2%"
            )
            plan.stop_loss_pct = 4.0
            plan.observation_days = 3

        elif pattern_type == "A":
            # 首板250
            buy_note = ""
            if dist_to_ma250 > 0:
                buy_note = f"首板后等回调: 激进回踩5日线 | 稳健回踩10日线 | 保守年线附近({ma250_price:.2f})"
            else:
                buy_note = "放量突破年线确认(早盘30分钟不破年线可介入)"
            plan.buy_condition = buy_note
            plan.stop_loss_pct = 5.0 if ma250_price > 0 else 3.0
            if ma250_price > 0:
                plan.stop_loss_price = round(ma250_price * 0.95, 2)
            plan.observation_days = 7  # 首板后需要更长观察期

        elif pattern_type == "B":
            plan.buy_condition = (
                "早盘30分钟内放量突破均价线且突破昨收 → 介入"
                + "（上影线试盘确认，次日缩量回踩不破昨收1/2可加仓）"
            )
            plan.observation_days = 3

        elif pattern_type == "C":
            plan.buy_condition = (
                "连续小阳爬升，关注加速信号（放量突破近日高点）"
            )
            plan.observation_days = 3

        return plan

    def batch_generate(self, candidates: List[Dict]) -> List[TradePlan]:
        """
        批量生成交易计划书

        参数:
            candidates: [
                {
                    "symbol": "000001",
                    "name": "平安银行",
                    "market_phase": "冬末春初",
                    "hot_sector": "银行",
                    "pattern_type": "A",
                    "pattern_desc": "放量涨停突破",
                    "resonance_level": "高",
                    "risk_level": "无",
                    "wave_label": "主升段",       # 新增
                    "wave_position": "强势上攻",   # 新增
                },
                ...
            ]
        """
        plans = []
        for c in candidates:
            plan = self.generate(
                symbol=c.get("symbol", ""),
                name=c.get("name", ""),
                market_phase=c.get("market_phase", ""),
                hot_sector=c.get("hot_sector", ""),
                pattern_type=c.get("pattern_type", ""),
                pattern_desc=c.get("pattern_desc", ""),
                resonance_level=c.get("resonance_level", "低"),
                risk_level=c.get("risk_level", "无"),
                wave_label=c.get("wave_label", ""),
                wave_position=c.get("wave_position", ""),
            )
            plans.append(plan)

        # 按星级排序
        plans.sort(key=lambda p: p.stars, reverse=True)
        return plans

    # ──────────────────────────────────────────────
    # 星级评定
    # ──────────────────────────────────────────────

    @staticmethod
    def _calc_stars(market_phase: str, pattern_type: str,
                    risk_level: str, resonance_level: str,
                    wave_label: str = "", wave_position: str = "") -> int:
        """
        根据 IF-THEN 规则评定星级

        基础星级:
        ⭐⭐⭐（极品）:
          冬末春初 + 形态A/B + 无雷 + 高热点匹配
        ⭐⭐（优质）:
          冬末春初 + 形态A/B + 警告类风险 + 高热点匹配
        ⭐（一般）:
          春阶段 + 形态A/B + 无雷

        浪型调整（在基础星级上微调）:
          +1: 主升段（非冲顶）/ 箱体突破（评分+2）
           0: 上升趋势 / 盘整上沿（评分+1）
          -1: 回调浪（评分-1）或 下跌趋势（评分-2）
        """
        has_pattern = bool(pattern_type)
        if not has_pattern:
            return 0

        # ── 基础星级 ──
        if market_phase == "冬末春初" and risk_level == "无" and resonance_level == "高":
            base = 3
        elif market_phase == "冬末春初" and risk_level == "警告" and resonance_level in ("高", "中"):
            base = 2
        elif market_phase == "春" and risk_level in ("无", "警告"):
            base = 1
        elif market_phase == "冬末春初" and risk_level == "无":
            base = 2
        else:
            base = 1

        # ── 浪型调整 ──
        wave_adj = get_wave_score(wave_label, wave_position)

        # 调整规则：
        # 评分+2（主升段/箱体突破）→ 提升1星
        # 评分-2（下跌趋势）→ 降低1星
        # 评分-1（回调）且基础>=2 → 降低1星
        adjustment = 0
        if wave_adj >= 2:
            adjustment = 1      # 主升段/箱体突破 → 升星
        elif wave_adj <= -2:
            adjustment = -1     # 下跌趋势 → 降星
        elif wave_adj <= -1 and base >= 2:
            adjustment = -1     # 回调浪且基础评级好 → 降星（保守）

        return max(1, min(3, base + adjustment))
