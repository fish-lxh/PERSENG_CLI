"""
backtest_stats.py — 回测统计读取模块

从回测结果 CSV 中读取各形态的胜率数据，用于实盘扫描时的形态优先级排序。

用法:
    from .backtest_stats import get_pattern_win_rates
    rates = get_pattern_win_rates()  # {"A": 36.8, "D": 51.2, ...}
"""
import csv
import os
import logging
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# 回测结果 CSV 路径（相对于项目根目录）
BACKTEST_CSV_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "backtest_results",
    "signals_all.csv",
)

# 最小样本量：低于此数量的形态不参与胜率排名
MIN_SAMPLES = 10

# 模块级缓存，进程内只加载一次
_WIN_RATES_CACHE: Optional[Dict[str, float]] = None


def get_pattern_win_rates(csv_path: str = BACKTEST_CSV_PATH) -> Dict[str, float]:
    """
    读取回测 CSV，按形态 pattern_type 计算 forward_10d 胜率。

    胜率 = 10日后收益率为正的信号数 / 总信号数 × 100

    返回:
        {"A": 36.8, "B": 43.2, "D": 51.2, "E": 63.6, "F": 54.2}
        样本量 < MIN_SAMPLES 的形态不会被包含在返回结果中。
        CSV 不存在或格式错误时返回空字典。
    """
    global _WIN_RATES_CACHE
    if _WIN_RATES_CACHE is not None:
        return _WIN_RATES_CACHE

    if not os.path.isfile(csv_path):
        logger.info(f"回测结果 CSV 不存在: {csv_path}，将使用检测顺序排序")
        _WIN_RATES_CACHE = {}
        return _WIN_RATES_CACHE

    try:
        # 按形态分组统计
        pattern_stats: Dict[str, dict] = {}

        with open(csv_path, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                ptype = row.get("pattern_type", "").strip()
                if not ptype:
                    continue

                if ptype not in pattern_stats:
                    pattern_stats[ptype] = {"total": 0, "positive": 0}

                pattern_stats[ptype]["total"] += 1

                # 尝试读取 forward_10d 字段
                f10_str = row.get("forward_10d", "").strip()
                if f10_str:
                    try:
                        f10 = float(f10_str)
                        if f10 > 0:
                            pattern_stats[ptype]["positive"] += 1
                    except ValueError:
                        pass

        # 计算胜率
        win_rates: Dict[str, float] = {}
        for ptype, stats in pattern_stats.items():
            if stats["total"] >= MIN_SAMPLES:
                rate = stats["positive"] / stats["total"] * 100
                win_rates[ptype] = round(rate, 1)
                logger.info(f"形态{ptype} 回测胜率: {rate:.1f}% ({stats['positive']}/{stats['total']})")
            else:
                logger.info(f"形态{ptype} 样本量不足({stats['total']}<{MIN_SAMPLES})，跳过胜率统计")

        _WIN_RATES_CACHE = win_rates
        return win_rates

    except Exception as e:
        logger.warning(f"读取回测CSV失败: {e}，将使用检测顺序排序")
        _WIN_RATES_CACHE = {}
        return _WIN_RATES_CACHE


def clear_cache():
    """清除模块级缓存（测试用）"""
    global _WIN_RATES_CACHE
    _WIN_RATES_CACHE = None
