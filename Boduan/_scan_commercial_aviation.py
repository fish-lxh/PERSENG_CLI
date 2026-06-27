"""
商业航天板块形态扫描
"""
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')

import baostock as bs
import pandas as pd
import numpy as np
from datetime import datetime
from collections import Counter

# 商业航天板块成分股
stocks = [
    ('300620','光库科技'),('688143','长盈通'),('301682','宏明电子'),
    ('300285','国瓷材料'),('300328','宜安科技'),('601137','博威合金'),
    ('002579','中京电子'),('600869','远东股份'),('603678','火炬电子'),
    ('603267','鸿远电子'),('605589','圣泉集团'),('600105','永鼎股份'),
    ('600345','长江通信'),('688685','迈信林'),('002436','兴森科技'),
    ('300757','罗博特科'),('688668','鼎通科技'),('600522','中天科技'),
    ('000636','风华高科'),('300726','宏达电子'),('002938','鹏鼎控股'),
    ('688383','新益昌'),('601208','东材科技'),('688531','日联科技'),
    ('301282','金禄电子'),('300005','探路者'),('688175','高凌信息'),
    ('688456','有研粉材'),('603031','安孚科技'),('603773','沃格光电'),
    ('301366','一博科技'),('000733','振华科技'),('688433','华曙高科'),
    ('600378','昊华科技'),('688586','江航装备'),('603459','红板科技'),
    ('603011','合锻智能'),('600549','厦门钨业'),('300863','卡倍亿'),
    ('002428','云南锗业'),('688629','华丰科技'),
]


def detect_patterns(closes, volumes, highs, lows, opens):
    """检测6形态"""
    if len(closes) < 250:
        return None

    n = len(closes) - 1
    c = closes
    v = volumes

    # 均线
    ma5 = np.mean(c[-5:])
    ma10 = np.mean(c[-10:])
    ma20 = np.mean(c[-20:])
    ma60 = np.mean(c[-60:])
    ma250 = np.mean(c[-250:]) if len(c) >= 250 else None

    # 量比
    avg_vol = np.mean(v[-20:-5]) if len(v) >= 20 else np.mean(v[-10:])
    cur_vol = np.mean(v[-5:]) if len(v) >= 5 else v[-1]
    vol_ratio = cur_vol / avg_vol if avg_vol > 0 else 1

    latest_chg = (c[n] / c[n-1] - 1) * 100 if n > 0 else 0

    # ── Pattern D: 新高模式 ──
    recent_high = max(c[-120:]) if len(c) >= 120 else max(c)
    if c[n] >= recent_high * 0.98 and c[n] > ma5 and ma5 > ma10:
        return {'pattern': 'D', 'desc': '阶段新高', 'conf': 4,
                'vol_ratio': round(vol_ratio, 2), 'pct': round(latest_chg, 2)}

    # ── Pattern A: 首板250 ──
    if ma250 and latest_chg > 5 and c[n] > ma250 * 0.98:
        return {'pattern': 'A', 'desc': '首板250', 'conf': 4,
                'vol_ratio': round(vol_ratio, 2), 'pct': round(latest_chg, 2)}

    # ── Pattern B: 上影线试盘 ──
    if highs and lows and n > 0:
        hl_range = highs[n] - lows[n]
        if hl_range > 0:
            upper_shadow = (highs[n] - max(c[n], opens[n])) / hl_range * 100
            if latest_chg > 2 and upper_shadow > 30 and vol_ratio > 1.5 and c[n] > ma20:
                return {'pattern': 'B', 'desc': '上影线试盘', 'conf': 3,
                        'vol_ratio': round(vol_ratio, 2), 'pct': round(latest_chg, 2)}

    # ── Pattern C: 小阳爬升 ──
    small_up = 0
    for i in range(min(15, n)):
        chg = (c[n-i] / c[n-i-1] - 1) * 100
        if 0 < chg < 5:
            small_up += 1
        else:
            break
    if small_up >= 9 and ma250 and c[n] > ma250 and vol_ratio > 1.2:
        return {'pattern': 'C', 'desc': '小阳爬升', 'conf': 4,
                'vol_ratio': round(vol_ratio, 2), 'pct': round(latest_chg, 2)}

    # ── Pattern E: 反包博弈 ──
    if n >= 2:
        prev_chg = (c[n-1] / c[n-2] - 1) * 100
        if prev_chg < -4 and latest_chg > 3 and c[n] > c[n-1] and vol_ratio > 1.2:
            return {'pattern': 'E', 'desc': '反包博弈', 'conf': 3,
                    'vol_ratio': round(vol_ratio, 2), 'pct': round(latest_chg, 2)}

    # ── Pattern F: 上升三法 ──
    if n >= 6:
        d1_chg = (c[n-5] / c[n-6] - 1) * 100
        mid_range = (max(c[n-4:n]) - min(c[n-4:n])) / c[n-5]
        d6_chg = (c[n] / c[n-1] - 1) * 100
        if d1_chg > 3 and mid_range < 0.04 and d6_chg > 2 and c[n] > c[n-5] and vol_ratio > 1.2:
            return {'pattern': 'F', 'desc': '上升三法', 'conf': 3,
                    'vol_ratio': round(vol_ratio, 2), 'pct': round(latest_chg, 2)}

    return None


