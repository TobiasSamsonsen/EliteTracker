"""TEMP probe: characterise Sofascore's 403 from a GitHub runner. Delete after use."""
import time, urllib.request, urllib.error
from curl_cffi import requests as creq
import curl_cffi

print("curl_cffi", curl_cffi.__version__, flush=True)
S = 87867
WWW = f"https://www.sofascore.com/api/v1/unique-tournament/22/season/{S}/events/last/0"
API = f"https://api.sofascore.com/api/v1/unique-tournament/22/season/{S}/events/last/0"
STAT = "https://www.sofascore.com/api/v1/event/13900000/statistics"
CUR = {"Referer": "https://www.sofascore.com/", "Origin": "https://www.sofascore",
       "Accept": "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
       "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin"}


def hit(label, u, **kw):
    try:
        r = creq.get(u, timeout=25, **kw)
        body = r.text[:80].replace("\n", " ")
        print(f"{label:34} {u.split('/')[2]:10} {r.status_code} srv={r.headers.get('server')} {body}", flush=True)
        return r
    except Exception as e:
        print(f"{label:34} {u.split('/')[2]:10} ERR {type(e).__name__} {e}", flush=True)
        return None


for imp in ["safari17_0", "chrome", "chrome131", "chrome136", "firefox133", "firefox135"]:
    hit(f"imp={imp}+CUR www", WWW, headers=CUR, impersonate=imp)
    time.sleep(2)
hit("imp=chrome nohdr www", WWW, impersonate="chrome")
time.sleep(2)
hit("no-imp nohdr www", WWW)
time.sleep(2)
hit("no-imp nohdr api", API)
time.sleep(2)
hit("no-imp nohdr statistics", STAT)
time.sleep(2)
try:
    req = urllib.request.Request(WWW, headers={
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*"})
    with urllib.request.urlopen(req, timeout=25) as rr:
        print("urllib www", rr.status, len(rr.read()), flush=True)
except urllib.error.HTTPError as e:
    print("urllib www", e.code, e.read()[:80], flush=True)
except Exception as e:
    print("urllib www ERR", type(e).__name__, e, flush=True)
time.sleep(3)

print("\n-- burst 15 x safari17_0 0.2s --", flush=True)
codes = []
for _ in range(15):
    try:
        codes.append(creq.get(WWW, headers=CUR, timeout=25, impersonate="safari17_0").status_code)
    except Exception:
        codes.append("E")
    time.sleep(0.2)
print("codes:", codes, flush=True)

print("\n-- retry with backoff on 403 (5 tries) --", flush=True)
for attempt in range(5):
    r = creq.get(WWW, headers=CUR, timeout=25, impersonate="safari17_0")
    print(f"  attempt {attempt}: {r.status_code}", flush=True)
    if r.status_code == 200:
        break
    time.sleep(5 * (attempt + 1))