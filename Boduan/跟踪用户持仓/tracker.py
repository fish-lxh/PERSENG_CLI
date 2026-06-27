"""
持仓跟踪器
==========
运行于非扫描日（周二/四/五），跟踪当前持仓股票的实时状态。

与 sector_integrator.py 联动，获取赛道/板块评分数据，
为持仓提供更丰富的上下文判断。
"""
import os
import sys
from datetime import datetime, timedelta

import baostock as bs
import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCAN_RESULTS_DIR = os.path.join(PROJECT_DIR, "scan_results")
LOGS_DIR = os.path.join(PROJECT_DIR, "logs")
today_str = datetime.now().strftime("%Y%m%d")

# ── 导入用户配置 ──
from config import HOLDINGS, FETCH_DAYS, VOLUME_MA_PERIOD


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


def analyze_stock(holding: dict, sector_info: dict = None) -> dict:
    """分析一只持仓股票

    Args:
        holding: 持仓配置字典 (来自 config.py)
        sector_info: 可选，该股票所属赛道/板块的信息

    Returns:
        包含完整分析结果的字典
    """
    symbol = holding["symbol"]
    name = holding["name"]
    code = holding["code"]
    stock_type = holding["type"]

    result = {
        "symbol": symbol,
        "name": name,
        "code": code,
        "type": stock_type,
        "sector": sector_info,  # 挂载赛道数据
    }

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
        "amplitude": (float(latest[3]) - float(latest[4])) / float(prev[2]) * 100,
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
    if len(volumes) >= VOLUME_MA_PERIOD + 1:
        avg_vol = np.mean(volumes[-(VOLUME_MA_PERIOD + 1):-1])
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
        result["signal"] = "涨停"
    elif today_pct >= 5:
        result["signal"] = "大涨"
    elif today_pct <= -9.9:
        result["signal"] = "跌停"
    elif today_pct <= -5:
        result["signal"] = "大跌"
    elif today_pct <= -3:
        result["signal"] = "回调"
    elif abs(result["dist_ma5"]) <= 2:
        result["signal"] = "贴5日线运行"
    elif result["dist_ma5"] > 5:
        result["signal"] = "偏离5日线偏大"
    elif result["vol_ratio"] > 2:
        result["signal"] = "放量"
    else:
        result["signal"] = "正常"

    log(f"  {name}({symbol}): 收盘{cur_close} 今日{today_pct:+.2f}% 量比{result['vol_ratio']} MA5={result['ma5']} | {result['signal']}")

    return result


