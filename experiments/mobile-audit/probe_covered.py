#!/usr/bin/env python3
"""One-off: why does the reachability check report covered targets?
Prints, for a few covered elements: rect, scroll state, and the hit chain."""
import subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
VIEWS = sys.argv[1:] or ["played"]
URL = "http://127.0.0.1:8126/index.html?view="

PROBE = """
() => {
  const sel = 'a[href],button,input,select,textarea,[role=button],[role=tab],[role=switch]';
  const els = [...document.querySelectorAll(sel)].filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const out = [];
  for (const el of els) {
    el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      const chain = [];
      let h = hit;
      while (h && chain.length < 5) {
        let s = h.tagName.toLowerCase();
        if (h.id) s += '#' + h.id;
        if (h.className && typeof h.className === 'string')
          s += '.' + h.className.trim().split(/\\s+/).slice(0, 2).join('.');
        chain.push(s);
        h = h.parentElement;
      }
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      if (el.className && typeof el.className === 'string')
        s += '.' + el.className.trim().split(/\\s+/)[0];
      const cs = getComputedStyle(el);
      out.push({el: s, pos: cs.position, vis: cs.visibility, pe: cs.pointerEvents,
                rect: [r.left | 0, r.top | 0, r.width | 0, r.height | 0],
                html: el.outerHTML.slice(0, 160),
                parent: (el.parentElement ? el.parentElement.tagName.toLowerCase() +
                  (el.parentElement.className && typeof el.parentElement.className === 'string'
                    ? '.' + el.parentElement.className.trim().split(/\\s+/)[0] : '') : ''),
                hitChain: chain, scrollY: Math.round(scrollY),
                maxScroll: Math.round(document.documentElement.scrollHeight - innerHeight),
                inner: [innerWidth, innerHeight]});
    }
  }
  window.scrollTo(0, 0);
  return out.slice(0, 6);
}
"""

def main():
    srv = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8126", "--bind", "127.0.0.1",
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
            page = b.new_context(viewport={"width": 390, "height": 844},
                                 has_touch=True, is_mobile=True).new_page()
            for view in VIEWS:
                page.goto(URL + view, wait_until="load")
                page.wait_for_function(
                    "() => { const s=document.querySelector('[data-section]:not([hidden])');"
                    " return s && s.innerText.trim().length>20; }", timeout=20000)
                page.wait_for_timeout(500)
                print(f"--- {view} ---")
                for row in page.evaluate(PROBE):
                    print(row)
            b.close()
    finally:
        srv.terminate()

if __name__ == "__main__":
    main()
