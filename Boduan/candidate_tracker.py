"""
持仓跟踪器（已弃用）
====================
此文件已迁移至: 跟踪用户持仓/ 目录

请使用:
    cd 跟踪用户持仓 && python run_tracker.py

新结构优势:
  - config.py: 可配置的持仓列表（修改即可更换跟踪标的）
  - tracker.py: 跟踪逻辑（与之前相同）
  - sector_integrator.py: 赛道/板块数据整合（与 WorkBuddy 联动）
  - run_tracker.py: 入口脚本

当前持仓:
  1. 三峡能源 (600905) - 机构票
  2. 中京电子 (002579) - 强势股

功能:
  - 获取持仓标的的最新行情
  - 计算均线位置（5日/10日/20日）
  - 识别关键支撑/压力位
  - 整合赛道/板块轮动数据
  - 生成持仓跟踪简报
"""
import os
import sys
from datetime import datetime, timedelta

import baostock as bs
import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
SCAN_RESULTS_DIR = os.path.join(PROJECT_DIR, "scan_results")
LOGS_DIR = os.path.join(PROJECT_DIR, "logs")
today_str = datetime.now().strftime("%Y%m%d")

# ── 当前持仓列表 ──
HOLDINGS = [
    {"symbol": "600905", "name": "三峡能源", "code": "sh.600905", "type": "机构票"},
    {"symbol": "002579", "name": "中京电子", "code": "sz.002579", "type": "强势股"},
]

# 获取近60天数据（足够计算20日均线等指标）
FETCH_DAYS = 90


def log(msg: str) -> None:
    os.makedirs(LOGS_DIR, exist_ok=True)
    log_file = os.path.join(LOGS_DIR, f"position_track_{today_str}.log")
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(msg + "\n")
    print(msg)


def get_stock_data(code: str) -> list:
    """获取股票历史行情"""
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=FETCH_DAYS)).strftime("%Y-%m-%d")

    lg = bs.login()
    if lg.error_code != "0":
        bs.logout()
        return []

    rs = bs.query_history_k_data_plus(
        code,
        "date,open,close,high,low,volume,pctChg",
        start_date=start,
        end_date=end,
        frequency="d",
        adjustflag="2"
    )

    rows = []
    if rs.error_code == "0":
        while rs.next():
            rows.append(rs.get_row_data())

    bs.logout()
    return rows


def calc_ma(closes: list, period: int) -> float:
    """计算移动平均线"""
    if len(closes) < period:
        return 0
    return sum(closes[-period:]) / period


def analyze_stock(symbol: str, name: str, code: str, stock_type: str) -> dict:
    """分析一只持仓股票"""
    result = {"symbol": symbol, "name": name, "code": code, "type": stock_type}

    rows = get_stock_data(code)
    if len(rows) < 5:
        result["error"] = "数据不足"
        return result

    # 解析数据
    dates = [r[0] for r in rows]
    closes = [float(r[2]) for r in rows]
    highs = [float(r[3]) for r in rows]
    lows = [float(r[4]) for r in rows]
    volumes = [float(r[5]) for r in rows]
    pct_chgs = [float(r[6]) for r in rows]

    latest = rows[-1]
    prev = rows[-2] if len(rows) > 1 else rows[-1]

    result["today"] = {
        "date": latest[0],
        "open": float(latest[1]),
        "close": float(latest[2]),
        "high": float(latest[3]),
        "low": float(latest[4]),
        "volume": int(float(latest[5])),
        "pctChg": float(latest[6]),
        "prev_close": float(prev[2]),
    }

    # 均线
    result["ma5"] = round(calc_ma(closes, 5), 2)
    result["ma10"] = round(calc_ma(closes, 10), 2)
    result["ma20"] = round(calc_ma(closes, 20), 2)

    # 当前价格相对于均线的偏离
    cur_close = result["today"]["close"]
    result["dist_ma5"] = round((cur_close - result["ma5"]) / result["ma5"] * 100, 2) if result["ma5"] > 0 else 0
    result["dist_ma10"] = round((cur_close - result["ma10"]) / result["ma10"] * 100, 2) if result["ma10"] > 0 else 0
    result["dist_ma20"] = round((cur_close - result["ma20"]) / result["ma20"] * 100, 2) if result["ma20"] > 0 else 0

    # 量比（vs 20日均量）
    if len(volumes) >= 21:
        avg_vol = np.mean(volumes[-22:-1])
        result["vol_ratio"] = round(result["today"]["volume"] / avg_vol, 2) if avg_vol > 0 else 0
    else:
        result["vol_ratio"] = 0

    # 近5日涨跌幅
    if len(closes) >= 6:
        result["pct_5d"] = round((closes[-1] - closes[-6]) / closes[-6] * 100, 2)
    else:
        result["pct_5d"] = 0

    # 近5日最高/最低
    result["high_5d"] = max(highs[-5:]) if len(highs) >= 5 else 0
    result["low_5d"] = min(lows[-5:]) if len(lows) >= 5 else 0

    # 最近10天最大单日跌幅
    if len(pct_chgs) >= 10:
        result["max_drawdown_10d"] = min(pct_chgs[-10:])

    # 状态判断
    today_pct = result["today"]["pctChg"]

    if today_pct >= 9.9:
        result["signal"] = "⚡ 涨停"
    elif today_pct >= 5:
        result["signal"] = "🔥 大涨"
    elif today_pct <= -9.9:
        result["signal"] = "💥 跌停"
    elif today_pct <= -5:
        result["signal"] = "⚠️ 大跌"
    elif today_pct <= -3:
        result["signal"] = "📉 回调"
    elif abs(result["dist_ma5"]) <= 2:
        result["signal"] = "✅ 贴5日线运行"
    elif result["dist_ma5"] > 5:
        result["signal"] = "📏 偏离5日线偏大"
    elif result["vol_ratio"] > 2:
        result["signal"] = "📊 放量"
    else:
        result["signal"] = "正常"

    log(f"  {name}({symbol}): 收盘{cur_close} 今日{today_pct:+.2f}% 量比{result['vol_ratio']} MA5={result['ma5']} | {result['signal']}")

    return result


