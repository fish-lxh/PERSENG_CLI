"""
盘中风险监控
============
每天 10:00 和 14:30 运行，检查持仓的实时风险。

功能:
  - 获取实时行情（通过 akshare）
  - 对比持仓成本价，计算盈亏
  - 检查止损是否触发
  - 分级预警（注意→警戒→危险）
  - 备选数据源：akshare 不可用时降级为 baostock 日线数据
"""
import os
import sys
import json
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 资金合力分析模块
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "swing_trader", "utils"))
try:
    from capital_convergence import analyze_convergence, generate_convergence_section
    HAS_CONVERGENCE = True
except ImportError as e:
    print(f"警告: 资金合力分析模块导入失败: {e}")
    HAS_CONVERGENCE = False

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCAN_RESULTS_DIR = os.path.join(PROJECT_DIR, "scan_results")
LOGS_DIR = os.path.join(PROJECT_DIR, "logs")
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_state")
os.makedirs(LOGS_DIR, exist_ok=True)
os.makedirs(SCAN_RESULTS_DIR, exist_ok=True)
os.makedirs(STATE_DIR, exist_ok=True)

today_str = datetime.now().strftime("%Y%m%d")
now = datetime.now()
hour_min = now.strftime("%H:%M")


def load_high_water(symbol: str) -> float:
    """读取该股票的历史最高价记录（用于移动止盈）

    Args:
        symbol: 股票代码

    Returns:
        记录的最高价，如果没有记录则返回 0
    """
    state_file = os.path.join(STATE_DIR, f"{symbol}_high.json")
    if os.path.exists(state_file):
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("high", 0)
        except:
            return 0
    return 0


def save_high_water(symbol: str, high: float, price: float):
    """更新该股票的历史最高价记录

    Args:
        symbol: 股票代码
        high: 新的最高价（只会上升，不会下降）
        price: 当前价
    """
    state_file = os.path.join(STATE_DIR, f"{symbol}_high.json")
    prev_high = load_high_water(symbol)
    new_high = max(prev_high, high, price)
    try:
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump({"symbol": symbol, "high": new_high, "updated": now.strftime("%Y-%m-%d %H:%M")}, f)
    except:
        pass

# ── 导入配置 ──
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from config import HOLDINGS, WARN_LEVELS


def log(msg: str) -> None:
    log_file = os.path.join(LOGS_DIR, f"risk_monitor_{today_str}.log")
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(f"[{hour_min}] {msg}\n")
    print(msg)


def fetch_realtime_prices(symbols: list) -> dict:
    """通过东方财富直连 API 获取实时行情

    使用 push2.eastmoney.com 的 HTTP 接口逐个查询，
    返回的价格需要从 分(整数) 转换为 元(浮点数)。

    Args:
        symbols: 股票代码列表，如 ["600905", "002579"]

    Returns:
        {股票代码: {"price": 当前价, "pct": 涨跌幅, "high": 最高, "low": 最低, "volume": 成交量}}
    """
    import urllib.request
    import json

    # 代码 -> 东方财富 secid 映射
    # 0 = 深交所, 1 = 上交所
    secid_map = {}
    for s in symbols:
        if s.startswith("6"):
            secid_map[s] = "1." + s
        else:
            secid_map[s] = "0." + s

    result = {}
    success_count = 0

    for symbol, secid in secid_map.items():
        try:
            url = ("http://push2.eastmoney.com/api/qt/stock/get?secid=" + secid
                   + "&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f58,f170,f171")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            resp = urllib.request.urlopen(req, timeout=10)
            data = json.loads(resp.read().decode("utf-8"))
            d = data.get("data", {})

            if d and d.get("f43"):
                # 东方财富 API 返回的价格单位为 分（1/100元）
                price = float(d["f43"]) / 100.0
                high = float(d.get("f44", 0)) / 100.0 if d.get("f44") else 0
                low = float(d.get("f45", 0)) / 100.0 if d.get("f45") else 0
                pct = float(d.get("f170", 0)) / 100.0 if d.get("f170") else 0
                volume = int(d.get("f47", 0)) if d.get("f47") else 0
                amount = float(d.get("f48", 0)) if d.get("f48") else 0

                result[symbol] = {
                    "price": price,
                    "pct": round(pct, 2),
                    "high": high,
                    "low": low,
                    "volume": volume,
                    "amount": amount,
                    "source": "eastmoney_realtime",
                }
                success_count += 1
        except Exception as e:
            log(f"  {symbol} 实时数据获取失败: {e}")
            continue

    if success_count > 0:
        log(f"东方财富实时行情获取成功 ({success_count}/{len(symbols)} 只)")
        return result

    log("实时行情全部失败，降级到 baostock 日线")
    return {}


