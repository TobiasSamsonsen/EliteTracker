#!/usr/bin/env python3
"""Causal test for the P0-A hypothesis: the tap fails because removing the
`is-dragging` class re-triggers the `sheet-up` animation (CSS `animation: none`
toggle), teleporting the panel before the compatibility mousedown/click.

Injects a style override that keeps the animation NAME stable (only pauses it)
and re-runs the tap. If taps then switch views, both the cause and the fix are
confirmed."""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = "http://127.0.0.1:8125/index.html"

OVERRIDE = """
() => {
  const s = document.createElement('style');
  s.textContent = '.sheet__panel.is-dragging { animation-name: sheet-up !important;'
                  ' animation-play-state: paused !important; }';
  document.head.appendChild(s);
}
"""

STATE = """
view => { const secs=[...document.querySelectorAll('[data-section]')];
  const sec=secs.find(s=>s.dataset.section.split(' ').includes(view));
  return {url:location.search, visible:!!sec&&!sec.hidden&&sec.innerText.trim().length>20,
          sheetHidden:document.getElementById('more-sheet').hidden}; }
"""

def run(pw, with_override):
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
    if with_override:
        page.evaluate(OVERRIDE)
    page.evaluate("() => document.getElementById('more-button').click()")
    page.wait_for_timeout(350)
    box = page.locator('.sheet__item[data-view="ladder"]').bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.touchscreen.tap(x, y)
    page.wait_for_timeout(500)
    state = page.evaluate(STATE, "ladder")
    ok = "?view=ladder" in state["url"] and state["visible"] and state["sheetHidden"]
    label = "WITH override" if with_override else "baseline (no override)"
    print(f"{label}: switched={'YES' if ok else 'NO'} "
          f"state={json.dumps(state)} errors={errs}")
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
            a = run(pw, False)
            b = run(pw, True)
        print("VERDICT:", "HYPOTHESIS CONFIRMED" if (not a and b)
              else "hypothesis NOT confirmed")
    finally:
        srv.terminate()

if __name__ == "__main__":
    main()
