"""
微信公众号文章获取工具
=====================
使用微信UA绕过验证墙，获取文章正文内容

用法:
    python utils/wechat_fetcher.py <文章链接>

示例:
    python utils/wechat_fetcher.py "https://mp.weixin.qq.com/s/SGtZ5SIPOQ2bXdyDm-_6NA"
"""
import sys, re, requests
from datetime import datetime

# 微信内置浏览器 UA
WECHAT_UA = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.47.2560 NetType/WIFI Language/zh_CN"
)


def fetch_article(url: str) -> dict:
    """获取微信公众号文章，返回结构化内容"""
    headers = {
        "User-Agent": WECHAT_UA,
        "Referer": "https://mp.weixin.qq.com/",
    }
    resp = requests.get(url, headers=headers, timeout=15)
    html = resp.text

    result = {}

    # 文章标题
    m = re.search(r'var msg_title = "(.+?)"', html)
    result["title"] = m.group(1) if m else ""

    # 公众号名称
    m = re.search(r'var nick_name = "(.+?)"', html)
    result["author"] = m.group(1) if m else ""

    # 发布时间
    m = re.search(r'var create_time = "(\d+)"', html)
    if m:
        ts = int(m.group(1))
        result["publish_time"] = datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
    else:
        result["publish_time"] = ""

    # 封面图
    m = re.search(r'var msg_cdn_url = "(.+?)"', html)
    result["cover"] = m.group(1) if m else ""

    # 文章正文
    for cid in ["js_content", "rich_media_content"]:
        pattern = f'id="{cid}"[^>]*>(.*?)</div>'
        m = re.search(pattern, html, re.DOTALL)
        if m:
            body = m.group(1)
            clean = re.sub(r"<[^>]+>", "", body)
            clean = re.sub(r"\s+", " ", clean).strip()
            if len(clean) > 50:
                result["body"] = clean
                break

    if "body" not in result:
        result["body"] = ""
        if "环境异常" in html:
            result["error"] = "触发环境验证"

    return result


def main():
    if len(sys.argv) < 2:
        url = "https://mp.weixin.qq.com/s/SGtZ5SIPOQ2bXdyDm-_6NA"
    else:
        url = sys.argv[1]

    print(f"正在获取: {url}")
    article = fetch_article(url)

    if article.get("error"):
        print(f"❌ {article['error']}")
        return

    print(f"📰 {article.get('title', '无标题')}")
    print(f"👤 {article.get('author', '')}  |  🕐 {article.get('publish_time', '')}")
    print(f"\n{'='*60}")
    print(article.get("body", "无内容"))
    print(f"{'='*60}")
    print(f"\n(正文共 {len(article.get('body', ''))} 字符)")


if __name__ == "__main__":
    main()
