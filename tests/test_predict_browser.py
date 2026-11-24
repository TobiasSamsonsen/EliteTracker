"""The page, driven in a real browser against the Auth and Firestore emulators.

The node tests cover the page's pure logic and the Python tests the job and the rules; this walks the
parts that need all of them and a DOM: tip with the keyboard, withdraw a pick, survive a reload, change
the case of a nickname, make a mini-league and see the job build its board. It needs the emulators,
Playwright and its Chromium, so it skips without them (docs/predict.md, "Running it locally"):

    firebase emulators:exec --only auth,firestore --project demo-elitetracker \
        ".venv/Scripts/python -m pytest -q tests/test_predict_browser.py"
"""

from __future__ import annotations

import functools
import http.server
import os
import re
import threading
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from elitetracker.normalize.matches import Match
from elitetracker.predict import sync
from elitetracker.sources.firestore import Firestore

ROOT = Path(__file__).resolve().parent.parent
PROJECT = "demo-elitetracker"
EMPTY_REPORT = {"eliteserien": {"model": {"version": "v"}, "fixtures": []}, "obosligaen": {"model": {"version": "v"}, "fixtures": []}}

pytestmark = pytest.mark.skipif(not os.environ.get("FIRESTORE_EMULATOR_HOST"),
                                reason="needs the Firestore emulator (see tests/test_firestore_rules.py)")


def _match(mid, home, away, kick):
    return Match(match_id=str(mid), date=kick.date().isoformat(), time="12:00", home=home, away=away, home_goals=None,
                 away_goals=None, played=False, kickoff_utc=kick.isoformat().replace("+00:00", "Z"), round=1,
                 home_id=f"{home}-id", away_id=f"{away}-id")


