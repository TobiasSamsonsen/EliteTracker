"""Open the further Explore views this branch has (EXPLORE_ITEMS) in headless
Chromium against a static server on public/, fail on console errors, and save
screenshots (desktop and phone, both themes) to the directory given.

    .venv/Scripts/python experiments/improvements/explore_smoke.py OUT_DIR
"""
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright


def explore_items():
    """The Explore views this branch has (EXPLORE_ITEMS in public/app.js)."""
    items = re.search(r"const EXPLORE_ITEMS = \[([^\]]*)\]", Path("public/app.js").read_text(encoding="utf-8")).group(1)
    return set(re.findall(r"'(\w+)'", items))


live = explore_items()
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
server = subprocess.Popen([sys.executable, "-m", "http.server", "8124", "--bind", "127.0.0.1", "--directory", "public"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = "http://127.0.0.1:8124"
for _ in range(50):
    try:
        urllib.request.urlopen(base, timeout=1)
        break
    except Exception:
        time.sleep(0.2)
problems = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for label, viewport, scheme in (("desktop", {"width": 1280, "height": 900}, "light"),
                                        ("phone", {"width": 390, "height": 844}, "dark")):
            page = browser.new_page(viewport=viewport, color_scheme=scheme)
            page.on("console", lambda msg: msg.type == "error" and problems.append(f"{label}: {msg.text}"))
            page.on("pageerror", lambda exc: problems.append(f"{label}: {exc}"))
            page.goto(f"{base}/?view=explore", wait_until="load")
            decline = page.locator("#consent button").first  # the cookie banner hides the charts
            if decline.is_visible():
                decline.click()
            for viz, ready in (("calibration", ".calibration__dot"), ("luck", ".luck__row"), ("runin", ".runin__cell"),
                               ("scorecard", ".scorecard__dot"), ("races", ".races__race"), ("h2h", ".h2h__cell"),
                               ("stakes", ".stakes__cell, .explore-empty")):
                if viz not in live:
                    continue
                for league in ("eliteserien", "obosligaen"):
                    page.goto(f"{base}/?view=explore&viz={viz}&league={league}", wait_until="load")
                    try:
                        page.wait_for_selector(ready, timeout=60000)
                    except Exception as exc:
                        problems.append(f"{label} {viz} {league}: {ready} never appeared ({exc.__class__.__name__})")
                    count = page.locator(ready).count()
                    facts = page.locator(".explore-fact").count()
                    print(f"{label} {viz} {league}: {count} marks, {facts} key figures")
                    page.screenshot(path=str(out / f"{viz}-{league}-{label}.png"), full_page=True)
            page.goto(f"{base}/?view=explore", wait_until="load")
            page.wait_for_selector(".explore-card")
            print(f"{label} gallery: {page.locator('.explore-card').count()} cards")
            page.screenshot(path=str(out / f"gallery-{label}.png"), full_page=True)
            page.close()
        browser.close()
finally:
    server.terminate()
print("PROBLEMS:" if problems else "no console errors")
for problem in problems:
    print("  ", problem)
