#!/usr/bin/env python3
"""Focused repro: why do More-sheet item taps close the sheet but not switch
views? Two experiments: (A) synthetic element.click() bypassing touch,
(B) real touchscreen.tap. Prints one compact block."""
import json
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
URL = "http://127.0.0.1:8125/index.html"

STATE_JS = """
view => {
  const secs = [...document.querySelectorAll('[data-section]')];
  const sec = secs.find(s => s.dataset.section.split(' ').includes(view));
  const anyPressed = [...document.querySelectorAll('[data-view=\"' + view + '\"][aria-pressed=\"true\"]')].length;
  return {url: location.search, pressed: anyPressed,
          visible: !!sec && !sec.hidden && sec.innerText.trim().length > 20,
          sheetHidden: document.getElementById('more-sheet').hidden};
}
"""

HOOK_JS = """
() => {
  window.__log = [];
  const d = el => { let s = el.tagName ? el.tagName.toLowerCase() : String(el);
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\\s+/)[0];
    return s; };
  document.addEventListener('click', e => {
    window.__log.push({phase: 'bubble', target: d(e.target),
                       prevented: e.defaultPrevented,
                       state: {url: location.search,
                               ladderPressed: document.querySelectorAll('[data-view=\"ladder\"][aria-pressed=\"true\"]').length,
                               sheetHidden: document.getElementById('more-sheet').hidden}});
  }, false);
  document.addEventListener('touchstart', e => window.__log.push({touch: 'start', target: d(e.target)}), true);
  document.addEventListener('touchend', e => window.__log.push({touch: 'end', target: d(e.target)}), true);
  document.addEventListener('pointerdown', e => window.__log.push({pointer: 'down', target: d(e.target)}), true);
}
"""

def main():
    import subprocess, sys
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
            b = pw.chromium.launch()
            ctx = b.new_context(viewport={"width": 390, "height": 844},
                                has_touch=True, is_mobile=True)
            page = ctx.new_page()
            events = []
            page.on("console", lambda m: events.append(f"console.{m.type}: {m.text[:200]}"))
            page.on("pageerror", lambda e: events.append(f"pageerror: {e}"))
            page.goto(URL + "?view=grid", wait_until="load")
            page.wait_for_function(
                "() => { const s = document.querySelector('[data-section]:not([hidden])');"
                " return s && s.innerText.trim().length > 20; }", timeout=20000)
            page.evaluate(HOOK_JS)

            print("== A: synthetic .click() on sheet item (no touch) ==")
            page.evaluate("() => document.getElementById('more-button').click()")
            page.wait_for_timeout(200)
            print(" after open:", json.dumps(page.evaluate(STATE_JS, "ladder")))
            page.evaluate("() => document.querySelector('.sheet__item[data-view=\"ladder\"]').click()")
            page.wait_for_timeout(400)
            print(" after synthetic click:", json.dumps(page.evaluate(STATE_JS, "ladder")))
            print(" log:", json.dumps(page.evaluate("() => window.__log")))

            print("== B: real touchscreen.tap on sheet item ==")
            page.evaluate("() => { window.__log = []; }")
            page.evaluate("() => document.getElementById('more-button').click()")
            page.wait_for_timeout(350)
            box = page.locator('.sheet__item[data-view="ladder"]').bounding_box()
            x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            under = page.evaluate("([x,y]) => { const el = document.elementFromPoint(x,y);"
                                  " return el ? el.tagName + '#' + el.id + '.' + el.className : null; }", [x, y])
            print(f" box=({x:.0f},{y:.0f}) under={under}")
            page.touchscreen.tap(x, y)
            page.wait_for_timeout(500)
            print(" after tap:", json.dumps(page.evaluate(STATE_JS, "ladder")))
            print(" log:", json.dumps(page.evaluate("() => window.__log")))
            print(" events:", json.dumps(events))

            print("== C: tap on scrim (outside) ==")
            page.evaluate("() => document.getElementById('more-button').click()")
            page.wait_for_timeout(300)
            sc = page.locator(".sheet__scrim").bounding_box()
            page.touchscreen.tap(sc["x"] + sc["width"] / 2, sc["y"] + 60)
            page.wait_for_timeout(300)
            print(" sheet hidden after scrim tap:",
                  page.evaluate("() => document.getElementById('more-sheet').hidden"))
            b.close()
    finally:
        srv.terminate()

if __name__ == "__main__":
    main()
