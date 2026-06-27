"""
晓胜波段王 · 策略回测入口
========================
对 A~E 五种形态策略进行历史回测，统计胜率/收益率/信号活跃度。

用法:
    python run_backtest.py                                # 默认回测（500只，全模式）
    python run_backtest.py --stocks 100 --patterns A,D    # 快速模式
    python run_backtest.py --sector "人工智能"              # 指定概念板块
    python run_backtest.py --industry "半导体"             # 指定行业板块
    python run_backtest.py --parallel --workers 6          # 多进程加速
    python run_backtest.py --output report.md              # 输出到指定文件
    python run_backtest.py --help                          # 帮助
"""
import sys
import os
import argparse
import logging
from datetime import datetime

# 加入项目根目录
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
)

logger = logging.getLogger(__name__)


def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(
        description="晓胜波段王 · 策略回测系统",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    python run_backtest.py
    python run_backtest.py --stocks 100 --patterns A,D
    python run_backtest.py --sector "人工智能" --stocks 0
    python run_backtest.py --industry "半导体" --parallel
    python run_backtest.py --start 2025-01-01 --end 2025-12-31
        """,
    )

    # 股票池
    parser.add_argument(
        "--stocks", type=int, default=500,
        help="回测股票数量（0=板块模式不限制，默认500）",
    )
    parser.add_argument(
        "--sector", type=str, default="",
        help="指定概念板块名称（如'人工智能'），覆盖--stocks",
    )
    parser.add_argument(
        "--industry", type=str, default="",
        help="指定行业板块名称（如'半导体'），覆盖--stocks",
    )

    # 时间范围
    parser.add_argument(
        "--start", type=str, default="2024-01-01",
        help="回测起始日期（默认2024-01-01）",
    )
    parser.add_argument(
        "--end", type=str, default="",
        help="回测结束日期（默认今日）",
    )

    # 策略选择
    parser.add_argument(
        "--patterns", type=str, default="A,B,C,D,E",
        help="回测模式，逗号分隔（默认A,B,C,D,E）",
    )

    # 市场阶段
    parser.add_argument(
        "--no-spring", action="store_true",
        help="关闭春阶段过滤（默认仅在春/冬末春初检测）",
    )

    # 并行
    parser.add_argument(
        "--parallel", action="store_true",
        help="启用多进程并行模式",
    )
    parser.add_argument(
        "--workers", type=int, default=4,
        help="并行进程数（默认4）",
    )

    # 其他
    parser.add_argument(
        "--min-price", type=float, default=3.0,
        help="最低股价过滤（默认3.0元）",
    )
    parser.add_argument(
        "--output", type=str, default="",
        help="报告输出路径（默认 backtest_results/statistics_report.md）",
    )
    parser.add_argument(
        "--resume", action="store_true",
        help="从中断处继续回测",
    )

    return parser.parse_args()


def main():
    """主入口"""
    args = parse_args()

    # ── 1. 构建配置 ──
    from swing_trader.backtest.backtest_config import BacktestConfig

    end_date = args.end or datetime.now().strftime("%Y-%m-%d")
    patterns = tuple(p.strip().upper() for p in args.patterns.split(","))

    # 板块模式下 stocks=0 表示不限制
    max_stocks = args.stocks
    if args.sector or args.industry:
        max_stocks = args.stocks if args.stocks > 0 else 99999

    config = BacktestConfig(
        start_date=args.start,
        end_date=end_date,
        max_stocks=max_stocks,
        min_price=args.min_price,
        patterns_to_test=patterns,
        only_spring=not args.no_spring,
        sector_name=args.sector,
        industry_name=args.industry,
        resume=args.resume,
    )

    print("=" * 54)
    print("  晓胜波段王 · 策略回测系统")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 54)
    print()
    print(f"  回测期间: {config.start_date} ~ {config.end_date}")
    print(f"  股票池:   {'板块(' + (args.sector or args.industry) + ')' if args.sector or args.industry else str(max_stocks) + '只'}")
    print(f"  模式:     {', '.join(patterns)}")
    print(f"  春阶段:   {'过滤' if config.only_spring else '不过滤'}")
    print(f"  最低价:   {config.min_price}元")
    print(f"  并行:     {'开启(' + str(args.workers) + '进程)' if args.parallel else '关闭'}")
    print()

    # ── 2. 执行回测 ──
    from swing_trader.backtest.backtest_engine import BacktestEngine

    engine = BacktestEngine(config)

    print("开始回测...")
    print()

    if args.parallel:
        results = engine.run_parallel(workers=args.workers)
    else:
        results = engine.run()

    print()

    # ── 3. 生成统计报告 ──
    from swing_trader.backtest.statistics import BacktestStatistics

    stats = BacktestStatistics(config)
    report = stats.generate_report(results)

    # 输出报告
    output_path = args.output
    if not output_path:
        os.makedirs(config.output_dir, exist_ok=True)
        output_path = os.path.join(config.output_dir, "statistics_report.md")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(report)
    print(f"\n✅ 报告已保存: {output_path}")
    print()


if __name__ == "__main__":
    main()
