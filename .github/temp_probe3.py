"""TEMP probe 3: is the Sofascore block per-IP or the whole Azure range? Does it lift? Delete after use."""
import time, urllib.request, urllib.error, socket, json

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
SOFA = "https://www.sofascore.com/api/v1/unique-tournament/22/seasons"


def code(url, headers=None):
    h = {"User-Agent": UA, "Accept": "*/*"}
    h.update(headers or {})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=25) as r:
            return r.status, r.read()[:100]
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:100]
    except Exception as e:
        return None, str(e).encode()[:100]


for i in range(3):
    ip = code("https://api.ipify.org")[1].decode(errors="replace")
    st, body = code(SOFA)
    print(f"attempt {i}: ip={ip} sofa={st} {body[:60]!r}", flush=True)
    if i < 2:
        time.sleep(20)

print("\n-- IPv6 egress? --", flush=True)
try:
    infos = socket.getaddrinfo("api.ipify.org", 443, socket.AF_INET6)
    print("  has AAAA:", bool(infos), flush=True)
except Exception as e:
    print("  no ipv6:", e, flush=True)
st, body = code("https://api6.ipify.org")
print("  api6.ipify:", st, body[:60], flush=True)
time.sleep(2)

print("\n-- control: fotmob + football-data.co.uk (not blocked) --", flush=True)
for u in ["https://www.fotmob.com/api/data/matchDetails?matchId=5105269",
          "https://www.football-data.co.uk/mmz4281/2526/N1.csv"]:
    st, b = code(u)
    print(f"  {st} {u[:70]} {b[:40]!r}", flush=True)
    time.sleep(2)

print("\n-- do sofascore's own CDN assets resolve elsewhere? --", flush=True)
for host in ["www.sofascore.com", "api.sofascore.com"]:
    try:
        print(" ", host, socket.gethostbyname_ex(host)[2], flush=True)
    except Exception as e:
        print(" ", host, "dns err", e, flush=True)