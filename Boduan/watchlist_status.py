"""
重点跟踪股票盘后状态简报
===========================
快速查看自选股当前价格、均线、形态信号等状态。

用法:
    python watchlist_status.py
"""
import sys, os, io
if sys.platform == "win32":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import logging
logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("watchlist")

from datetime import datetime
from typing import List, Tuple
from swing_trader.utils.watchlist_manager import get_watchlist


def fetch_watchlist_status(watchlist: List[Tuple[str, str]]):
    """
    获取自选股的状态信息：最新价格、均线位置、涨跌幅
    """
    import baostock as bs
    import math

    lg = bs.login()
    if lg.error_code != "0":
        print("  BaoStock 登录失败")
        return

    results = []
    try:
        for code, name in watchlist:
            bs_code = f"sh.{code}" if code.startswith("6") else f"sz.{code}"

            # 获取1年日K线
            rs = bs.query_history_k_data_plus(
                bs_code, "date,open,high,low,close,preClose,volume,amount,pctChg,turn",
                frequency="d", adjustflag="2",
                start_date="2025-05-26",
                end_date=datetime.now().strftime("%Y-%m-%d"),
            )
            rows = []
            while rs.error_code == "0" and rs.next():
                r = rs.get_row_data()
                if r[6] and r[6].strip():
                    rows.append(r)

            if not rows:
                results.append((code, name, None, None, None, None, None, None, None, None))
                continue

            closes = [float(r[4]) for r in rows]
            pct_chgs = [float(r[8]) for r in rows]
            volumes = [float(r[6]) for r in rows]
            latest = closes[-1]
            latest_pct = pct_chgs[-1]

            # 均线
            mas = {}
            for n in [5, 10, 20, 60, 120]:
                if len(closes) >= n:
                    ma = sum(closes[-n:]) / n
                    mas[f"MA{n}"] = (ma, (latest - ma) / ma * 100)

            # 量比
            avg_vol_5 = sum(volumes[-6:-1]) / 5 if len(volumes) >= 6 else 0
            vol_ratio = volumes[-1] / avg_vol_5 if avg_vol_5 > 0 else 1

            # 60日位置
            if len(closes) >= 60:
                h60 = max(closes[-60:])
                l60 = min(closes[-60:])
                pos60 = (latest - l60) / (h60 - l60) * 100 if h60 != l60 else 50
            else:
                pos60 = None

            results.append((code, name, latest, latest_pct, mas, vol_ratio, pos60, rows[-1][0], rows[-1][6], rows[-1][7]))

    finally:
        bs.logout()

    return results


def print_report(results):
    """打印自选股状态报告"""
    print("=" * 65)
    print(f"  重点跟踪自选股 · 状态简报")
    print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 65)
    print()

    for code, name, price, pct, mas, vol_ratio, pos60, last_date, volume, amount in results:
        print(f"【{name}】{code}")
        if price is None:
            print(f"  无数据")
            print()
            continue

        # 涨跌
        pct_str = f"{pct:+.2f}%" if pct is not None else "N/A"
        vol_str = f"{vol_ratio:.1f}" if vol_ratio else "N/A"
        pos_str = f"{pos60:.0f}%" if pos60 is not None else "N/A"
        print(f"  最新: {price:.2f}  ({pct_str})  量比: {vol_str}  60日位置: {pos_str}")

        if mas:
            parts = []
            for label in ["MA5", "MA10", "MA20", "MA60", "MA120"]:
                if label in mas:
                    ma_val, dist = mas[label]
                    mark = "+" if dist >= 0 else ""
                    parts.append(f"{label}={ma_val:.2f}({mark}{dist:.1f}%)")
            print(f"  均线: {' | '.join(parts)}")

        print()


def main():
    watchlist = get_watchlist()
    if not watchlist:
        print("重点跟踪列表为空，请先添加自选股:")
        print("  python -m swing_trader.utils.watchlist_manager add <代码> <名称>")
        return

    print(f"正在获取 {len(watchlist)} 只自选股数据...")
    results = fetch_watchlist_status(watchlist)
    print()
    print_report(results)


if __name__ == "__main__":
    main()
