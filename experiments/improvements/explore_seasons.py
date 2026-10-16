"""The Explore views with a season: each kept view on a past season, rewound
where it follows the slider, the time-axis views ignoring a rewind, a finished
season's run-in and stakes standing ten rounds from the end, the hero and
slider shown where they should be, and a season change through the hero's own
picker. Only the views this branch has (EXPLORE_ITEMS) are opened. Needs
public/data built.

    .venv/Scripts/python experiments/improvements/explore_seasons.py OUT_DIR
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
data = Path("public/data")
late_2019 = sorted(p.name[len("report-2019-"):-5] for p in data.glob("report-2019-2019-*.json"))[-8]
server = subprocess.Popen([sys.executable, "-m", "http.server", "8125", "--bind", "127.0.0.1", "--directory", "public"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
base = "http://127.0.0.1:8125"
for _ in range(50):
    try:
        urllib.request.urlopen(base, timeout=1)
        break
    except Exception:
        time.sleep(0.2)
problems = []


def visible(page, selector):
    return page.locator(selector).first.is_visible() if page.locator(selector).count() else False


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("console", lambda msg: msg.type == "error" and problems.append(msg.text))
        page.on("pageerror", lambda exc: problems.append(str(exc)))
        page.goto(f"{base}/?view=explore", wait_until="load")
        if page.locator("#consent button").first.is_visible():
            page.locator("#consent button").first.click()
        cases = [
            # viz, season, asof, what must render, hero?, season picker?, slider?
            ("races", 2019, None, ".races__club", True, True, False),
            ("races", 2019, late_2019, ".races__club", True, True, False),  # the rewind is ignored
            ("luck", 2021, None, ".luck__row", True, True, True),
            ("luck", 2019, None, ".explore-empty", True, True, True),       # no xG that season (Eliteserien from 2020)
            ("runin", 2019, None, ".runin__cell", True, True, False),       # finished: ten rounds from the end
            ("runin", 2019, late_2019, ".runin__cell", True, True, False),
            ("stakes", 2019, None, ".stakes__cell, .explore-empty", True, True, False),
            ("runin", 2026, None, ".runin__cell, .explore-empty", True, True, False),  # under way: from today
            ("h2h", 2019, None, ".h2h__cell", True, True, False),
            ("scorecard", 2019, None, ".scorecard__dot", True, False, False),
            ("calibration", 2019, None, ".calibration__dot", False, False, False),
        ]
        for viz, season, asof, ready, hero, picker, slider in cases:
            if viz not in live:
                continue
            url = f"{base}/?view=explore&viz={viz}&season={season}" + (f"&asof={asof}" if asof else "")
            page.goto(url, wait_until="load")
            try:
                page.wait_for_selector(ready, timeout=60000)
            except Exception:
                problems.append(f"{viz} {season} {asof}: {ready} never appeared")
            got = (visible(page, ".hero"), visible(page, '.hero-title-part[data-role="season"]'), visible(page, ".timeline-section"))
            title = page.locator("#hero-title").inner_text() if got[0] else ""
            print(f"{viz:<12} {season} {asof or 'live':<10} hero {got[0]!s:<5} season-picker {got[1]!s:<5} slider {got[2]!s:<5} "
                  f"marks {page.locator(ready).count():<4} title {title.split(',')[0]!r}")
            if got != (hero, picker, slider):
                problems.append(f"{viz}: hero/picker/slider {got}, expected {(hero, picker, slider)}")
            if hero and str(season) not in title and viz != "scorecard":
                problems.append(f"{viz}: hero title {title!r} does not show {season}")
            if viz in ("runin", "stakes"):
                lead = page.locator(".explore-note--lead")
                note = lead.first.text_content() if lead.count() else ""
                print(f"{'':<12} lead note {note!r}")
                if (season == 2019) != bool(note):
                    problems.append(f"{viz} {season}: lead note {note!r}")
            page.screenshot(path=str(out / f"{viz}-{season}-{asof or 'live'}.png"), full_page=True)
        # A season change through the hero's own picker re-renders the view.
        if "luck" in live:
            page.goto(f"{base}/?view=explore&viz=luck&season=2024", wait_until="load")
            page.wait_for_selector(".luck__row")
            before = page.locator(".luck__name").evaluate_all("els => els.map((e) => e.textContent)")
            page.locator('.hero-title-part[data-role="season"]').click()
            page.locator('#hero-season-menu button:has-text("2021")').first.click()
            page.wait_for_function("() => document.querySelector('#hero-title').innerText.includes('2021')", timeout=60000)
            page.wait_for_selector(".luck__row")
            after = page.locator(".luck__name").evaluate_all("els => els.map((e) => e.textContent)")
            print(f"luck via the hero's picker: 2024 {before[:3]} -> 2021 {after[:3]}; url {page.url.split('?')[1]}")
            if before == after:
                problems.append("the luck table did not change with the season")
            if "season=2021" not in page.url:
                problems.append("season change did not reach the URL")
        browser.close()
finally:
    server.terminate()
print("PROBLEMS:" if problems else "no problems")
for problem in problems:
    print("  ", problem)
