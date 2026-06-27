"""
知更鸟隔夜信号
=============
每日 08:30 执行（周六跳过），获取知更鸟隔夜信号分析

用法: python morning_prep.py
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
logging.basicConfig(level=logging.WARNING, format="%(message)s")
os.environ["AKSHARE_PROGRESS_BAR"] = "0"
os.environ["AKSHARE_DISABLE_PROGRESS"] = "1"
logging.getLogger("akshare").setLevel(logging.ERROR)
try:
    from akshare import progress
    progress.disable_progress_bar()
except Exception:
    pass

from datetime import datetime
import requests

# ──────────────────────────────────────────────
# 周六跳过
# ──────────────────────────────────────────────
today = datetime.now()
if today.weekday() >= 5:  # Saturday(5) or Sunday(6)
    print("周末休市，跳过执行")
    sys.exit(0)

def fetch_robin_signal():
    """知更鸟信号"""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://finance.sina.com.cn",
    }
    signals = []
    bullish_w = 0
    bearish_w = 0

    # 1. WTI原油
    try:
        r = requests.get("https://hq.sinajs.cn/list=hf_CL", headers=headers, timeout=10)
        if r.ok:
            d = r.text.split("=", 1)[1].strip('";\n').split(",")
            cur, pre = float(d[3]), float(d[7])
            pct = round((cur / pre - 1) * 100, 2)
            sig = "偏多" if pct < -1 else ("偏空" if pct > 1 else "中性")
            signals.append(("WTI原油", cur, pct, sig))
            if sig == "偏多": bullish_w += 2
            elif sig == "偏空": bearish_w += 2
    except: signals.append(("WTI原油", 0, 0, "失败"))

    # 2. 日经225ETF
    try:
        r = requests.get("https://hq.sinajs.cn/list=sh513000", headers=headers, timeout=10)
        if r.ok:
            d = r.text.split("=", 1)[1].strip('";\n').split(",")
            cur, pre = float(d[3]), float(d[2])
            if cur > 0 and pre > 0:
                pct = round((cur / pre - 1) * 100, 2)
                sig = "偏多" if pct > 0.5 else ("偏空" if pct < -0.5 else "中性")
                signals.append(("日经225", cur, pct, sig))
                if sig == "偏多": bullish_w += 2
                elif sig == "偏空": bearish_w += 2
            else:
                signals.append(("日经225", cur, 0, "停牌"))
        else: signals.append(("日经225", 0, 0, "失败"))
    except: signals.append(("日经225", 0, 0, "失败"))

    # 3. S&P500
    try:
        r = requests.get("https://hq.sinajs.cn/list=gb_inx", headers=headers, timeout=10)
        if r.ok:
            d = r.text.split("=", 1)[1].strip('";\n').split(",")
            price, pct = float(d[1]), float(d[2])
            sig = "偏多" if pct > 0.5 else ("偏空" if pct < -0.5 else "中性")
            signals.append(("S&P500", price, pct, sig))
            if sig == "偏多": bullish_w += 2
            elif sig == "偏空": bearish_w += 2
    except: signals.append(("S&P500", 0, 0, "失败"))

    # 4. Nasdaq
    try:
        r = requests.get("https://hq.sinajs.cn/list=gb_ixic", headers=headers, timeout=10)
        if r.ok:
            d = r.text.split("=", 1)[1].strip('";\n').split(",")
            price, pct = float(d[1]), float(d[2])
            sig = "偏多" if pct > 0.5 else ("偏空" if pct < -0.5 else "中性")
            signals.append(("Nasdaq", price, pct, sig))
            if sig == "偏多": bullish_w += 1
            elif sig == "偏空": bearish_w += 1
    except: signals.append(("Nasdaq", 0, 0, "失败"))

    # 5. 离岸汇率
    try:
        r = requests.get("https://hq.sinajs.cn/list=fx_susdcny", headers=headers, timeout=10)
        if r.ok:
            d = r.text.split("=", 1)[1].strip('";\n').split(",")
            signals.append(("离岸汇率", float(d[1]), 0, "中性"))
    except: signals.append(("离岸汇率", 0, 0, "失败"))

    if bearish_w > bullish_w:
        direction, conf = "偏空", min(int(bearish_w * 1.5), 5)
    elif bullish_w > bearish_w:
        direction, conf = "偏多", min(int(bullish_w * 1.5), 5)
    else:
        direction, conf = "中性", 0

    return {"signals": signals, "bullish_w": bullish_w, "bearish_w": bearish_w,
            "direction": direction, "confidence": conf}


# ──────────────────────────────────────────────
# 主流程
# ──────────────────────────────────────────────
def main():
    date_str = today.strftime("%Y-%m-%d")
    weekday_cn = ["周一","周二","周三","周四","周五","周六","周日"][today.weekday()]

    print(f"{'='*56}")
    print(f"  知更鸟隔夜信号")
    print(f"  {date_str} {weekday_cn}")
    print(f"{'='*56}")
    print()

    # 1. 知更鸟信号
    print(">>> 知更鸟隔夜信号...")
    robin = fetch_robin_signal()
    print()

    icon_map = {"偏多": "↑", "偏空": "↓", "中性": "→"}
    print(f"  {'数据源':<8}  {'价格':>8}  {'涨跌幅':>8}  {'信号':>6}")
    print(f"  {'-'*36}")
    for name, price, pct, sig in robin["signals"]:
        icon = icon_map.get(sig, "-")
        pct_str = f"{pct:+.2f}%" if isinstance(pct, (int, float)) else str(pct)
        print(f"  {name:<8}  {price:>8.2f}  {pct_str:>8}  {icon} {sig}")

    print()
    print(f"  偏多权重: {robin['bullish_w']}  |  偏空权重: {robin['bearish_w']}")
    print(f"  综合判断: {robin['direction']}  (置信度 {robin['confidence']}/5)")

    print()
    print(f"{'='*56}")
    print(f"  早间准备完成 | {today.strftime('%H:%M')}")
    print(f"{'='*56}")

    # 保存到文件
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scan_results")
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, f"morning_prep_{date_str}.md")

    with open(out_file, "w", encoding="utf-8") as f:
        f.write(f"# 知更鸟隔夜信号\n")
        f.write(f"**{date_str} {weekday_cn}**\n\n")

        f.write(f"| 数据源 | 价格 | 涨跌幅 | 信号 |\n")
        f.write(f"|:---|:---:|:---:|:---:|\n")
        for name, price, pct, sig in robin["signals"]:
            pct_str = f"{pct:+.2f}%" if isinstance(pct, (int, float)) else str(pct)
            f.write(f"| {name} | {price:.2f} | {pct_str} | {sig} |\n")
        f.write(f"\n**综合判断: {robin['direction']} (置信度 {robin['confidence']}/5)**\n\n")

    print(f"\n  已保存: {out_file}")


if __name__ == "__main__":
    main()
