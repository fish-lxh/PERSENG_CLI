# -*- coding: utf-8 -*-
"""测试自动发现晓胜最新文章 - 文件版"""
import requests, re, sys, json
from datetime import datetime

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
}

# 1. 从搜狗搜索获取文章列表
url = 'https://weixin.sogou.com/weixin?type=2&query=' + requests.utils.quote('晓胜波段王') + '&ie=utf8'
resp = requests.get(url, headers=headers, timeout=15)
html = resp.text

# 保存到文件分析
with open('_sogou_result.txt', 'w', encoding='utf-8') as f:
    f.write(html)

# 提取文章 - 用更简单的方法
items = re.findall(r'uigs="article_title_\d+">(.*?)</a>', html)
times = re.findall(r'timeConvert\((\d+)\)', html)

print(f'找到 {len(items)} 篇文章标题')
for i, (title, ts_str) in enumerate(zip(items, times)):
    ts = int(ts_str)
    dt = datetime.fromtimestamp(ts)
    print(f'  {i+1}. [{dt.strftime("%m-%d %H:%M")}] {title}')

# 2. 查找已知文章的 __biz
WECHAT_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47.2560 NetType/WIFI Language/zh_CN'

known_url = 'https://mp.weixin.qq.com/s/mnGTnzzHtFq5dDyB072Omg'
r = requests.get(known_url, headers={'User-Agent': WECHAT_UA}, timeout=15)
html2 = r.text

with open('_article_page.txt', 'w', encoding='utf-8') as f:
    f.write(html2)

# 找 __biz 和 公众号ID
for keyword in ['__biz', 'gh_', 'fakeid', 'biz', 'nick_name', 'nickname']:
    idx = html2.find(keyword)
    if idx >= 0:
        snippet = html2[max(0,idx-20):idx+80]
        print(f'\n找到 "{keyword}" at {idx}:')
        print(f'  {snippet}')