def fetch_realtime_prices_baostock(symbols: list) -> dict:
    """备选方案：通过 baostock 获取最近一个交易日的数据

    Args:
        symbols: 股票代码列表

    Returns:
        {股票代码: {price, pct, ...}}
    """
    import baostock as bs
    from datetime import timedelta

    lg = bs.login()
    if lg.error_code != "0":
        bs.logout()
        return {}

    end = now.strftime("%Y-%m-%d")
    start = (now - timedelta(days=10)).strftime("%Y-%m-%d")
    result = {}

    for s in symbols:
        prefix = "sh." if s.startswith("6") else "sz."
        code = prefix + s
        rs = bs.query_history_k_data_plus(
            code, "date,close,pctChg,high,low,volume",
            start_date=start, end_date=end, frequency="d", adjustflag="2"
        )
        rows = []
        if rs.error_code == "0":
            while rs.next():
                rows.append(rs.get_row_data())
        if rows:
            latest = rows[-1]
            result[s] = {
                "price": float(latest[1]),
                "pct": float(latest[2]),
                "high": float(latest[3]),
                "low": float(latest[4]),
                "volume": float(latest[5]),
                "date": latest[0],
                "source": "baostock_latest_close",
            }

    bs.logout()
    log(f"baostock 日线数据获取成功 ({len(result)} 只)")
    return result


def check_risk(holding: dict, market: dict) -> dict:
    """检查一只持仓的风险状态

    Args:
        holding: 持仓配置
        market:  实时行情数据

    Returns:
        风险分析结果
    """
    symbol = holding["symbol"]
    name = holding["name"]
    sl = holding.get("stop_loss", {})
    cost = sl.get("cost", 0)
    stop_pct = sl.get("pct", -10)
    trail_pct = sl.get("trail_pct", -15)  # 移动止盈回撤比例

    result = {
        "symbol": symbol,
        "name": name,
        "cost": cost,
        "alerts": [],
        "status": "正常",
        "current_price": 0,
        "profit_pct": 0,
        "today_pct": 0,
    }

    # 获取当前价
    m = market.get(symbol, {})
    current_price = m.get("price", 0)
    today_pct = m.get("pct", 0)
    today_high = m.get("high", current_price)
    source = m.get("source", "unknown")

    result["current_price"] = current_price
    result["today_pct"] = today_pct
    result["source"] = source

    if current_price <= 0:
        result["status"] = "无数据"
        return result

    # 获取并更新最高价记录（用于移动止盈）
    prev_high = load_high_water(symbol)
    high_water = max(prev_high, current_price, today_high)
    save_high_water(symbol, today_high, current_price)
    result["high_water"] = high_water

    # 计算盈亏
    if cost > 0:
        profit_pct = (current_price - cost) / cost * 100
        result["profit_pct"] = round(profit_pct, 2)

        # ── 检查固定止损（针对成本价） ──
        if profit_pct <= stop_pct:
            result["alerts"].append({
                "type": "止损",
                "level": "危险",
                "msg": f"累计亏损 {profit_pct:+.2f}%，已触发止损线 {stop_pct}%！成本 {cost:.2f}，现价 {current_price:.2f}",
            })
            result["status"] = "止损触发"

        # ── 检查移动止盈（有浮盈时从最高点回撤） ──
        if profit_pct > 3 and high_water > cost:
            drawdown = (current_price - high_water) / high_water * 100
            result["drawdown_from_high"] = round(drawdown, 2)

            if drawdown <= trail_pct:
                result["alerts"].append({
                    "type": "移动止盈",
                    "level": "警戒",
                    "msg": f"从最高价 {high_water:.2f} 回撤 {drawdown:.2f}%，已触发移动止盈线 {trail_pct}%！建议止盈，锁定利润。",
                })
                if result["status"] == "正常":
                    result["status"] = "移动止盈触发"

    # 盘中跌幅预警阶梯
    if today_pct < 0:
        for level in WARN_LEVELS:
            if today_pct <= level["threshold"]:
                # 找最严重的级别
                pass

        worst = None
        for level in WARN_LEVELS:
            if today_pct <= level["threshold"]:
                worst = level

        if worst:
            result["alerts"].append({
                "type": "盘中异动",
                "level": worst["level"],
                "msg": f"今日跌 {today_pct:.2f}%，触发「{worst['level']}」预警：{worst['action']}",
            })
            # 如果已经触发过止损，保留止损状态
            if result["status"] != "止损触发":
                result["status"] = worst["level"]

    # 综合判断
    if not result["alerts"]:
        if abs(today_pct) < 1:
            result["status"] = "平稳"
        elif today_pct > 3:
            result["status"] = "上涨"
        elif today_pct > 0:
            result["status"] = "微涨"
        elif today_pct > -2:
            result["status"] = "微跌"

    return result