def generate_report(data: list) -> str:
    """生成持仓跟踪简报"""
    lines = []
    lines.append("# 持仓跟踪简报")
    lines.append(f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**持仓数**: {len(data)} 只")
    lines.append("")
    lines.append("---")
    lines.append("")

    for d in data:
        if "error" in d:
            lines.append(f"## {d['name']}({d['symbol']}) \u2014 数据获取失败")
            lines.append("")
            continue

        t = d["today"]

        # ── 股票标题，附赛道信息 ──
        title = f"## {d['name']}({d['symbol']}) \u2014 {d['type']}"
        sector = d.get("sector")
        if sector:
            sector_tag = sector.get("tag", "")
            sector_score = sector.get("score", "")
            if sector_tag:
                title += f"  [{sector_tag}"
                if sector_score:
                    title += f" | {sector_score}"
                title += "]"
        lines.append(title)
        lines.append("")

        # ── 今日核心数据 ──
        lines.append("| 指标 | 数据 |")
        lines.append("|:---|:---|")
        lines.append(f"| 日期 | {t['date']} |")
        lines.append(f"| 收盘价 | **{t['close']:.2f}** |")
        lines.append(f"| 今日涨跌幅 | {t['pctChg']:+.2f}% |")
        lines.append(f"| 今日振幅 | {t['amplitude']:.2f}% |")
        lines.append(f"| 量比(vs20日) | {d['vol_ratio']:.2f} |")
        lines.append(f"| 信号 | {d['signal']} |")
        lines.append("")

        # ── 赛道信息 ──
        if sector:
            lines.append("### 赛道背景")
            lines.append("")
            lines.append(f"| 维度 | 信息 |")
            lines.append(f"|:---|:---|")
            if sector.get("sector_name"):
                lines.append(f"| 所属板块 | {sector['sector_name']} |")
            if sector.get("rotation_status"):
                lines.append(f"| 轮动状态 | {sector['rotation_status']} |")
            if sector.get("rank"):
                lines.append(f"| 板块排名 | {sector['rank']} |")
            if sector.get("strength"):
                lines.append(f"| 板块强度 | {sector['strength']} |")
            if sector.get("note"):
                lines.append(f"| 备注 | {sector['note']} |")
            lines.append("")

        # ── 均线位置 ──
        lines.append("### 均线位置")
        lines.append("")
        lines.append("| 均线 | 价格 | 偏离 |")
        lines.append("|:---|:---:|:---:|")
        lines.append(f"| MA5 | {d['ma5']:.2f} | {d['dist_ma5']:+.2f}% |")
        lines.append(f"| MA10 | {d['ma10']:.2f} | {d['dist_ma10']:+.2f}% |")
        lines.append(f"| MA20 | {d['ma20']:.2f} | {d['dist_ma20']:+.2f}% |")
        lines.append("")

        # ── 近期关键价位 ──
        lines.append("### 近期关键价位")
        lines.append("")
        lines.append("| 指标 | 价格 |")
        lines.append("|:---|:---:|")
        lines.append(f"| 近5日最高 | {d['high_5d']:.2f} |")
        lines.append(f"| 近5日最低 | {d['low_5d']:.2f} |")
        lines.append(f"| 近5日涨幅 | {d.get('pct_5d', 0):+.2f}% |")
        if d.get("max_drawdown_10d") is not None:
            lines.append(f"| 近10日最大单日跌幅 | {d['max_drawdown_10d']:.2f}% |")
        lines.append("")

        # ── 操作建议 ──
        lines.append("### 操作建议")
        lines.append("")

        stock_type = d.get("type", "")
        signal = d.get("signal", "")
        dist_ma5 = d.get("dist_ma5", 0)
        sector = d.get("sector")

        # 结合赛道信息的建议
        sector_warning = ""
        if sector and sector.get("rotation_status") in ["退潮", "高位拥挤"]:
            sector_warning = f"\n  > ⚠️ 但该板块{sector['rotation_status']}，需注意板块性回调风险。"

        if "大涨" in signal or "涨停" in signal:
            lines.append(f"> 今日大涨，如已持仓则持有观察，不必追加减仓。{sector_warning}")
        elif "大跌" in signal or "跌停" in signal:
            lines.append(f"> 今日明显下跌，检查是否有利空。关注明日能否企稳。{sector_warning}")
        elif "回调" in signal:
            lines.append(f"> 小幅回调，观察是否缩量。缩量回调属正常整理。{sector_warning}")
        elif dist_ma5 > 5:
            lines.append(f"> 股价偏离5日线偏大，短期可能有回踩需求。{sector_warning}")
        elif abs(dist_ma5) <= 2:
            lines.append(f"> 股价贴5日线运行，趋势健康，持有观察。{sector_warning}")
        else:
            lines.append(f"> 正常波动，继续持有观察。{sector_warning}")

        lines.append("")

    lines.append("---")
    lines.append(f"*Swing-Trader 持仓跟踪 | {datetime.now().strftime('%Y-%m-%d')} | 仅供参考，不构成投资建议*")

    return "\n".join(lines)


def save_report(report: str) -> str:
    os.makedirs(SCAN_RESULTS_DIR, exist_ok=True)
    path = os.path.join(SCAN_RESULTS_DIR, f"position_track_{today_str}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(report)
    log(f"持仓跟踪简报已保存: {path}")
    return path


def track(holdings: list = None, sector_map: dict = None) -> list:
    """执行持仓跟踪

    Args:
        holdings: 持仓列表，默认使用 config.HOLDINGS
        sector_map: 可选，股票代码 -> 赛道信息的映射

    Returns:
        分析结果列表
    """
    if holdings is None:
        from config import HOLDINGS
        holdings = HOLDINGS

    results = []
    for h in holdings:
        symbol = h["symbol"]
        sector_info = (sector_map or {}).get(symbol)
        log(f"正在获取 {h['name']}({symbol})...")
        result = analyze_stock(h, sector_info)
        results.append(result)

    return results


def main():
    print(f"{'='*40}")
    print(f"持仓跟踪 | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*40}")

    results = track()
    report = generate_report(results)
    save_report(report)

    print()
    print(f"跟踪完成 \u2014 {len(results)} 只持仓")


if __name__ == "__main__":
    main()
