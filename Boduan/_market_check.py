# -*- coding: utf-8 -*-
import urllib.request

# 大盘指数
idx_codes = ['sh000001', 'sz399001', 'sz399006', 'sh000688']
idx_names = ['上证指数', '深证成指', '创业板指', '科创50']
url = 'https://hq.sinajs.cn/list=' + ','.join(idx_codes)
req = urllib.request.Request(url, headers={'Referer': 'https://finance.sina.com.cn'})
resp = urllib.request.urlopen(req, timeout=10)
data = resp.read().decode('gbk')

print('【大盘指数】13:40')
print('-' * 40)
for i, line in enumerate(data.strip().split('\n')):
    if line.strip():
        parts = line.split(',')
        if len(parts) > 3:
            last = float(parts[2])
            price = float(parts[3])
            chg = ((price - last) / last) * 100 if last > 0 else 0
            arrow = '↑' if chg > 0 else ('↓' if chg < 0 else '→')
            print(f'  {idx_names[i]}: {price:.2f}  {arrow}{chg:+.2f}%')

# 昨天候选股 + 长电科技
print()
print('【重要个股】')
print('-' * 40)
stocks = ['sh600584', 'sh688323', 'sz002156', 'sz000636', 'sh603989', 'sz300853', 'sz301319', 'sh600847', 'sz301171', 'sh688619', 'sh600719', 'sz300342', 'sz300845']
names = ['长电科技', '瑞华泰', '通富微电', '风华高科', '艾华集团', '申昊科技', '唯特偶', '万里股份', '易点天下', '罗普特', '大连热电', '达实智能', '海伦哲']
url = 'https://hq.sinajs.cn/list=' + ','.join(stocks)
req = urllib.request.Request(url, headers={'Referer': 'https://finance.sina.com.cn'})
resp = urllib.request.urlopen(req, timeout=10)
data = resp.read().decode('gbk')
print(f'  {"个股":<8} {"现价":>8} {"涨跌":>10} {"最高":>8} {"最低":>8}')
print('  ' + '-' * 48)
for i, line in enumerate(data.strip().split('\n')):
    if line.strip():
        parts = line.split(',')
        if len(parts) > 5:
            last = float(parts[2])
            price = float(parts[3])
            chg = ((price - last) / last) * 100 if last > 0 else 0
            arrow = '↑' if chg > 0 else ('↓' if chg < 0 else '→')
            print(f'  {names[i]:<8} {price:>8.2f}  {arrow}{chg:>+7.2f}%  {parts[4]:>8}  {parts[5]:>8}')