def generate_risk_report(results: list) -> str:
    """生成风险监控简报"""
    lines = []
    lines.append(f"# 盘中风险监控")
    lines.append(f"**检查时间**: {now.strftime('%Y-%m-%d')} {hour_min}")
    lines.append("")
    lines.append("---")
    lines.append("")

    # ── 总体风险状态 ──
    danger_count = sum(1 for r in results if r["status"] in ("止损触发", "危险"))
    warn_count = sum(1 for r in results if r["status"] == "警戒")
    notice_count = sum(1 for r in results if r["status"] == "注意")

    lines.append("### 总体状态")
    lines.append("")
    if danger_count > 0:
        lines.append(f"> ⛔ **风险提示**: {danger_count} 只持仓触发危险信号，请立即关注！")
    if warn_count > 0:
        lines.append(f"> ⚠️  **警戒**: {warn_count} 只持仓触发警戒")
    if notice_count > 0:
        lines.append(f"> 📌 **注意**: {notice_count} 只持仓需留意")
    if danger_count == 0 and warn_count == 0 and notice_count == 0:
        lines.append("> ✅ 所有持仓运行正常，无风险预警。")
    lines.append("")

    # ── 逐只股票风险详情 ──
    for r in results:
        lines.append(f"---")
        lines.append("")
        title = f"### {r['name']}({r['symbol']})"
        if r["status"] == "止损触发":
            title += "  ⛔ 止损触发"
        elif r["status"] == "移动止盈触发":
            title += "  🔔 移动止盈触发"
        elif r["status"] == "危险":
            title += "  🔴 危险"
        elif r["status"] == "警戒":
            title += "  ⚠️ 警戒"
        elif r["status"] == "注意":
            title += "  📌 注意"
        elif r["status"] == "正常" or r["status"] == "平稳":
            title += "  ✅ 正常"
        elif r["status"] == "上涨":
            title += "  📈 上涨"
        lines.append(title)
        lines.append("")

        # 核心指标
        lines.append("| 指标 | 数据 |")
        lines.append("|:---|:---|")
        lines.append("| 当前价 | **{:.2f}** |".format(r['current_price']))
        lines.append("| 今日涨跌幅 | {:+.2f}% |".format(r['today_pct']))
        if r.get("source"):
            source_label = "实时行情(东方财富)" if "realtime" in r.get("source", "") else "最近收盘(baostock)"
            lines.append("| 数据源 | {} |".format(source_label))
        if r.get("cost", 0) > 0:
            lines.append("| 持仓成本 | {:.2f} |".format(r['cost']))
            lines.append("| 累计盈亏 | {:+.2f}% |".format(r.get('profit_pct', 0)))
            sl_pct = r.get("_sl_pct", -10)
            profit = r.get("profit_pct", 0)
            remaining = profit - sl_pct
            lines.append("| 距止损线 | {:+.2f}% |".format(remaining))
        # 移动止盈信息
        if r.get("high_water", 0) > 0:
            lines.append("| 阶段最高 | {:.2f} |".format(r['high_water']))
        if r.get("drawdown_from_high") is not None:
            lines.append("| 从高位回撤 | {:.2f}% |".format(r['drawdown_from_high']))
        lines.append("")

        # 预警列表
        if r["alerts"]:
            lines.append("#### 预警信息")
            lines.append("")
            for a in r["alerts"]:
                icon = {"危险": "⛔", "警戒": "⚠️", "注意": "📌"}.get(a["level"], "•")
                lines.append(f"- {icon} **[{a['level']}]** {a['msg']}")
            lines.append("")

        # 操作建议
        lines.append("#### 操作建议")
        lines.append("")
        if r["status"] == "止损触发":
            sl_note = ""
            for h in HOLDINGS:
                if h["symbol"] == r["symbol"]:
                    sl_note = h.get("stop_loss", {}).get("note", "")
                    break
            lines.append(f"> ⛔ **已触发止损**，建议严格执行止损计划。{sl_note}")
        elif r["status"] == "移动止盈触发":
            lines.append(f"> 🔔 **移动止盈触发**，从阶段高点 {r.get('high_water', 0):.2f} 回撤中，建议及时止盈锁定利润。")
        elif r["status"] == "危险":
            lines.append(f"> 🔴 跌幅较大，密切观察。如继续下探应考虑减仓。")
        elif r["status"] == "警戒":
            lines.append(f"> ⚠️ 盘中跌幅达 -5%，关注是否有利空，做好减仓准备。")
        elif r["status"] == "注意":
            lines.append(f"> 📌 小幅下跌，观察是否为正常回调。")
        elif r["status"] == "上涨":
            lines.append(f"> 📈 今日上涨中，持有观察。")
        else:
            lines.append(f"> 正常波动，继续持有。")
        lines.append("")

        # 资金合力分析
        if r.get("convergence"):
            conv_lines = generate_convergence_section(r["convergence"])
            # 缩进处理 - generate_convergence_section 本身包含 markdown 格式
            lines.append(conv_lines)
            lines.append("")

    lines.append("---")
    lines.append(f"*Swing-Trader 风险监控 | {now.strftime('%Y-%m-%d %H:%M')} | 盘中数据仅供参考*")

    return "\n".join(lines)


