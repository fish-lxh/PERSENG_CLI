# -*- coding: utf-8 -*-
import urllib.request
import json

print("=" * 50)
print("【大盘指数】")
print("=" * 50)
codes = ['sh000001', 'sz399001', 'sz399006', 'sh000688']
names = ['上证指数', '深证成指', '创业板指', '科创50']
url = 'https://hq.sinajs.cn/list=' + ','.join(codes)
req = urllib.request.Request(url, headers={'Referer': 'https://finance.sina.com.cn'})
resp = urllib.request.urlopen(req, timeout=10)
data = resp.read().decode('gbk')
for i, line in enumerate(data.strip().split('\n')):
    if line.strip():
        parts = line.split(',')
        last_close = float(parts[2]) if parts[2] else 0
        price = float(parts[3]) if parts[3] else 0
        chg = ((price - last_close) / last_close) * 100 if last_close > 0 else 0
        arrow = '↑' if chg > 0 else ('↓' if chg < 0 else '→')
        print(f'  {names[i]}: {price:.2f}  {arrow} {chg:+.2f}%')

print()
print("=" * 50)
print("【候选个股】")
print("=" * 50)
codes = ['sh600584', 'sz301319', 'sh600847', 'sz301171', 'sh688619', 'sh600719', 'sz300342', 'sz300845']
names = ['长电科技', '唯特偶', '万里股份', '易点天下', '罗普特', '大连热电', '达实智能', '海伦哲']
url = 'https://hq.sinajs.cn/list=' + ','.join(codes)
req = urllib.request.Request(url, headers={'Referer': 'https://finance.sina.com.cn'})
resp = urllib.request.urlopen(req, timeout=10)
data = resp.read().decode('gbk')
print(f'  {"个股":<8} {"现价":>8} {"涨跌":>10} {"最高":>8} {"最低":>8}')
print('  ' + '-' * 48)
for i, line in enumerate(data.strip().split('\n')):
    if line.strip():
        parts = line.split(',')
        if len(parts) > 5:
            last = float(parts[2]) if parts[2] != '0.00' else 0
            price = float(parts[3]) if parts[3] else 0
            chg = ((price - last) / last) * 100 if last > 0 else 0
            arrow = '↑' if chg > 0 else ('↓' if chg < 0 else '→')
            print(f'  {names[i]:<8} {price:>8.2f}  {arrow}{chg:>+7.2f}%  {parts[4]:>8}  {parts[5]:>8}')

print()
print("=" * 50)
print("【涨跌家数】")
print("=" * 50)
try:
    url2 = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f4,f12,f14&secids=1.000001&srb=0'
    req2 = urllib.request.Request(url2, headers={'User-Agent': 'Mozilla/5.0'})
    resp2 = urllib.request.urlopen(req2, timeout=10)
    print(f'  涨跌家数获取中...')
except:
    print('  涨跌家数: 获取失败')
