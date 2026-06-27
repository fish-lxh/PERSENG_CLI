import baostock as bs
import pandas as pd
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

lg = bs.login()

# 中京电子 = 002579
rs = bs.query_history_k_data_plus(
    "sz.002579",
    "date,open,close,high,low,volume,pctChg",
    start_date="2026-05-20",
    end_date="2026-06-03",
    frequency="d",
    adjustflag="2"
)

rows = []
while rs.next():
    rows.append(rs.get_row_data())
df = pd.DataFrame(rows, columns=rs.fields)

print(f"{'日期':<10} {'开盘':<10} {'收盘':<10} {'最高':<10} {'最低':<10} {'涨跌幅':<8} {'量比':<6}")
print("-"*60)
vols = df['volume'].astype(float)
avg_vol = vols.mean()
for i, row in df.iterrows():
    vr = float(row['volume']) / avg_vol if avg_vol > 0 else 0
    print(f"{row['date']:<10} {float(row['open']):<10.2f} {float(row['close']):<10.2f} {float(row['high']):<10.2f} {float(row['low']):<10.2f} {float(row['pctChg']):<+7.2f}% {vr:<.2f}")

# 最新行情
rs2 = bs.query_stock_basic("sz.002579")
if rs2.error_code == "0":
    while rs2.next():
        row = rs2.get_row_data()
        print(f"\n名称: {row[1]}")
        print(f"行业: {row[2]}")

bs.logout()