def save_report(report: str) -> str:
    path = os.path.join(SCAN_RESULTS_DIR, f"risk_monitor_{today_str}_{hour_min.replace(':', '')}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(report)
    return path


def main():
    # 时间检查：只在 09:30-15:00 交易时段运行
    current_hour = now.hour
    current_min = now.minute

    symbols = [h["symbol"] for h in HOLDINGS]
    names = [f"{h['name']}({h['symbol']})" for h in HOLDINGS]

    print(f"{'='*50}")
    print(f"  盘中风险监控 | {now.strftime('%Y-%m-%d %H:%M')}")
    print(f"  持仓: {', '.join(names)}")
    print(f"{'='*50}")

    # 1. 先尝试东方财富 API 实时行情
    market = fetch_realtime_prices(symbols)

    # 2. 如果没有实时数据，降级用 baostock 日线
    if not market:
        log("实时行情不可用，降级为 baostock 日线数据")
        market = fetch_realtime_prices_baostock(symbols)

    if not market:
        log("错误：所有数据源均不可用")
        print("无法获取行情数据，请检查网络连接。")
        return

    # 3. 逐只检查风险
    results = []
    for h in HOLDINGS:
        r = check_risk(h, market)
        sl = h.get("stop_loss", {})
        r["_sl_pct"] = sl.get("pct", -10)

        # 打印简要
        source_tag = "实时" if "realtime" in r.get("source", "") else "日线"
        cost_info = f" 成本{r['cost']:.2f} 盈亏{r.get('profit_pct', 0):+.2f}%" if r.get("cost", 0) > 0 else ""
        log(f"  {r['name']}: 现价{r['current_price']:.2f} 今日{r['today_pct']:+.2f}% {cost_info} | {r['status']} [{source_tag}]")

        # 3b. 资金合力分析
        if HAS_CONVERGENCE and r['current_price'] > 0:
            try:
                m = market.get(h["symbol"], {})
                amount = m.get("amount", 0)
                conv = analyze_convergence(
                    symbol=h["symbol"],
                    name=h["name"],
                    current_price=r['current_price'],
                    today_pct=r['today_pct'],
                    amount=amount,
                )
                r["convergence"] = conv
                log(f"    资金合力: {conv['total_score']}/15 {conv['evaluation']}")
            except Exception as e:
                log(f"    资金合力分析失败: {e}")

        results.append(r)

    # 4. 生成简报
    report = generate_risk_report(results)
    path = save_report(report)
    log(f"风险监控简报已保存: {path}")

    # 5. 如果有止损触发，打印醒目标记
    print()
    dangers = [r for r in results if r["status"] == "止损触发"]
    if dangers:
        print("!" * 50)
        print("  止损触发！请立即处理！")
        for d in dangers:
            print(f"  {d['name']}({d['symbol']}): 亏损 {d['profit_pct']:.2f}%")
        print("!" * 50)

    print()
    print(f"风险监控完成 - 简报: {path}")


if __name__ == "__main__":
    main()
