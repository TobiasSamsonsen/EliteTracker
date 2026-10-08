"""TEMP probe 2: scope of the Sofascore block on a GH runner + alternative egress. Delete after use."""
import time, socket, urllib.request, urllib.error, json
from curl_cffi import requests as creq

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


def plain(label, url, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    try:
        req = urllib.request.Request(url, headers=h)
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read()
        print(f"{label:38} {r.status} {url[:60]} bytes={len(body)} {body[:70]!r}", flush=True)
        return r.status, body
    except urllib.error.HTTPError as e:
        b = e.read()
        print(f"{label:38} {e.code} {url[:60]} srv={e.headers.get('server')} {b[:70]!r}", flush=True)
        return e.code, b
    except Exception as e:
        print(f"{label:38} ERR {type(e).__name__} {url[:60]} {e}", flush=True)
        return None, b""


print("== runner egress IP ==", flush=True)
try:
    with urllib.request.urlopen("https://api.ipify.org?format=json", timeout=20) as r:
        print("  ipify:", r.read().decode(), flush=True)
except Exception as e:
    print("  ipify ERR", e, flush=True)
try:
    print("  reverse DNS:", socket.gethostbyaddr(socket.gethostbyname("api.ipify.org"))[0], flush=True)
except Exception as e:
    print("  dns ERR", e, flush=True)

print("\n== is the whole sofascore domain blocked, or only /api/? ==", flush=True)
plain("homepage html", "https://www.sofascore.com/")
time.sleep(2)
plain("robots.txt", "https://www.sofascore.com/robots.txt")
time.sleep(2)
plain("api config endpoint", "https://www.sofascore.com/api/v1/config/all/unique-tournaments")
time.sleep(2)
plain("api footballer search", "https://www.sofascore.com/api/v1/search/all?q=Eliteserien")
time.sleep(2)
plain("api host homepage", "https://api.sofascore.com/api/v1/sport/football/scheduled-events/2026-10-04")

print("\n== other sofascore-ish hosts ==", flush=True)
for host in ["https://www.sofascore.com/api/v1/event/12000000/statistics",
             "https://m.sofascore.com/api/v1/unique-tournament/22/seasons",
             "https://cdn.sofascore.com/",
             "https://www.sofascore.com/api/v1/tournament/22/season/87867/events/last/0"]:
    plain("host", host)
    time.sleep(2)

print("\n== does egress through a public fetch proxy change the verdict? ==", flush=True)
for label, u in [
    ("r.jina.ai", "https://r.jina.ai/https://www.sofascore.com/api/v1/unique-tournament/22/seasons"),
    ("allorigins", "https://api.allorigins.win/raw?url=https%3A%2F%2Fwww.sofascore.com%2Fapi%2Fv1%2Funique-tournament%2F22%2Fseasons"),
    ("codetabs", "https://api.codetabs.com/v1/proxy?quest=https://www.sofascore.com/api/v1/unique-tournament/22/seasons"),
]:
    st, body = plain(label, u)
    print(f"    -> {label} {st} head={body[:120]!r}", flush=True)
    time.sleep(3)

print("\n== sanity: fotmob from the same runner (it works in refresh) ==", flush=True)
plain("fotmob league", "https://www.fotmob.com/api/leagues?id=59&ccode3=NOR_MA")
time.sleep(2)
st, body = plain("fotmob matches", "https://www.fotmob.com/api/data/matchDetails?matchId=5105269")
if st == 200:
    j = json.loads(body)
    print("    OBOS 5105269 shots:",
          len((j.get("content", {}).get("shotmap", {}) or {}).get("shots", [])), flush=True)