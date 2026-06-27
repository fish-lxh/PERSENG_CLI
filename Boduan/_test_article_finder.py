"""测试自动发现晓胜最新文章"""
import requests, re, sys
from datetime import datetime

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
}

# 1. 从搜狗搜索获取文章列表
url = 'https://weixin.sogou.com/weixin?type=2&query=%E6%99%93%E8%83%9C%E6%B3%A2%E6%AE%B5%E7%8E%8B&ie=utf8'
resp = requests.get(url, headers=headers, timeout=15)
html = resp.text

# 提取文章条目
items = re.findall(r'sogou_vr_\d+_box_\d+.*?</li>', html, re.DOTALL)
articles = []
for item in items:
    m = re.search(r'title_\d+\"[^>]*>(.*?)</a>', item, re.DOTALL)
    title = re.sub(r'<[^>]+>', '', m.group(1)).strip() if m else ''
    # 清理HTML实体
    title = title.replace('&ldquo;', '\u201c').replace('&rdquo;', '\u201d')
    title = title.replace('&hellip;', '...').replace('&mdash;', '\u2014')

    m = re.search(r'timeConvert\((\d+)\)', item)
    ts = int(m.group(1)) if m else 0

    # 提取搜狗链接
    m = re.search(r'href=\"(/link\?url=[^&\"]+)', item)
    sogou_path = m.group(1) if m else ''

    if title and ts:
        articles.append({
            'title': title,
            'ts': ts,
            'pub_time': datetime.fromtimestamp(ts),
            'sogou_path': sogou_path,
        })

articles.sort(key=lambda x: x['ts'], reverse=True)

now = datetime.now()
recent = [a for a in articles if (now - a['pub_time']).days < 5]

print(f'找到 {len(articles)} 篇文章, 其中 {len(recent)} 篇为近5天')
for a in recent:
    print(f'  {a["pub_time"].strftime("%m-%d %H:%M")}  {a["title"]}')

# 2. 尝试用已知文章的 og:url 提取 biz ID
print('\n=== 尝试提取账号的 biz ID ===')
WECHAT_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47.2560 NetType/WIFI Language/zh_CN'

# 从已知文章提取 __biz
known_url = 'https://mp.weixin.qq.com/s/mnGTnzzHtFq5dDyB072Omg'
r = requests.get(known_url, headers={'User-Agent': WECHAT_UA, 'Referer': 'https://mp.weixin.qq.com/'}, timeout=15)
html2 = r.text

# 提取 __biz
m = re.search(r'__biz=(M[^&\"]+)', html2)
if m:
    biz = m.group(1)
    print(f'__biz = {biz}')

    # 尝试访问账号的文章列表页
    profile_url = f'https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz={biz}&scene=124'
    r2 = requests.get(profile_url, headers={'User-Agent': WECHAT_UA, 'Referer': f'https://mp.weixin.qq.com/s/mnGTnzzHtFq5dDyB072Omg'}, timeout=15)
    print(f'文章列表页 HTML长度: {len(r2.text)}')

    # 尝试 appmsg API
    api_url = f'https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_ex&begin=0&count=5&fakeid=&type=9&query=&lang=zh_CN&f=json&ajax=1'
    r3 = requests.get(api_url, headers={'User-Agent': WECHAT_UA, 'Referer': f'https://mp.weixin.qq.com/mp/profile_ext?action=home&__biz={biz}'}, timeout=15)
    print(f'API响应: {r3.text[:200]}')
else:
    print('未找到 __biz')
