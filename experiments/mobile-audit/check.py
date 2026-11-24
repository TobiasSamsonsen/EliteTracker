#!/usr/bin/env python3
"""Repeatable mobile-first check of every view (Playwright, Chromium).

For each viewport (phones emulated with touch and a coarse pointer, plus one
desktop) and each view, asserts:

  1. no sideways page overflow (documentElement.scrollWidth <= innerWidth);
  2. the masthead's parts and the fixed bottom bars (tab bar, consent, What
     if's bar) do not overlap each other or leave the screen;
  3. on a phone, every visible control is at least 44px on its short side,
     or 24px inside a dense data table or chart (the row is the fallback);
  4. no console errors or uncaught page errors.

Serves public/ itself (extension-less paths fall back to index.html, as the
local API server does), so it needs a built public/data.

  .venv/Scripts/python experiments/mobile-audit/check.py
  .venv/Scripts/python experiments/mobile-audit/check.py --only 360x800 --views grid,table --shots

Exit status 1 when any check fails; --json prints the findings.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import json
import re
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public"

VIEWPORTS = [
    # name, width, height, phone (touch + coarse pointer + mobile UA)
    ("360x800", 360, 800, True),
    ("375x812", 375, 812, True),
    ("390x844", 390, 844, True),
    ("430x932", 430, 932, True),
    ("1280x800", 1280, 800, False),
]
EXPLORE = ["mountain", "attack", "luck", "races", "whatif", "runin", "playoff"]
# The Predict view, its five tabs and the guide, with Firestore answered from a small fixture (see predict_fixture).
PREDICT = ["predict", "predict:table", "predict:boards", "predict:leagues", "predict:me", "predict:how"]
VIEWS = (["overview", "grid", "table", "matches", "ladder", "compare", "explore"]
         + [f"explore:{item}" for item in EXPLORE] + ["model", "team"] + PREDICT)

READY_PREDICT_JS = """() => {
  const view = document.getElementById('predict-view');
  return !!view && view.children.length > 0 && !view.querySelector('.pload, .pskeleton');
}"""

READY_JS = """() => {
  const content = document.getElementById('content');
  return !!content && !content.hidden && document.body.dataset.view !== undefined;
}"""

# The four checks, in the page. Returns plain data.
CHECK_JS = r"""(phone) => {
  const out = { overflow: null, overlaps: [], offscreen: [], small: [] };
  const doc = document.documentElement;
  if (doc.scrollWidth > innerWidth + 1) {
    const wide = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > innerWidth + 1 && getComputedStyle(el).position !== 'fixed') {
        wide.push(describe(el) + ' right=' + Math.round(r.right));
        if (wide.length > 4) break;
      }
    }
    out.overflow = { scrollWidth: doc.scrollWidth, innerWidth, wide };
  }
  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return text ? `${s} "${text}"` : s;
  }
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const meet = (a, b) => {
    const p = a.getBoundingClientRect(), q = b.getBoundingClientRect();
    return Math.min(p.right, q.right) - Math.max(p.left, q.left) > 1
      && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 1;
  };
  // 2. The masthead's parts side by side; the fixed bottom bars stacked.
  const head = ['.wordmark', '.masthead__views', '.league-picker', '#settings-btn']
    .map((s) => document.querySelector(s)).filter(shown);
  for (let i = 0; i < head.length; i += 1) {
    const r = head[i].getBoundingClientRect();
    if (r.left < -1 || r.right > innerWidth + 1) out.offscreen.push(describe(head[i]));
    for (let j = i + 1; j < head.length; j += 1) {
      if (head[i].matches('.masthead__views') || head[j].matches('.masthead__views')) continue;
      if (meet(head[i], head[j])) out.overlaps.push(describe(head[i]) + ' x ' + describe(head[j]));
    }
  }
  const bars = ['#mobilebar', '#consent', '.whatif__bar', '#timeline-toggle.is-floating']
    .map((s) => document.querySelector(s)).filter(shown)
    .filter((el) => getComputedStyle(el).position === 'fixed');
  for (let i = 0; i < bars.length; i += 1) {
    const r = bars[i].getBoundingClientRect();
    if (r.bottom > innerHeight + 1 || r.left < -1 || r.right > innerWidth + 1) out.offscreen.push(describe(bars[i]));
    for (let j = i + 1; j < bars.length; j += 1) if (meet(bars[i], bars[j])) out.overlaps.push(describe(bars[i]) + ' x ' + describe(bars[j]));
  }
  // 3. Touch targets, on a phone only.
  if (phone) {
    const dense = 'table, svg, .grid, .ladder__track, .mountain, .scenario__table, .whatif-impact, .team-grid, .calibration, .luck, .runin, .ptable, .pcal';
    const seen = new Set();
    for (const el of document.querySelectorAll('main button, main a[href], main [role="tab"], main input, main select, header button, header a[href], #mobilebar button, aside button, .doc__top button, .doc__top a[href], .ptabs button')) {
      if (!shown(el) || el.disabled || el.closest('[hidden], [inert], .visually-hidden')) continue;
      if (el.closest('footer')) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > document.documentElement.scrollHeight) continue;
      // Inline links inside running text are exempt (WCAG 2.5.8 inline exception).
      if (el.matches('a') && el.closest('p, li') && !el.closest('nav')) continue;
      if (el.matches('input[type="range"]')) continue;
      const floor = el.closest(dense) ? 24 : 44;
      let w = r.width, h = r.height;
      const self = getComputedStyle(el);
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === 'none' || ps.position !== 'absolute') continue;
        if (self.position === 'static') { w = h = Infinity; break; } // a stretched link: the card is the target
        const px = (v) => (v.endsWith('px') ? parseFloat(v) : 0);
        w = Math.max(w, r.width - px(ps.left) - px(ps.right));
        h = Math.max(h, r.height - px(ps.top) - px(ps.bottom));
      }
      const short = Math.min(w, h);
      if (short + 0.5 < floor) {
        const key = describe(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' (<' + floor + ')';
        if (!seen.has(key)) { seen.add(key); out.small.push(key); }
      }
    }
  }
  return out;
}"""


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files from public/; an extension-less path answers index.html."""

    def log_message(self, *args) -> None:  # quiet
        pass

    def handle(self) -> None:
        # A browser drops connections it no longer needs on navigation.
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def do_GET(self) -> None:  # noqa: N802 - name fixed by the base class
        path = self.path.split("?", 1)[0]
        last = path.rstrip("/").rsplit("/", 1)[-1]
        if "." not in last and not (PUBLIC / path.lstrip("/") / "index.html").exists():
            self.path = "/index.html" + self.path[len(path):]
        super().do_GET()


