"""扫描AI算力上游核心材料板块"""
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

# AI算力上游核心材料 → 同花顺概念板块
SECTORS = [
    "光刻胶",
    "PCB概念",
    "先进封装",
    "光纤概念",
    "共封装光学(CPO)",
]

print("=" * 60)
print("  AI算力上游核心材料 — 板块扫描")
print("=" * 60)

# 1. 获取各板块成分股（去重）
all_stocks = {}  # code -> (name, sectors)
for sector in SECTORS:
    try:
        stocks = get_sector_stocks(sector)
        print(f"  {sector}: {len(stocks)} 只")
        for code, name in stocks:
            if code not in all_stocks:
                all_stocks[code] = (name, [sector])
            else:
                all_stocks[code][1].append(sector)
    except Exception as e:
        print(f"  {sector}: 失败 - {e}")

total = len(all_stocks)
print(f"\n去重后合计: {total} 只")
if not all_stocks:
    sys.exit(1)

# 2. 构建新浪行情请求（分批次，每次最多80只）
codes = list(all_stocks.keys())
sina_codes = [("sh" if c.startswith("6") else "sz") + c for c in codes]

all_quotes = []
batch_size = 80
for batch_start in range(0, len(sina_codes), batch_size):
    batch = sina_codes[batch_start:batch_start+batch_size]
    url = "https://hq.sinajs.cn/list=" + ",".join(batch)
    print(f"\n请求行情 {batch_start+1}-{batch_start+len(batch)}/{total}...")

    try:
        req = urllib.request.Request(url, headers={
            "Referer": "https://finance.sina.com.cn",
            "User-Agent": "Mozilla/5.0"
        })
        resp = urllib.request.urlopen(req, timeout=15)
        raw = resp.read().decode("gbk")

        for line in raw.strip().split("\n"):
            if not line.strip():
                continue
            try:
                # 提取代码
                code_part = line.split("=")[0].strip()
                code_raw = code_part.split("_")[-1]
                pure_code = code_raw[2:] if len(code_raw) > 2 else code_raw

                # 提取引号内内容
                qs = line.index('"') + 1
                qe = line.index('"', qs)
                quoted = line[qs:qe]
                fields = quoted.split(",")
                if len(fields) < 33:
                    continue

                name = fields[0]
                y_close = safe_float(fields[2])
                current = safe_float(fields[3])
                high = safe_float(fields[4])
                low = safe_float(fields[5])
                volume = safe_float(fields[8])
                amount = safe_float(fields[9])
                pct = (current - y_close) / y_close * 100 if y_close > 0 else 0

                all_quotes.append({
                    "code": pure_code, "name": name,
                    "price": current, "pct": round(pct, 2),
                    "high": high, "low": low,
                    "volume": volume, "amount": amount,
                    "sectors": all_stocks.get(pure_code, (name, []))[1],
                })
            except Exception:
                continue
    except Exception as e:
        print(f"  请求失败: {e}")
        continue

print(f"\n解析成功: {len(all_quotes)} 只")

if not all_quotes:
    sys.exit(1)

# 3. 涨幅榜
print("\n" + "-" * 60)
print("涨幅榜（今日走强）")
print("-" * 60)
for q in sorted(all_quotes, key=lambda x: x["pct"], reverse=True)[:15]:
    amt = f"{q['amount']/1e8:.1f}亿" if q['amount'] > 0 else "-"
    tag = "🟢" if q['pct'] > 8 else "✅" if q['pct'] > 4 else "➡️" if q['pct'] > 0 else ("🔴" if q['pct'] > -3 else "💀")
    sectors_str = "/".join(q['sectors']) if q['sectors'] else ""
    print(f"  {tag} {q['name']} ({q['code']}) {q['pct']:+6.2f}%  额{amt:>6s}  价{q['price']:.2f}  [{sectors_str}]")

# 4. 成交额榜
print("\n" + "-" * 60)
print("资金活跃榜（成交额排序）")
print("-" * 60)
for q in sorted(all_quotes, key=lambda x: x["amount"], reverse=True)[:15]:
    amt = f"{q['amount']/1e8:.1f}亿" if q['amount'] > 0 else "-"
    sectors_str = "/".join(q['sectors']) if q['sectors'] else ""
    print(f"  {q['name']} ({q['code']}) 额{amt:>6s}  涨幅{q['pct']:+6.2f}%  价{q['price']:.2f}  [{sectors_str}]")

# 5. 多板块共振标的（跨板块强势股）
print("\n" + "=" * 60)
print("多板块共振标的（同时属于2+板块 + 红盘 + 成交额>3000万）")
print("=" * 60)
candidates = [q for q in all_quotes if len(q['sectors']) >= 1 and q['pct'] > 0 and q['amount'] > 30000000]
candidates.sort(key=lambda x: (len(x['sectors']), x['amount']), reverse=True)

if candidates:
    for i, q in enumerate(candidates[:10], 1):
        amt = f"{q['amount']/1e8:.1f}亿"
        sectors_str = "/".join(q['sectors'])
        reason = []
        if q['pct'] > 5: reason.append("强势领涨")
        elif q['pct'] > 2: reason.append("稳步上行")
        else: reason.append("温和放量")
        if q['amount'] > 5e8: reason.append("巨量资金")
        elif q['amount'] > 2e8: reason.append("资金活跃")
        cross_tag = f"🔥 {len(q['sectors'])}板块共振" if len(q['sectors']) >= 2 else ""
        print(f"  {i}. {q['name']}({q['code']}) +{q['pct']:.2f}%  额{amt}  价{q['price']:.2f}  {'/'.join(reason)}  {cross_tag}")
        print(f"     板块: {sectors_str}")
else:
    print("  今日无符合条件的标的")

print()