@pytest.fixture()
def site():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT / "public")))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_the_page_against_the_emulators(site, tmp_path):
    sync_api = pytest.importorskip("playwright.sync_api")
    urllib.request.urlopen(urllib.request.Request(
        f"http://{os.environ['FIRESTORE_EMULATOR_HOST']}/emulator/v1/projects/{PROJECT}/databases/(default)/documents",
        method="DELETE")).read()
    store = Firestore(PROJECT)
    now = datetime.now(timezone.utc)
    season = now.year
    first = now + timedelta(days=2)
    matches = {"eliteserien": [_match(101, "Alfa", "Beta", first), _match(102, "Gamma", "Delta", first + timedelta(hours=3)),
                               _match(103, "Eps", "Zeta", first + timedelta(days=1))],
               "obosligaen": [_match(201, "G", "H", first + timedelta(hours=1))]}
    data = tmp_path / "predict"
    sync.run(store, now=now, matches_by_slug=matches, season=season, report=EMPTY_REPORT, data_dir=data)
    key = f"{season}_eliteserien_1"
    entries = lambda: dict(store.query_group("rounds", "r", key))  # noqa: E731

    with sync_api.sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as error:  # noqa: BLE001 - no browser installed here
            pytest.skip(f"no Chromium for Playwright: {str(error)[:80]}")
        context = browser.new_context(viewport={"width": 1100, "height": 900})
        # A returning visitor: the first visit's guide (the tutorial) would stand in front of the round.
        context.add_init_script("try { localStorage.setItem('predict.intro', 'seen'); } catch (e) {}")
        page = context.new_page()
        errors: list[str] = []
        page.on("console", lambda m: m.type == "error" and errors.append(m.text[:160]))
        page.on("pageerror", lambda x: errors.append("pageerror: " + str(x)[:200]))
        # The game is a view of the site; /predict/ is a route page build_site writes, so the plain
        # public/ served here opens it by its query. The fixture site has no season report: the game
        # does not need one.
        page.goto(f"{site}/?view=predict&emulator=1&project={PROJECT}")
        page.wait_for_selector(".pcard", timeout=20000)
        assert page.locator(".pcard").count() == 3
        assert page.locator(".pcard__range").first.get_attribute("aria-valuetext"), "the slider reads its three percents"
        assert page.locator(".pcard__read").first.inner_text(), "every card says in words where it stands"

        # the keyboard accepts the even pick; the page saves it
        page.locator(".pcard__range").first.focus()
        page.keyboard.press("Enter")
        page.wait_for_selector('.pcard__status[data-state="saved"]', timeout=15000)
        found = entries()
        assert len(found) == 1 and "s1" in next(iter(found.values()))["p"]

        # withdrawing a pick removes it on the server
        page.locator(".pcard__clear").first.click()
        page.wait_for_function("() => document.querySelector('.pcard__clear').hidden", timeout=15000)
        assert not next(iter(entries().values()))["p"]

        # tip again; a reload keeps the session and the pick
        page.locator(".pcard__range").first.focus()
        page.keyboard.press("Enter")
        page.wait_for_selector('.pcard__status[data-state="saved"]', timeout=15000)
        page.reload()
        page.wait_for_selector(".pcard", timeout=20000)
        page.wait_for_selector('.pcard__status[data-state="saved"]', timeout=15000)

        # a case-only nickname change is accepted and keeps the 30-day clock
        uid = next(iter(entries())).split("/")[1]
        page.click('button[data-tab="me"]')
        page.wait_for_selector("#pnick", timeout=15000)
        nick = page.input_value("#pnick")
        before = store.get(f"users/{uid}")
        page.fill("#pnick", nick.swapcase())
        page.click(".pme .pinline .pbtn")
        page.wait_for_function("() => document.querySelector('.pme__msg').textContent.length > 0", timeout=15000)
        after = store.get(f"users/{uid}")
        assert after["nick"] == nick.swapcase() and after["nickAt"] == before["nickAt"]

        # a mini-league: the code stays on screen, the profile lists it, the next job run builds its board
        page.click('button[data-tab="leagues"]')
        page.wait_for_selector(".pleagues", timeout=15000)
        page.fill(".pleagues .pfield >> nth=0", "Kontoret")
        page.click(".pleagues .pbtn >> nth=0")
        page.wait_for_function("() => /[A-Z2-9]{8}/.test(document.querySelector('.pleagues__msg').textContent)", timeout=15000)
        code = re.search(r"[A-Z2-9]{8}", page.inner_text(".pleagues__msg")).group(0)
        assert code in (store.get(f"users/{uid}").get("leagues") or [])
        assert store.get(f"leagues/{code}")["name"] == "Kontoret"
        summary = sync.run(store, now=now + timedelta(minutes=5), matches_by_slug=matches, season=season,
                           report=EMPTY_REPORT, data_dir=data)
        assert f"league_{code}" in summary["boards"]

        # the table game is drag only: a club dragged four places in one move lands there, and the order
        # saves itself (no arrows, no save button)
        page.click('button[data-tab="table"]')
        page.wait_for_selector('.ptable[data-state="open"] .ptable__row', timeout=15000)
        rows = page.locator('.ptable[data-state="open"] .ptable__row')
        assert rows.count() >= 5 and page.locator(".ptable .pbtn").count() == 0
        moved = rows.nth(0).get_attribute("data-id")
        a, b = rows.nth(0).bounding_box(), rows.nth(4).bounding_box()
        x, y0 = a["x"] + 120, a["y"] + a["height"] / 2
        page.mouse.move(x, y0)
        page.mouse.down()
        for step in range(1, 11):
            page.mouse.move(x, y0 + (b["y"] - a["y"] + 6) * step / 10)
        page.mouse.up()
        page.wait_for_selector('.ptable-game .ptable__status[data-state="saved"]', timeout=15000)
        assert page.locator(".ptable .ptable__row").nth(4).get_attribute("data-id") == moved
        assert store.get(f"tables/{uid}/picks/{season}_eliteserien")["order"][4] == moved

        # a signed-in anonymous player is offered the Google link; the round picker lists the rounds
        page.click('button[data-tab="me"]')
        page.wait_for_selector(".pdanger", timeout=15000)
        assert page.locator(".pgoogle__button").count() == 1
        page.click('button[data-tab="tip"]')
        page.wait_for_selector(".pnav__pick", timeout=15000)
        assert page.locator(".pnav__pick option").count() >= 1
        # 404s are the missing crests and boards of a fixture season, and the season report the fixture
        # site does not have ([Boot]); anything else is a bug
        assert not [e for e in errors if "Failed to load resource" not in e and "[Boot]" not in e], errors
        browser.close()