def generate_report(data: list) -> str:
    """生成持仓跟踪简报"""
    lines = []
    lines.append(f"# 持仓跟踪简报")
    lines.append(f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**持仓数**: {len(data)} 只")
    lines.append("")
    lines.append("---")
    lines.append("")

    for d in data:
        if "error" in d:
            lines.append(f"## {d['name']}({d['symbol']}) — 数据获取失败")
            lines.append("")
            continue

        t = d["today"]
        lines.append(f"## {d['name']}({d['symbol']}) — {d['type']}")
        lines.append("")
        lines.append(f"| 指标 | 数据 |")
        lines.append(f"|:---|:---|")
        lines.append(f"| 日期 | {t['date']} |")
        lines.append(f"| 收盘价 | **{t['close']:.2f}** |")
        lines.append(f"| 今日涨跌幅 | {t['pctChg']:+.2f}% |")
        lines.append(f"| 今日振幅 | {(t['high'] - t['low']) / t['prev_close'] * 100:.2f}% |")
        lines.append(f"| 量比(vs20日) | {d['vol_ratio']:.2f} |")
        lines.append(f"| 信号 | {d['signal']} |")
        lines.append("")
        lines.append("### 均线位置")
        lines.append("")
        lines.append(f"| 均线 | 价格 | 偏离 |")
        lines.append(f"|:---|:---:|:---:|")
        lines.append(f"| MA5 | {d['ma5']:.2f} | {d['dist_ma5']:+.2f}% |")
        lines.append(f"| MA10 | {d['ma10']:.2f} | {d['dist_ma10']:+.2f}% |")
        lines.append(f"| MA20 | {d['ma20']:.2f} | {d['dist_ma20']:+.2f}% |")
        lines.append("")
        lines.append("### 近期关键价位")
        lines.append("")
        lines.append(f"| 指标 | 价格 |")
        lines.append(f"|:---|:---:|")
        lines.append(f"| 近5日最高 | {d['high_5d']:.2f} |")
        lines.append(f"| 近5日最低 | {d['low_5d']:.2f} |")
        lines.append(f"| 近5日涨幅 | {d.get('pct_5d', 0):+.2f}% |")
        if d.get("max_drawdown_10d") is not None:
            lines.append(f"| 近10日最大单日跌幅 | {d['max_drawdown_10d']:.2f}% |")
        lines.append("")
        lines.append("### 操作建议")
        lines.append("")

        # 根据形态给出建议
        stock_type = d.get("type", "")
        signal = d.get("signal", "")
        dist_ma5 = d.get("dist_ma5", 0)

        if "大涨" in signal or "涨停" in signal:
            lines.append(f"> 📌 今日大涨，如已持仓则持有观察，不必追加减仓。")
        elif "大跌" in signal or "跌停" in signal:
            lines.append(f"> ⚠️ 今日明显下跌，检查是否有利空。关注明日能否企稳。")
        elif "回调" in signal:
            lines.append(f"> 📉 小幅回调，观察是否缩量。缩量回调属正常整理。")
        elif dist_ma5 > 5:
            lines.append(f"> 📏 股价偏离5日线偏大，短期可能有回踩需求。")
        elif abs(dist_ma5) <= 2:
            lines.append(f"> ✅ 股价贴5日线运行，趋势健康，持有观察。")
        else:
            lines.append(f"> 正常波动，继续持有观察。")

        lines.append("")

    lines.append("---")
    lines.append(f"*Swing-Trader 持仓跟踪 | {datetime.now().strftime('%Y-%m-%d')} | 仅供参考，不构成投资建议*")

    return "\n".join(lines)


def save_report(report: str):
    os.makedirs(SCAN_RESULTS_DIR, exist_ok=True)
    path = os.path.join(SCAN_RESULTS_DIR, f"position_track_{today_str}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(report)
    log(f"持仓跟踪简报已保存: {path}")


def main():
    print(f"{'='*40}")
    print(f"持仓跟踪 | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*40}")

    results = []
    for h in HOLDINGS:
        log(f"正在获取 {h['name']}({h['symbol']})...")
        result = analyze_stock(h["symbol"], h["name"], h["code"], h["type"])
        results.append(result)

    report = generate_report(results)
    save_report(report)

    print()
    print(f"跟踪完成 — {len(results)} 只持仓")


if __name__ == "__main__":
    main()
