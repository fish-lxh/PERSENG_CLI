# -*- coding: utf-8 -*-
import urllib.request, json
from datetime import datetime

# 获取大盘
codes = ['sh000001', 'sz399001', 'sz399006', 'sh000688']
names = ['上证指数', '深证成指', '创业板指', '科创50']
url = 'https://hq.sinajs.cn/list=' + ','.join(codes)
req = urllib.request.Request(url, headers={'Referer': 'https://finance.sina.com.cn'})
resp = urllib.request.urlopen(req, timeout=10)
data = resp.read().decode('gbk')

print('【收盘大盘】2026-05-22 周五')
print('-' * 40)
for i, line in enumerate(data.strip().split('\n')):
    if line.strip():
        parts = line.split(',')
        if len(parts) > 3:
            last = float(parts[2])
            price = float(parts[3])
            chg = ((price - last) / last) * 100 if last > 0 else 0
            vol = float(parts[8]) if parts[8] else 0
            arrow = '↑' if chg > 0 else ('↓' if chg < 0 else '→')
            print(f'{names[i]}: {price:>8.2f}  {arrow}{chg:>+6.2f}%  成交:{vol/100:.0f}亿')

# 获取关键个股
print()
print('【核心个股】')
print('-' * 40)
stocks = ['sh600584', 'sz000636', 'sh603989', 'sz300853', 'sh688079', 'sz002156']
snames = ['长电科技', '风华高科', '艾华集团', '申昊科技', '美迪凯', '通富微电']
url = 'https://hq.sinajs.cn/list=' + ','.join(stocks)
req = urllib.request.Request(url, headers={'Referer': 'https://finance.sina.com.cn'})
resp = urllib.request.urlopen(req, timeout=10)
data = resp.read().decode('gbk')
for i, line in enumerate(data.strip().split('\n')):
    if line.strip():
        parts = line.split(',')
        if len(parts) > 5:
            last = float(parts[2])
            price = float(parts[3])
            chg = ((price - last) / last) * 100 if last > 0 else 0
            arrow = '↑' if chg > 0 else ('↓' if chg < 0 else '→')
            print(f'{snames[i]:<8} {price:>8.2f}  {arrow}{chg:>+6.2f}%  昨收:{last:>6.2f}')