def serve() -> tuple[str, http.server.ThreadingHTTPServer]:
    handler = functools.partial(Handler, directory=str(PUBLIC))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}", server


def predict_fixture(now: datetime | None = None) -> dict[str, dict]:
    """Firestore documents (path -> fields) for a round that is open now in both divisions and an open
    table game, so /predict/ shows real cards without touching the real project."""
    now = now or datetime.now(timezone.utc)
    season = now.year
    docs: dict[str, dict] = {}
    # Real club ids with a crest in public/logos (the cards and the table game show crests; a missing one is a 404).
    ids = sorted(p.stem for p in (PUBLIC / "logos").glob("*.webp"))[:16]
    clubs = {cid: f"Klubb {chr(65 + i)}" for i, cid in enumerate(ids)}
    order = list(clubs)
    for slug in ("eliteserien", "obosligaen"):
        key = f"{season}_{slug}_5"
        kicks = [now + timedelta(days=1, hours=3 * i) for i in range(4)]
        slots = {f"s{i + 1}": {"id": str(i), "home": clubs[order[2 * i]], "away": clubs[order[2 * i + 1]],
                              "home_id": order[2 * i], "away_id": order[2 * i + 1], "kickoff": kicks[i]} for i in range(4)}
        docs[f"fixtures/{key}"] = {"season": season, "league": slug, "round": 5, "opens": now - timedelta(days=2),
                                   "closes": kicks[0], "slots": slots}
        docs.setdefault("meta/rounds", {"season": season, "rounds": []})["rounds"].append(
            {"key": key, "league": slug, "round": 5, "opens": now - timedelta(days=2), "closes": kicks[0],
             "last": kicks[-1], "n": 4, "ks": kicks, "settled": 0})
        rows = [{"u": "model", "nick": "Modellen", "kind": "model", "n": 40, "ab": -0.4, "ar": -0.3, "b": 0.58, "r": 0.2, "vm": 0.0, "rank": 2},
                {"u": "ab12cd34ef", "nick": "Tipper_1", "kind": "player", "n": 40, "ab": 1.2, "ar": 0.8, "b": 0.55, "r": 0.19, "vm": 0.6, "rank": 1},
                {"u": "ff00ff00ff", "nick": "Ola Nordmann", "kind": "player", "n": 36, "ab": -1.1, "ar": -0.7, "b": 0.63, "r": 0.24, "vm": -0.5, "rank": 3}]
        for scope in ("season", "round", "last10"):
            docs[f"boards/{scope}_{season}_{slug}"] = {"scope": scope, "updated": now.isoformat(), "players": 3, "rows": rows,
                                                      "pct": [round(-1.1 + 2.3 * p / 100, 4) for p in range(101)]}
        docs[f"tablegames/{season}_{slug}"] = {"season": season, "league": slug, "opens": now - timedelta(days=1),
                                               "closes": now + timedelta(days=3), "clubs": sorted(clubs), "names": clubs}
    return docs


