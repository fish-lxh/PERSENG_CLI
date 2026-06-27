"""
统计报告生成
============
对回测结果按模式类型分组统计胜率/收益率/信号数。

输出: 精简版 Markdown 回测报告（测试方法 + 采样数据量 + 成功率）
"""
import logging
from typing import List, Dict
from collections import defaultdict

import numpy as np

from .backtest_config import BacktestConfig

logger = logging.getLogger(__name__)


class BacktestStatistics:
    """回测统计报告生成器"""

    def __init__(self, config: BacktestConfig):
        self.config = config

    def generate_report(self, results: List[Dict]) -> str:
        """生成精简回测报告（Markdown格式）"""
        if not results:
            return "# 回测报告\n\n无信号产生，请检查回测参数。"

        by_pattern = self._group_by(results, "pattern")
        lines = []
        w = lines.append

        w("# 晓胜策略回测报告")
        w("")
        w(f"**生成时间**: {self._now()}")
        w("")

        # ── 一、测试方法 ──
        w("---")
        w("## 一、测试方法")
        w("")
        w("- **回测方式**: Point-in-Time 滑动窗口回测")
        w("  - 对每只股票逐日滑动，取到当日为止的历史数据切片进行检测")
        w("  - 每只股票只取第一个有效信号（同实盘逻辑）")
        w("  - 信号产生后追踪 N 个交易日后的收益（3日/5日/10日/20日）")
        w(f"- **市场阶段过滤**: {'仅检测春阶段+冬末春初信号' if self.config.only_spring else '全市场阶段'}")
        w(f"- **最低股价过滤**: {self.config.min_price} 元以下标的跳过")
        w(f"- **最小数据要求**: 每只股票至少 250 个交易日数据（约 1 年）")
        w("")

        # ── 二、采样数据量 ──
        w("---")
        w("## 二、采样数据量")
        w("")
        codes = set(r["code"] for r in results)
        total_signals = len(results)
        w(f"- **回测期间**: {self.config.start_date} ~ {self.config.end_date}")
        w(f"- **股票池规模**: {self.config.max_stocks} 只（沪深300+中证500成分股优先）")
        w(f"- **总信号数**: {total_signals}")
        w(f"- **涉及标的**: {len(codes)} 只")
        w(f"- **持仓周期**: {', '.join(f'{p}日' for p in self.config.hold_periods)}")
        w("")
        w("各模式信号分布：")
        for pat in ["A", "B", "C", "D", "E", "F"]:
            group = by_pattern.get(pat, [])
            if group:
                names = {"A": "首板250", "B": "上影线试盘", "C": "小阳线爬升", "D": "新高模式", "E": "反包博弈", "F": "上升三法"}
                w(f"- **形态{pat}({names.get(pat, '')})**: {len(group)} 个信号")
        w("")

        # ── 三、成功率 ──
        w("---")
        w("## 三、成功率")
        w("")
        self._write_pattern_table(w, results)

        w("---")
        w("*本报告由 Swing-Trader 回测系统自动生成*")
        return "\n".join(lines)

    # ──────────────────────────────────────────────
    # 核心表格
    # ──────────────────────────────────────────────

    def _write_pattern_table(self, w, results: List[Dict]):
        """各模式胜率+平均收益统计表"""
        by_pattern = self._group_by(results, "pattern")

        pattern_names = {
            "A": "A(首板250)", "B": "B(上影线试盘)",
            "C": "C(小阳线爬升)", "D": "D(新高模式)", "E": "E(反包博弈)",
            "F": "F(上升三法)",
        }

        # 表头
        headers = ["模式", "信号数"]
        for p in self.config.hold_periods:
            headers.extend([f"{p}日胜率", f"{p}日均收益"])

        w("| " + " | ".join(headers) + " |")
        w("|" + "|".join(":---:" for _ in headers) + "|")

        for pattern in ["A", "B", "C", "D", "E", "F"]:
            group = by_pattern.get(pattern, [])
            if not group:
                continue

            name = pattern_names.get(pattern, pattern)
            row = [name, str(len(group))]

            for p in self.config.hold_periods:
                returns = self._get_forward_returns(group, p)
                if returns:
                    win_rate = sum(1 for r in returns if r > 0) / len(returns) * 100
                    avg_return = np.mean(returns)
                    row.append(f"{win_rate:.1f}%")
                    row.append(f"{avg_return:+.2f}%")
                else:
                    row.append("N/A")
                    row.append("N/A")

            w("| " + " | ".join(row) + " |")

        # 汇总行
        total_row = ["**全部**", str(len(results))]
        for p in self.config.hold_periods:
            returns = self._get_forward_returns(results, p)
            if returns:
                win_rate = sum(1 for r in returns if r > 0) / len(returns) * 100
                avg_return = np.mean(returns)
                total_row.append(f"{win_rate:.1f}%")
                total_row.append(f"{avg_return:+.2f}%")
            else:
                total_row.append("N/A")
                total_row.append("N/A")
        w("| " + " | ".join(total_row) + " |")
        w("")

    # ──────────────────────────────────────────────
    # 辅助方法
    # ──────────────────────────────────────────────

    @staticmethod
    def _group_by(results: List[Dict], key: str) -> Dict[str, List[Dict]]:
        groups = defaultdict(list)
        for r in results:
            k = r.get(key, "未知")
            groups[k].append(r)
        return groups

    @staticmethod
    def _get_forward_returns(results: List[Dict], period: int) -> List[float]:
        key = f"forward_{period}d"
        returns = []
        for r in results:
            val = r.get(key)
            if val is not None:
                returns.append(float(val))
        return returns

    @staticmethod
    def _now() -> str:
        from datetime import datetime
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
