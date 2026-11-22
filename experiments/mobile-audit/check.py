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
import sys
import threading
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
VIEWS = (["overview", "grid", "table", "matches", "ladder", "compare", "explore"]
         + [f"explore:{item}" for item in EXPLORE] + ["model", "team"])

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
    const dense = 'table, svg, .grid, .ladder__track, .mountain, .scenario__table, .whatif-impact, .team-grid, .calibration, .luck, .runin';
    const seen = new Set();
    for (const el of document.querySelectorAll('main button, main a[href], main [role="tab"], main input, main select, header button, header a[href], #mobilebar button')) {
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


def url_for(base: str, view: str, team: str | None) -> str:
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
                        page.wait_for_function(READY_JS, timeout=20000)
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
