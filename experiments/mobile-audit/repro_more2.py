#!/usr/bin/env python3
"""Repro 2: does the sheet open-animation move the item out from under the
tap? Stages: tap at 350ms vs 1500ms; log mousedown/mouseup/click targets and
elementFromPoint at touchstart vs click time."""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = "http://127.0.0.1:8125/index.html"

HOOK = """
() => {
  window.__log = [];
  const d = el => { if (!el) return null; let s = el.tagName ? el.tagName.toLowerCase() : String(el);
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string' && el.className) s += '.' + el.className.trim().split(/\\s+/)[0];
    return s; };
  const rec = (kind, e) => window.__log.push({kind, target: d(e.target)});
  for (const k of ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup'])
    document.addEventListener(k, e => rec(k, e), true);
  document.addEventListener('touchstart', e => {
    const t = e.touches[0];
    window.__log.push({kind: 'touchstart', target: d(e.target),
                       at: [Math.round(t.clientX), Math.round(t.clientY)],
                       under: d(document.elementFromPoint(t.clientX, t.clientY))});
  }, true);
  document.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    window.__log.push({kind: 'touchend', target: d(e.target),
                       at: [Math.round(t.clientX), Math.round(t.clientY)],
                       under: d(document.elementFromPoint(t.clientX, t.clientY))});
  }, true);
}
"""

STATE = """
view => { const secs=[...document.querySelectorAll('[data-section]')];
  const sec=secs.find(s=>s.dataset.section.split(' ').includes(view));
  return {url:location.search, visible:!!sec&&!sec.hidden&&sec.innerText.trim().length>20,
          sheetHidden:document.getElementById('more-sheet').hidden}; }
"""

def stage(pw, wait_ms, view):
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844},
                        has_touch=True, is_mobile=True)
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL + "?view=grid", wait_until="load")
    page.wait_for_function(
        "() => { const s=document.querySelector('[data-section]:not([hidden])');"
        " return s && s.innerText.trim().length>20; }", timeout=20000)
    page.evaluate(HOOK)
    page.evaluate("() => document.getElementById('more-button').click()")
    page.wait_for_timeout(wait_ms)
    box = page.locator(f'.sheet__item[data-view="{view}"]').bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.touchscreen.tap(x, y)
    page.wait_for_timeout(500)
    state = page.evaluate(STATE, view)
    log = page.evaluate("() => window.__log")
    ok = state["url"].find(view) >= 0 and state["visible"]
    print(f"tap at {wait_ms}ms -> switched={'YES' if ok else 'NO'} "
          f"state={json.dumps(state)}")
    for entry in log:
        if entry["kind"] in ("touchstart", "touchend", "mousedown", "click"):
            print("   ", json.dumps(entry))
    if errs:
        print("    errors:", errs)
    b.close()
    return ok

def main():
    srv = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8125", "--bind", "127.0.0.1",
         "--directory", str(ROOT / "public")],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(40):
            try:
                urllib.request.urlopen(URL, timeout=1); break
            except Exception:
                time.sleep(0.25)
        with sync_playwright() as pw:
            stage(pw, 350, "ladder")
            stage(pw, 1500, "ladder")
            stage(pw, 350, "compare")
            stage(pw, 1500, "compare")
    finally:
        srv.terminate()

if __name__ == "__main__":
    main()
