"""
回测参数配置
"""
from dataclasses import dataclass, field
from typing import Tuple


@dataclass
class BacktestConfig:
    """回测系统配置"""

    # 回测时间范围
    start_date: str = "2024-01-01"
    end_date: str = "2026-05-15"

    # 股票池
    max_stocks: int = 500  # 最大回测股票数（按市值分层抽样）
    min_price: float = 3.0  # 最低股价过滤
    sector_name: str = ""  # 指定概念板块名称，如"人工智能"；空=全市场抽样
    industry_name: str = ""  # 指定行业板块名称，如"半导体"；空=不使用

    # 持仓周期（交易日）
    hold_periods: Tuple[int, ...] = (3, 5, 10, 20)

    # 回测哪些模式: A=首板250, B=上影线试盘, C=小阳线爬升, D=新高, E=反包, F=上升三法
    patterns_to_test: Tuple[str, ...] = ("A", "B", "C", "D", "E", "F")

    # 春阶段过滤
    only_spring: bool = True  # 只在春阶段检测

    # 输出
    output_dir: str = "backtest_results"
    resume: bool = False  # 从中断处继续

    # 进度
    save_interval: int = 1000  # 每N个信号保存一次中间结果
