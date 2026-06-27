"""
运行持仓跟踪
============
入口脚本 - 执行完整的持仓跟踪并生成简报。

工作流程:
  1. 读取 config.py 中的持仓配置
  2. 从 sector_integrator 获取赛道/板块数据
  3. 通过 tracker 获取每个持仓的最新行情
  4. 生成带赛道背景的跟踪简报
  5. 保存到 scan_results/position_track_YYYYMMDD.md

使用方法:
    python run_tracker.py

如果需要临时跟踪不同的股票（不改 config.py）:
    python run_tracker.py --stocks 600905,002579
"""
import os
import sys
import argparse
from datetime import datetime

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tracker import track, generate_report, save_report, log
from sector_integrator import SectorIntegrator


def resolve_holdings(stock_args: str = None) -> list:
    """解析要跟踪的持仓列表

    Args:
        stock_args: 命令行传入的股票代码（逗号分隔）

    Returns:
        持仓配置列表
    """
    if stock_args:
        # 临时跟踪指定的股票
        symbols = [s.strip() for s in stock_args.split(",")]
        from config import HOLDINGS
        # 从 HOLDINGS 中匹配，找不到则创建临时条目
        holdings = []
        for s in symbols:
            matched = [h for h in HOLDINGS if h["symbol"] == s]
            if matched:
                holdings.append(matched[0])
            else:
                # 自动推断 code
                prefix = "sh." if s.startswith("6") else "sz."
                holdings.append({
                    "symbol": s,
                    "name": s,
                    "code": prefix + s,
                    "type": "临时跟踪",
                })
        return holdings
    else:
        from config import HOLDINGS
        return HOLDINGS


def main():
    parser = argparse.ArgumentParser(description="持仓跟踪工具")
    parser.add_argument(
        "--stocks",
        type=str,
        default=None,
        help="临时跟踪的股票代码，逗号分隔，如: 600905,002579",
    )
    parser.add_argument(
        "--no-sector",
        action="store_true",
        help="不加载赛道数据",
    )
    args = parser.parse_args()

    print(f"{'='*50}")
    print(f"  持仓跟踪 | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*50}")
    print()

    # 1. 解析持仓
    holdings = resolve_holdings(args.stocks)
    stock_symbols = [h["symbol"] for h in holdings]
    holdings_desc = ", ".join([f"{h['name']}({h['symbol']})" for h in holdings])
    log(f"跟踪持仓: {holdings_desc}")

    # 2. 获取赛道数据
    sector_map = {}
    if not args.no_sector:
        integrator = SectorIntegrator()
        sector_map = integrator.get_sector_map(stock_symbols)
        for symbol, info in sector_map.items():
            if info and info.get("sector_name"):
                log(f"  板块信息: {symbol} -> {info['sector_name']}")

    # 3. 执行跟踪
    print()
    results = track(holdings, sector_map)

    # 4. 生成并保存简报
    report = generate_report(results)
    path = save_report(report)

    # 5. 打印概要
    print()
    print("-" * 40)
    print("跟踪概要:")
    for r in results:
        if "error" in r:
            print(f"  {r['name']}: {r['error']}")
        else:
            sector_name = ""
            if r.get("sector") and r["sector"].get("sector_name"):
                sector_name = f" [{r['sector']['sector_name']}]"
            print(f"  {r['name']}({r['symbol']}){sector_name}: "
                  f"收盘{r['today']['close']:.2f} "
                  f"{r['today']['pctChg']:+.2f}% "
                  f"| {r['signal']}")
    print()
    print(f"简报已生成: {path}")


if __name__ == "__main__":
    main()
