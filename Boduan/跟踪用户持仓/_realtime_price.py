import urllib.request
import json

for code, name in [("0.002579", "ZhongJing"), ("1.600905", "SanXia")]:
    url = "http://push2.eastmoney.com/api/qt/stock/get?secid=" + code + "&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f58,f170,f171"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode("utf-8"))
        d = data.get("data", {})
        if d:
            print(name + ":")
            print("  now: " + str(d.get("f43")) + "  pct: " + str(d.get("f170")) + "%")
            print("  high: " + str(d.get("f44")) + "  low: " + str(d.get("f45")) + "  open: " + str(d.get("f46")))
            print("  prevClose: " + str(d.get("f60")) + "  volume: " + str(d.get("f47")) + "  amount: " + str(d.get("f48")))
            print()
    except Exception as e:
        print(name + ": Error - " + str(e))