def route_firestore(context, docs: dict[str, dict]) -> None:
    """Answer the page's Firestore reads from ``docs``, anything else with 404 (no network, no real project)."""
    from elitetracker.sources.firestore import encode

    def handler(route) -> None:
        url = route.request.url
        path = url.split("/documents/", 1)[1].split("?", 1)[0] if "/documents/" in url else ""
        doc = docs.get(path)
        if route.request.method == "GET" and doc is not None:
            body = {"name": "projects/x/databases/(default)/documents/" + path,
                    "fields": {k: encode(v) for k, v in doc.items()}}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(body))
        else:
            route.fulfill(status=404, content_type="application/json",
                          body=json.dumps({"error": {"code": 404, "status": "NOT_FOUND"}}))
    context.route(re.compile(r"https://firestore\.googleapis\.com/.*"), handler)
    context.route(re.compile(r"https://(identitytoolkit|securetoken)\.googleapis\.com/.*"),
                  lambda route: route.fulfill(status=400, content_type="application/json",
                                              body=json.dumps({"error": {"message": "OPERATION_NOT_ALLOWED"}})))


def url_for(base: str, view: str, team: str | None) -> str:
    if view.startswith("predict"):
        tab = view.split(":", 1)[1] if ":" in view else ""
        return f"{base}/?view=predict" + (f"#{tab}" if tab else "")
    if view == "team":
        return f"{base}/?team={team}"
    if view.startswith("explore:"):
        return f"{base}/?view=explore&viz={view.split(':', 1)[1]}"
    return f"{base}/?view={view}"


def run(only: set[str] | None, views: list[str], shots: Path | None, consent: bool) -> list[dict]:
    from playwright.sync_api import sync_playwright

    base, server = serve()
    findings: list[dict] = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for name, w, h, phone in VIEWPORTS:
                if only and name not in only:
                    continue
                ctx = browser.new_context(viewport={"width": w, "height": h}, has_touch=phone,
                                          is_mobile=phone, device_scale_factor=2 if phone else 1)
                if not consent:
                    # Answer the consent banner up front (declined), as a returning visitor.
                    ctx.add_init_script("try { localStorage.setItem('elitetracker-analytics', 'no:' + Date.now()); } catch (e) {}")
                route_firestore(ctx, predict_fixture())
                page = ctx.new_page()
                errors: list[str] = []
                page.on("console", lambda m, e=errors: m.type == "error" and e.append(m.text[:200]))
                page.on("pageerror", lambda x, e=errors: e.append(f"pageerror: {str(x)[:200]}"))
                team = None
                for view in views:
                    del errors[:]
                    if view == "team" and team is None:
                        page.goto(f"{base}/?view=table", wait_until="load")
                        page.wait_for_function(READY_JS, timeout=20000)
                        team = page.evaluate("() => state.reports[state.league]?.table?.[0]?.team")
                    page.goto(url_for(base, view, team), wait_until="load")
                    try:
                        page.wait_for_function(READY_PREDICT_JS if view.startswith("predict") else READY_JS, timeout=20000)
                    except Exception as exc:  # noqa: BLE001
                        findings.append({"viewport": name, "view": view, "check": "load", "detail": str(exc)[:200]})
                        continue
                    page.wait_for_timeout(700)
                    result = page.evaluate(CHECK_JS, phone)
                    if shots:
                        (shots / name).mkdir(parents=True, exist_ok=True)
                        page.screenshot(path=str(shots / name / f"{view.replace(':', '-')}.png"))
                    for check, detail in (("overflow", result["overflow"]), ("overlap", result["overlaps"]),
                                          ("offscreen", result["offscreen"]), ("tap-target", result["small"]),
                                          ("console", list(errors))):
                        if detail:
                            findings.append({"viewport": name, "view": view, "check": check, "detail": detail})
                ctx.close()
            browser.close()
    finally:
        server.shutdown()
    return findings


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma list of viewport names (e.g. 360x800,375x812)")
    ap.add_argument("--views", help="comma list of views (e.g. grid,table,explore:luck)")
    ap.add_argument("--shots", nargs="?", const="experiments/mobile-audit/shots-check",
                    help="save a first-screen screenshot per view into this folder")
    ap.add_argument("--consent", action="store_true", help="leave the consent banner up (a first visit)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if not (PUBLIC / "data").exists():
        print("public/data is missing: build the site first", file=sys.stderr)
        return 2
    only = set(args.only.split(",")) if args.only else None
    views = args.views.split(",") if args.views else VIEWS
    shots = (ROOT / args.shots) if args.shots else None
    findings = run(only, views, shots, args.consent)
    if args.json:
        print(json.dumps(findings, indent=1, ensure_ascii=False))
    else:
        for f in findings:
            detail = f["detail"] if isinstance(f["detail"], str) else json.dumps(f["detail"], ensure_ascii=False)
            print(f"[{f['viewport']}] {f['view']}: {f['check']}: {detail[:600]}")
        print(f"{len(findings)} finding(s)")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