# ── 主流程 ──
print("=" * 60)
print("  商业航天板块 6形态扫描")
print(f"  {datetime.now().strftime('%Y-%m-%d %H:%M')}")
print("=" * 60)
print()

lg = bs.login()
if lg.error_code != "0":
    print("BaoStock登录失败")
    sys.exit(1)

results = []
total = len(stocks)
today = datetime.now().strftime('%Y-%m-%d')

try:
    for idx, (code, name) in enumerate(stocks):
        bs_code = f"sh.{code}" if code.startswith("6") else f"sz.{code}"
        rs = bs.query_history_k_data_plus(
            bs_code, "date,open,close,high,low,volume",
            frequency="d", adjustflag="2",
            start_date="2024-01-01", end_date=today,
        )
        rows = []
        while (rs.error_code == "0") and rs.next():
            row = rs.get_row_data()
            if row[2] and float(row[2]) > 0:
                rows.append(row)

        if len(rows) < 250:
            if (idx + 1) % 10 == 0:
                print(f"  进度: {idx+1}/{total}")
            continue

        df = pd.DataFrame(rows, columns=["date","open","close","high","low","volume"])
        for col in ["open","close","high","low","volume"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df = df.sort_values("date").reset_index(drop=True)

        closes = df["close"].tolist()
        volumes = df["volume"].tolist()
        highs = df["high"].tolist()
        lows = df["low"].tolist()
        opens = df["open"].tolist()

        if len(closes) < 250:
            continue

        match = detect_patterns(closes, volumes, highs, lows, opens)
        if match:
            results.append({
                "code": code, "name": name,
                "pattern": match["pattern"], "desc": match["desc"],
                "conf": match["conf"], "price": closes[-1],
                "vol_ratio": match["vol_ratio"], "pct": match["pct"],
            })
            print(f"  ✅ {code} {name}: {match['pattern']} ({match['desc']}) "
                  f"涨幅:{match['pct']:+.1f}% 量比:{match['vol_ratio']:.1f}")

        if (idx + 1) % 10 == 0:
            print(f"  进度: {idx+1}/{total} | 已发现 {len(results)} 个")

    # 实时行情覆盖
    if results:
        import urllib.request
        codes = [r["code"] for r in results]
        sina_codes = [("sh" if c.startswith("6") else "sz") + c for c in codes]
        url = "https://hq.sinajs.cn/list=" + ",".join(sina_codes)
        try:
            req = urllib.request.Request(url, headers={"Referer": "https://finance.sina.com.cn"})
            resp = urllib.request.urlopen(req, timeout=15)
            raw = resp.read().decode("gbk")
            for i, line in enumerate(raw.strip().split("\n")):
                if not line.strip() or i >= len(results):
                    continue
                parts = line.split(",")
                if len(parts) >= 6:
                    try:
                        yc = float(parts[2])
                        cp = float(parts[3])
                        if yc > 0 and cp > 0:
                            results[i]["pct"] = round((cp - yc) / yc * 100, 2)
                            results[i]["price"] = cp
                    except:
                        pass
        except:
            pass

finally:
    bs.logout()

print()
print("=" * 60)
print(f"  商业航天板块扫描完成: {len(results)}/{total} 个信号")
print("=" * 60)
print()

if results:
    order = {"D": 0, "A": 1, "B": 2, "C": 3, "E": 4, "F": 5}
    results.sort(key=lambda x: (order.get(x["pattern"], 9), -x["conf"]))

    print(f"| {'代码':>6} | {'名称':<8} | 形态 | 信号说明     | 评分 | 现价   | 涨幅   | 量比 |")
    print(f"|------:|---------|:---:|:-------------|:---:|:------:|:------:|:---:|")
    for r in results:
        print(f"| {r['code']} | {r['name']:<8} | {r['pattern']}   | {r['desc']:<10} | {r['conf']}/5 | {r['price']:.2f} | {r['pct']:+.1f}% | {r['vol_ratio']:.1f} |")

    print()
    pattern_count = Counter(r["pattern"] for r in results)
    print("形态分布:")
    for p in ["D", "A", "B", "C", "E", "F"]:
        if p in pattern_count:
            names = [r["name"] for r in results if r["pattern"] == p]
            print(f"  {p}: {pattern_count[p]} 只 -> {', '.join(names)}")
else:
    print("今日商业航天板块无符合形态的标的")
