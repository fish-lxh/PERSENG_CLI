"""扫描创新药板块，筛选今日有机会的个股"""
import sys, os, json, urllib.request, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["TQDM_DISABLE"] = "1"
os.environ["NO_PROXY"] = os.environ.get("NO_PROXY", "") + \
    ",10jqka.com.cn,q.10jqka.com.cn,sina.com.cn,hq.sinajs.cn"

from daily_scan import get_sector_stocks

def safe_float(v):
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0

print("=" * 60)
print("  创新药板块扫描 — 下午机会筛选")
print("=" * 60)

# 1. 获取成分股
sector = "创新药"
stocks = get_sector_stocks(sector)
print(f"\n{sector} 成分股: {len(stocks)} 只")
if not stocks:
    print("无法获取成分股")
    sys.exit(1)

# 2. 构建新浪请求
codes = [c for c, n in stocks]
sina_codes = [("sh" if c.startswith("6") else "sz") + c for c in codes]
url = "https://hq.sinajs.cn/list=" + ",".join(sina_codes[:80])

print(f"\n请求新浪行情...")

try:
    req = urllib.request.Request(url, headers={
        "Referer": "https://finance.sina.com.cn",
        "User-Agent": "Mozilla/5.0"
    })
    resp = urllib.request.urlopen(req, timeout=15)
    raw = resp.read().decode("gbk")

    # 打印原始数据的前几行调试
    lines = raw.strip().split("\n")
    print(f"返回行数: {len(lines)}")
    print(f"\n第一行原始数据:")
    print(lines[0][:200] if lines else "空")

    # 解析
    # Sina格式: var hq_str_sz000534="Name,open,prev_close,current,high,low,..."
    # 所有数据都在一对引号内，第一个字段是股票名
    all_quotes = []
    for line in lines:
        if not line.strip():
            continue
        try:
            # 提取股票代码
            code_part = line.split("=")[0].strip()
            code = code_part.split("_")[-1]  # sz000534
            pure_code = code[2:] if len(code) > 2 else code  # 000534

            # 提取引号内的全部内容: "Name,field1,field2,..."
            quote_start = line.index('"') + 1
            quote_end = line.index('"', quote_start)
            quoted = line[quote_start:quote_end]

            # 分割逗号: 第1个是名称，后面是数据字段
            all_fields = quoted.split(",")
            if len(all_fields) < 33:
                continue

            stock_name = all_fields[0]
            # 新浪字段索引(从0开始): 0=名称, 1=今开, 2=昨收, 3=当前, 4=最高, 5=最低
            # 6=买一价, 7=卖一价, 8=成交量(手), 9=成交额
            open_p = safe_float(all_fields[1])
            y_close = safe_float(all_fields[2])
            current = safe_float(all_fields[3])
            high = safe_float(all_fields[4])
            low = safe_float(all_fields[5])
            volume = safe_float(all_fields[8])  # 成交量(手)
            amount = safe_float(all_fields[9])   # 成交额
            pct = (current - y_close) / y_close * 100 if y_close > 0 else 0

            all_quotes.append({
                "code": pure_code, "name": stock_name,
                "price": current, "pct": round(pct, 2),
                "high": high, "low": low,
                "volume": volume, "amount": amount,
            })
        except Exception as e:
            continue

    print(f"\n解析成功: {len(all_quotes)} 只")

    if not all_quotes:
        sys.exit(1)

    # 3. 涨幅榜
    print("\n" + "-" * 60)
    print("涨幅榜（今日走强）")
    print("-" * 60)
    for q in sorted(all_quotes, key=lambda x: x["pct"], reverse=True)[:10]:
        amt = f"{q['amount']/1e8:.1f}亿" if q['amount'] > 0 else "-"
        tag = "🟢" if q['pct'] > 5 else "✅" if q['pct'] > 2 else "➡️" if q['pct'] > 0 else "🔴"
        print(f"  {tag} {q['name']} ({q['code']}) {q['pct']:+6.2f}%  额{amt:>6s}  价{q['price']:.2f}")

    # 4. 成交额榜
    print("\n" + "-" * 60)
    print("资金活跃榜（成交额排序）")
    print("-" * 60)
    for q in sorted(all_quotes, key=lambda x: x["amount"], reverse=True)[:10]:
        amt = f"{q['amount']/1e8:.1f}亿" if q['amount'] > 0 else "-"
        print(f"  {q['name']} ({q['code']}) 额{amt:>6s}  涨幅{q['pct']:+6.2f}%  价{q['price']:.2f}")

    # 5. 重点推荐
    print("\n" + "=" * 60)
    print("重点关注（红盘 + 成交额>5000万）")
    print("=" * 60)
    candidates = [q for q in all_quotes if q["pct"] > 0 and q["amount"] > 50000000]
    candidates.sort(key=lambda x: x["amount"], reverse=True)

    if candidates:
        for i, q in enumerate(candidates[:8], 1):
            amt = f"{q['amount']/1e8:.1f}亿"
            reason = []
            if q['pct'] > 5: reason.append("强势领涨")
            elif q['pct'] > 2: reason.append("稳步上行")
            else: reason.append("温和放量")
            if q['amount'] > 5e8: reason.append("巨量资金")
            elif q['amount'] > 2e8: reason.append("资金活跃")
            print(f"  {i}. {q['name']}({q['code']}) +{q['pct']:.2f}%  额{amt}  价{q['price']:.2f}  - {'/'.join(reason)}")
    else:
        print("  今日创新药板块无符合条件的标的")

except Exception as e:
    print(f"错误: {e}")
    import traceback
    traceback.print_exc()
