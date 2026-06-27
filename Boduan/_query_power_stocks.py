# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding='utf-8')
import requests

headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': 'https://finance.sina.com.cn'}

# 电力协同板块知名龙头股
power_stocks = {
    '600406': '国电南瑞',   # 电力物联网龙头
    '601567': '三星医疗',   # 智能电网
    '600131': '国网信通',   # 电力数字化
    '601179': '中国西电',   # 特高压
    '600312': '平高电气',   # 特高压
    '600089': '特变电工',   # 特高压
    '300286': '安科瑞',     # 电力物联网/能效管理
    '300360': '炬华科技',   # 智能电表/电力物联网
    '300124': '汇川技术',   # 工控/新能源
    '002028': '思源电气',   # 电力设备
    '300274': '阳光电源',   # 储能/逆变器
    '300763': '锦浪科技',   # 储能/逆变器
    '002518': '科士达',     # 储能/充电桩
    '600905': '三峡能源',   # 绿色电力
    '600886': '国投电力',   # 绿色电力
    '600025': '华能水电',   # 绿色电力
    '300693': '盛弘股份',   # 储能/充电桩
    '002121': '科陆电子',   # 储能/智能电网
    '688663': '新风光',     # 电力物联网
    '300882': '万胜智能',   # 智能电表
}

sina_codes = []
for c in power_stocks.keys():
    prefix = 'sh' if c.startswith('6') or c.startswith('5') else 'sz'
    sina_codes.append(prefix + c)

url = 'https://hq.sinajs.cn/list=' + ','.join(sina_codes)

try:
    r = requests.get(url, headers=headers, timeout=10)
    r.encoding = 'gbk'
    lines = r.text.strip().split('\n')

    print('=== 电力协同板块龙头股今日行情 ===')
    print(f'{"代码":<8} {"名称":<10} {"最新价":>8} {"涨跌幅":>8}')
    print('-' * 38)

    results = []
    for line in lines:
        parts = line.split('=')
        if len(parts) < 2:
            continue
        data = parts[1].strip('";\n').split(',')
        if len(data) < 8:
            continue
        name = data[0]
        yesterday = float(data[2]) if data[2] else 0
        current = float(data[3]) if data[3] else 0

        if yesterday > 0 and current > 0:
            pct = (current - yesterday) / yesterday * 100
        else:
            pct = 0

        # 匹配代码
        matched_code = ''
        for oc, on in power_stocks.items():
            if on == name:
                matched_code = oc
                break

        results.append((matched_code, name, current, pct))

    # 按涨跌幅排序
    results.sort(key=lambda x: x[3], reverse=True)

    for code, name, price, pct in results:
        print(f'{code:<8} {name:<10} {price:>8.2f} {pct:>+7.2f}%')

    print()
    print('--- 涨幅排名 ---')
    for i, item in enumerate(results[:5], 1):
        print(f'{i}. {item[1]} ({item[0]}): {item[3]:+.2f}% @ {item[2]:.2f}')

    print()
    print('--- 跌幅排名 ---')
    for i, item in enumerate(results[-3:], 1):
        print(f'{i}. {item[1]} ({item[0]}): {item[3]:+.2f}% @ {item[2]:.2f}')

except Exception as e:
    print(f'获取失败: {e}')
