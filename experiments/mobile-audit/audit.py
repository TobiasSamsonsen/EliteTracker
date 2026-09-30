#!/usr/bin/env python3
"""Mobile UI audit for EliteTracker.

Drives the static build with Playwright (device emulation + real touch) and
records load / interaction / overflow / tap-target / layout-shift findings.
Writes <out>-report.json, <out>-report.md and shots-<out>/*.png.

  .venv\\Scripts\\python.exe experiments/mobile-audit/audit.py --out baseline
  .venv\\Scripts\\python.exe experiments/mobile-audit/audit.py --out p0 --only 390x844
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUDIT_DIR = ROOT / "experiments" / "mobile-audit"
VIEWS = ["grid", "table", "ladder", "next-up", "played", "compare", "model"]
BAR_VIEWS = ["grid", "table", "next-up", "played"]
SHEET_VIEWS = ["ladder", "compare", "model"]
MOBILE_CUTOFF = 760  # matches app.js initMobileGestures / .mobilebar media query
VIEWPORTS = [
    # name, width, height, has_touch, is_mobile
    ("320x568", 320, 568, True, True),
    ("375x667", 375, 667, True, True),
    ("390x844", 390, 844, True, True),
    ("412x915", 412, 915, True, True),
    ("844x390-landscape", 844, 390, True, False),
    ("768x1024-tablet", 768, 1024, True, False),
    ("1440x900-desktop", 1440, 900, False, False),
]

DESC_JS = """
(el => {
  const d = el;
  let s = d.tagName.toLowerCase();
  if (d.id) s += '#' + d.id;
  if (d.className && typeof d.className === 'string')
    s += '.' + d.className.trim().split(/\\s+/).slice(0, 2).join('.');
  return s;
})
"""

VIEW_READY_JS = """
view => {
  const secs = [...document.querySelectorAll('[data-section]')];
  const sec = secs.find(s => s.dataset.section.split(' ').includes(view));
  return !!sec && !sec.hidden && sec.innerText.trim().length > 20;
}
"""

STATE_JS = """
view => {
  const active = document.querySelector('[data-view=\"' + view + '\"][aria-pressed=\"true\"]') !== null;
  const secs = [...document.querySelectorAll('[data-section]')];
  const sec = secs.find(s => s.dataset.section.split(' ').includes(view));
  const visible = !!sec && !sec.hidden && sec.innerText.trim().length > 20;
  const p = new URLSearchParams(location.search).get('view');
  const sheet = document.getElementById('more-sheet');
  return {active, visible, url_view: p, sheet_open: sheet ? !sheet.hidden : false,
          expanded: document.getElementById('more-button')?.getAttribute('aria-expanded')};
}
"""

OVERFLOW_JS = """
() => {
  const doc = document.documentElement;
  const out = {scrollW: doc.scrollWidth, clientW: doc.clientWidth, offenders: []};
  if (out.scrollW > out.clientW + 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const excess = Math.max(r.right - innerWidth, -r.left);
      if (excess > 1) {
        let s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id;
        if (el.className && typeof el.className === 'string')
          s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
        out.offenders.push({sel: s, excess: Math.round(excess),
                            left: Math.round(r.left), right: Math.round(r.right)});
      }
    }
    out.offenders.sort((a, b) => b.excess - a.excess);
    out.offenders = out.offenders.slice(0, 8);
  }
  return out;
}
"""

INTERACTIVE_JS = """
() => {
  const sel = 'a[href],button,input,select,textarea,[role=button],[role=tab],[role=switch]';
  // All sized elements (hidden sections report 0x0 and drop out naturally);
  // no viewport filter — off-screen elements must still be reachable by scroll.
  const els = [...document.querySelectorAll(sel)].filter(el => {
    if (el.closest('.visually-hidden') || el.closest('[inert]')) return false;  // sr-only state holders
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const small = [];
  for (const el of els) {
    // WCAG 2.5.8 exemptions: keyboard skip link; links inline in prose.
    if (el.matches('a.skip-link')) continue;
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      if (el.className && typeof el.className === 'string')
        s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
      small.push({sel: s, w: Math.round(r.width), h: Math.round(r.height)});
    }
  }
  small.sort((a, b) => a.w * a.h - b.w * b.h);
  // Reachability: scroll each element to the viewport centre and test whether
  // its centre point is still covered by something else (elementFromPoint).
  // Catches permanently-covered targets (fixed bar, sticky header, collisions)
  // while ignoring transient overlaps that scrolling resolves.
  const covered = [];
  const scrollBefore = window.scrollY;
  for (const el of els) {
    el.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      if (el.className && typeof el.className === 'string')
        s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
      let b = hit.tagName.toLowerCase();
      if (hit.id) b += '#' + hit.id;
      if (hit.className && typeof hit.className === 'string')
        b += '.' + String(hit.className).trim().split(/\\s+/).slice(0, 2).join('.');
      covered.push({sel: s, blocker: b});
    }
  }
  window.scrollTo({top: scrollBefore, behavior: 'instant'});
  return {total: els.length, small_count: small.length, worst: small.slice(0, 8),
          covered: covered.slice(0, 8)};
}
"""

FONTS_JS = """
() => [...document.querySelectorAll('input,select,textarea')]
  .filter(el => {
    if (el.closest('.visually-hidden') || el.closest('[inert]')) return false;  // sr-only state holders
    const r = el.getBoundingClientRect();
    return r.width > 0 && parseFloat(getComputedStyle(el).fontSize) < 16;
  })
  .map(el => ({sel: el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : ''),
               fs: getComputedStyle(el).fontSize}))
"""

CLIPPED_JS = """
() => {
  const res = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.visually-hidden')) continue;  // sr-only by design
    if (el.clientWidth < 4) continue;              // collapsed sr-only boxes
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const clipped = cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis';
    if (!clipped) continue;
    let p = el.parentElement, inScroll = false;
    while (p) {
      const c = getComputedStyle(p);
      if (c.overflowX === 'auto' || c.overflowX === 'scroll') { inScroll = true; break; }
      p = p.parentElement;
    }
    if (inScroll) continue;
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string')
      s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
    res.push({sel: s, text: el.textContent.trim().slice(0, 48),
              sw: el.scrollWidth, cw: el.clientWidth, ellipsis: cs.textOverflow === 'ellipsis'});
  }
  return res.slice(0, 10);
}
"""

FIXED_JS = """
() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= innerHeight) continue;
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string')
      s += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
    let covers = 0;
    if (cs.position === 'fixed') {
      for (const t of document.querySelectorAll('main p, main h2, main td, main li, main button')) {
        const rt = t.getBoundingClientRect();
        if (rt.height > 0 && rt.top < r.bottom && rt.bottom > r.top + 8) covers++;
      }
    }
    out.push({sel: s, pos: cs.position, top: Math.round(r.top),
              h: Math.round(r.height), z: cs.zIndex, pe: cs.pointerEvents, covers_text: covers});
  }
  return out;
}
"""

HEIGHT_SAMPLER_JS = """
async ms => {
  const hs = [];
  const t0 = performance.now();
  await new Promise(res => {
    const tick = () => {
      const sec = document.querySelector('[data-section]:not([hidden])');
      hs.push({t: Math.round(performance.now() - t0),
               dh: document.documentElement.scrollHeight,
               ph: sec ? sec.clientHeight : 0, sy: Math.round(window.scrollY)});
      if (performance.now() - t0 < ms) requestAnimationFrame(tick); else res();
    };
    requestAnimationFrame(tick);
  });
  let maxDoc = 0, maxPanel = 0;
  for (let i = 1; i < hs.length; i++) {
    maxDoc = Math.max(maxDoc, Math.abs(hs[i].dh - hs[i - 1].dh));
    maxPanel = Math.max(maxPanel, Math.abs(hs[i].ph - hs[i - 1].ph));
  }
  return {frames: hs.length, max_doc_delta: maxDoc, max_panel_delta: maxPanel,
          scroll_y: hs.length ? hs[hs.length - 1].sy : null,
          doc_h: hs.length ? hs[hs.length - 1].dh : null};
}
"""

CLS_INIT_JS = """
() => {
  window.__cls = 0; window.__clsEntries = [];
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__cls += e.value;
        const src = (e.sources || []).map(s => {
          const n = s.node;
          if (!n || !n.tagName) return '?';
          let d = n.tagName.toLowerCase();
          if (n.id) d += '#' + n.id;
          if (n.className && typeof n.className === 'string')
            d += '.' + n.className.trim().split(/\\s+/)[0];
          return d;
        });
        window.__clsEntries.push({t: Math.round(e.startTime),
                                   v: Number(e.value.toFixed(4)), src: src.slice(0, 3)});
      }
    }).observe({type: 'layout-shift', buffered: true});
  } catch (err) { window.__clsErr = String(err); }
}
"""

CSS_STATIC = {
    "uses_100vh": "100vh",
    "uses_100dvh": "100dvh",
    "safe_area_env": "env(safe-area-inset",
    "tap_highlight": "-webkit-tap-highlight-color",
    "prefers_reduced_motion": "prefers-reduced-motion",
    "prefers_color_scheme": "prefers-color-scheme",
    "overscroll_behavior": "overscroll-behavior",
    "touch_action": "touch-action",
    "scroll_padding": "scroll-padding",
    "media_760": "@media (max-width: 760px)",
}


def desc(page, handle=None, expr=None) -> str:
    return page.evaluate(expr or DESC_JS, handle)


def css_static_report() -> dict:
    css = (ROOT / "public" / "styles.css").read_text(encoding="utf-8")
    return {k: css.count(v) for k, v in CSS_STATIC.items()}


def viewport_meta(page) -> str | None:
    return page.evaluate(
        "() => document.querySelector('meta[name=viewport]')?.content ?? null"
    )


def snap(page, errs, fails) -> dict:
    """Console/network failures since len marks."""
    e0, f0 = errs["mark"], fails["mark"]
    return {"console_errors": errs["log"][e0:], "failed_requests": fails["log"][f0:]}


def mark(page, errs, fails) -> None:
    errs["mark"] = len(errs["log"])
    fails["mark"] = len(fails["log"])


def attach(page, errs, fails) -> None:
    page.on("console", lambda m: errs["log"].append(m.text[:300])
            if m.type == "error" else None)
    page.on("pageerror", lambda e: errs["log"].append(f"pageerror: {e}"[:300]))
    page.on("response", lambda r: fails["log"].append(f"{r.status} {r.url[-80:]}")
            if r.status >= 400 else None)


def checks(page) -> dict:
    return {
        "overflow": page.evaluate(OVERFLOW_JS),
        "targets": page.evaluate(INTERACTIVE_JS),
        "inputs_font": page.evaluate(FONTS_JS),
        "clipped": page.evaluate(CLIPPED_JS),
        "fixed": page.evaluate(FIXED_JS),
        "cls": round(page.evaluate("() => window.__cls || 0"), 4),
    }


def go_view(page, base_url, view, errs, fails, timeout=20000) -> dict:
    mark(page, errs, fails)
    mark_v = len(errs["log"])
    t0 = time.time()
    row = {"view": view, "loaded": False, "error": None}
    try:
        page.goto(f"{base_url}/?view={view}", wait_until="load", timeout=timeout)
        page.wait_for_function(VIEW_READY_JS, arg=view, timeout=timeout)
        row["loaded"] = True
    except Exception as exc:  # noqa: BLE001 - report, don't crash the sweep
        row["error"] = f"{type(exc).__name__}: {exc}"[:200]
    row["load_ms"] = int((time.time() - t0) * 1000)
    if row["loaded"]:
        page.wait_for_timeout(250)  # let late fetches/settle run
        state = page.evaluate(STATE_JS, view)
        row["active_state"] = state
        row.update(checks(page))
        row["viewport_meta"] = viewport_meta(page)
        row["errors"] = errs["log"][mark_v:]
        mark(page, errs, fails)
        row["failed"] = fails["log"][fails["mark"]:]
    return row


def touch_swipe(cdp, x0, y, x1, steps=10) -> None:
    cdp.send("Input.dispatchTouchEvent",
             {"type": "touchStart", "touchPoints": [{"x": x0, "y": y}]})
    for i in range(1, steps + 1):
        x = x0 + (x1 - x0) * i / steps
        cdp.send("Input.dispatchTouchEvent",
                 {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
        time.sleep(0.015)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def tap(page, sel: str, index: int = 0) -> dict:
    loc = page.locator(sel).nth(index)
    box = loc.bounding_box()
    if not box:
        return {"hit": False, "reason": "no bounding box"}
    x = box["x"] + box["width"] / 2
    y = box["y"] + box["height"] / 2
    under = page.evaluate(
        "([x, y]) => { const el = document.elementFromPoint(x, y);"
        " return el ? (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')"
        " + (el.className && typeof el.className === 'string' ? '.' +"
        " el.className.trim().split(/\\s+/)[0] : '')) : null; }",
        [x, y],
    )
    try:
        page.touchscreen.tap(x, y)
    except Exception:  # desktop contexts have no touchscreen
        loc.click()
    return {"hit": True, "at": [round(x), round(y)], "under_pointer": under}


def audit_more_menu(context, page, errs, fails, out_dir) -> dict:
    """P0-A: open More, tap every sheet item, tap outside; record everything."""
    res = {"available": False, "open": None, "items": [], "outside_tap": None, "diag": {}}
    if not page.locator("#more-button").is_visible():
        res["diag"]["note"] = "more-button not visible (desktop layout)"
        return res
    res["available"] = True
    mark(page, errs, fails)

    res["open"] = tap(page, "#more-button")
    page.wait_for_timeout(350)
    st = page.evaluate(STATE_JS, "grid")
    res["open"]["sheet_open_after_tap"] = st["sheet_open"]
    res["open"]["aria_expanded"] = st["expanded"]

    for view in SHEET_VIEWS:
        item = {"view": view}
        if page.evaluate("() => document.getElementById('more-sheet').hidden"):
            tap(page, "#more-button")
            page.wait_for_timeout(350)
            if page.evaluate("() => document.getElementById('more-sheet').hidden"):
                item["error"] = "sheet closed and did not reopen"
                res["items"].append(item)
                continue
        mark(page, errs, fails)
        item["tap"] = tap(page, f'.sheet__item[data-view="{view}"]')
        page.wait_for_timeout(400)
        item["state"] = page.evaluate(STATE_JS, view)
        item["errors"] = errs["log"][errs["mark"]:]
        item["failed"] = fails["log"][fails["mark"]:]
        # snapshot the visible panel so the report carries proof
        if out_dir:
            page.screenshot(path=str(out_dir / f"more-{view}.png"))
        res["items"].append(item)

    # outside tap (scrim) must close the sheet
    if not page.evaluate("() => !document.getElementById('more-sheet').hidden"):
        tap(page, "#more-button")
        page.wait_for_timeout(300)
    mark(page, errs, fails)
    scrim = page.locator(".sheet__scrim").bounding_box()
    if scrim:
        page.touchscreen.tap(scrim["x"] + scrim["width"] / 2,
                             min(scrim["y"] + 40, scrim["y"] + scrim["height"] - 10))
        page.wait_for_timeout(300)
    res["outside_tap"] = {
        "sheet_closed": page.evaluate("() => document.getElementById('more-sheet').hidden"),
        "errors": errs["log"][errs["mark"]:],
    }
    return res


def audit_swipe(context, page, errs, fails, base_url) -> dict:
    """P0-B: swipe horizontally on the bottom bar; measure CLS, height deltas,
    scroll behaviour and whether the view actually switched."""
    res = {"available": False}
    if not page.locator("#mobilebar").is_visible():
        res["note"] = "mobilebar not visible (desktop layout)"
        return res
    res["available"] = True
    cdp = context.new_cdp_session(page)

    page.goto(f"{base_url}/?view=grid", wait_until="load")
    page.wait_for_function(VIEW_READY_JS, arg="grid", timeout=20000)
    page.wait_for_timeout(300)
    page.evaluate("() => window.scrollTo(0, document.documentElement.scrollHeight)")
    page.wait_for_timeout(200)
    sy0 = page.evaluate("() => Math.round(window.scrollY)")
    box = page.locator(".mobilebar__item[data-view]").first.bounding_box()
    if not box:
        res["error"] = "no mobilebar item box"
        return res
    y = box["y"] + box["height"] / 2
    x0 = box["x"] + box["width"] * 0.8
    x1 = x0 - 160  # left swipe -> next view; threshold is 50px in app.js

    cls0 = page.evaluate("() => window.__cls || 0")
    mark(page, errs, fails)
    touch_swipe(cdp, x0, y, x1)
    page.wait_for_timeout(500)
    res["swipe1"] = {
        "state": page.evaluate(STATE_JS, "table"),
        "sample": page.evaluate(HEIGHT_SAMPLER_JS, 450),
        "cls_delta": round(page.evaluate("() => window.__cls || 0") - cls0, 4),
        "scroll_y_after": page.evaluate("() => Math.round(window.scrollY)"),
        "errors": errs["log"][errs["mark"]:],
    }

    # swipe back to grid, check restoration
    mark(page, errs, fails)
    cls1 = page.evaluate("() => window.__cls || 0")
    touch_swipe(cdp, x1, y, x0)
    page.wait_for_timeout(500)
    sy2 = page.evaluate("() => Math.round(window.scrollY)")
    res["swipe2"] = {
        "state": page.evaluate(STATE_JS, "grid"),
        "sample": page.evaluate(HEIGHT_SAMPLER_JS, 450),
        "cls_delta": round(page.evaluate("() => window.__cls || 0") - cls1, 4),
        "scroll_y_after": sy2,
        "errors": errs["log"][errs["mark"]:],
    }
    res["scroll"] = {"before": sy0, "after_swipe1": res["swipe1"]["scroll_y_after"],
                     "after_swipe2": sy2,
                     "restored": abs(sy2 - sy0) <= 5}
    res["cls_total"] = round(page.evaluate("() => window.__cls || 0"), 4)
    res["cls_entries"] = page.evaluate(
        "() => (window.__clsEntries || []).slice(-10)"
    )
    return res


def audit_content_swipe(context, page, errs, fails, base_url) -> dict:
    """Swipe across the CONTENT area at scroll top — what users actually do.
    Content only wires pull-to-refresh; measure PTR engagement, CLS, height
    deltas and any data reload a horizontal/diagonal swipe causes."""
    res = {"available": True}
    cdp = context.new_cdp_session(page)
    fetches = []
    page.on("response", lambda r: fetches.append(r.url[-60:])
            if "data/report" in r.url else None)
    page.goto(f"{base_url}/?view=grid", wait_until="load")
    page.wait_for_function(VIEW_READY_JS, arg="grid", timeout=20000)
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(300)

    def snap(tag):
        return {
            "tag": tag,
            "ptr": page.evaluate(
                "() => { const p = document.querySelector('.ptr-indicator');"
                " if (!p) return null;"
                " return {cls: p.className,"
                " tf: getComputedStyle(p).transform.slice(0, 40),"
                " op: getComputedStyle(p).opacity}; }"),
            "cls": round(page.evaluate("() => window.__cls || 0"), 4),
            "sample": page.evaluate(HEIGHT_SAMPLER_JS, 350),
            "scroll_y": page.evaluate("() => Math.round(window.scrollY)"),
            "errors": list(errs["log"][errs["mark"]:]),
            "fetches": len(fetches),
        }
        # mark is refreshed by caller

    w = page.viewport_size["width"]
    h = page.viewport_size["height"]

    # 1) pure horizontal swipe over content, at scroll top
    mark(page, errs, fails)
    fetches.clear()
    cls0 = page.evaluate("() => window.__cls || 0")
    touch_swipe(cdp, w * 0.75, h * 0.45, w * 0.35, steps=12)
    page.wait_for_timeout(450)
    res["horizontal"] = snap("horizontal")
    res["horizontal"]["cls_delta"] = round(
        page.evaluate("() => window.__cls || 0") - cls0, 4)

    # 2) diagonal swipe with downward drift (engages pull-to-refresh path)
    mark(page, errs, fails)
    fetches.clear()
    cls1 = page.evaluate("() => window.__cls || 0")
    cdp.send("Input.dispatchTouchEvent",
             {"type": "touchStart", "touchPoints": [{"x": w * 0.7, "y": h * 0.3}]})
    for i in range(1, 13):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [
            {"x": w * 0.7 - (w * 0.35) * i / 12, "y": h * 0.3 + 35 * i / 12}]})
        time.sleep(0.015)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(600)
    res["diagonal"] = snap("diagonal")
    res["diagonal"]["cls_delta"] = round(
        page.evaluate("() => window.__cls || 0") - cls1, 4)
    res["note"] = ("app.js wires swipe-nav only on .mobilebar; content "
                   "gestures route to pull-to-refresh")
    return res


def audit_tab_jump(page, base_url, errs, fails) -> dict:
    """Quantify the scroll/layout jump when switching tabs by tap: scroll to
    bottom, tap the next tab, record scrollY and document height before/after
    plus CLS (the click handler scrolls to top instantly)."""
    res = {}
    page.goto(f"{base_url}/?view=grid", wait_until="load")
    page.wait_for_function(VIEW_READY_JS, arg="grid", timeout=20000)
    page.evaluate("() => window.scrollTo(0, document.documentElement.scrollHeight)")
    page.wait_for_timeout(300)
    before = page.evaluate(
        "() => ({sy: Math.round(window.scrollY),"
        " dh: document.documentElement.scrollHeight})")
    cls0 = page.evaluate("() => window.__cls || 0")
    mark(page, errs, fails)
    tap(page, '.mobilebar__item[data-view="table"]')
    page.wait_for_timeout(500)
    after = page.evaluate(
        "() => ({sy: Math.round(window.scrollY),"
        " dh: document.documentElement.scrollHeight})")
    res["before"] = before
    res["after"] = after
    res["scroll_jump_px"] = before["sy"] - after["sy"]
    res["doc_height_delta"] = after["dh"] - before["dh"]
    res["cls_delta"] = round(page.evaluate("() => window.__cls || 0") - cls0, 4)
    res["errors"] = errs["log"][errs["mark"]:]
    return res


def audit_tab_taps(page, base_url, errs, fails) -> dict:
    """Tap each bar tab; assert state change; catch dead taps. Uses the bottom
    bar when it is visible, otherwise the desktop top strip."""
    res = []
    page.goto(f"{base_url}/?view=grid", wait_until="load")
    page.wait_for_function(VIEW_READY_JS, arg="grid", timeout=20000)
    bar = page.locator("#mobilebar").is_visible()
    sel = ('.mobilebar__item[data-view="{v}"]' if bar
           else '.masthead__views [data-view="{v}"]')
    for view in BAR_VIEWS:
        mark(page, errs, fails)
        if view != "grid":
            tap(page, sel.format(v=view))
            page.wait_for_timeout(400)
        state = page.evaluate(STATE_JS, view)
        res.append({"view": view, "state": state,
                    "ok": state["active"] and state["visible"],
                    "errors": errs["log"][errs["mark"]:]})
    return res


def audit_team(page, base_url, errs, fails, out_dir, shot_prefix) -> dict:
    res = {"opened": False}
    page.goto(f"{base_url}/?view=table", wait_until="load")
    page.wait_for_function(VIEW_READY_JS, arg="table", timeout=20000)
    page.wait_for_timeout(300)
    mark(page, errs, fails)
    first_club = page.locator(".club-btn").first
    first_club.scroll_into_view_if_needed()
    page.wait_for_timeout(200)
    res["tap"] = tap(page, ".club-btn")
    page.wait_for_timeout(600)
    state = page.evaluate(STATE_JS, "team")
    res["state"] = state
    res["opened"] = state["visible"] or bool(page.evaluate(
        "() => new URLSearchParams(location.search).get('team')"))
    res["errors"] = errs["log"][errs["mark"]:]
    if res["opened"]:
        res.update(checks(page))
        if out_dir:
            page.screenshot(path=str(out_dir / f"{shot_prefix}-team.png"), full_page=True)
    return res


def serve(base_url_arg: str | None):
    """Start (or reuse) a static server. Returns (url, proc)."""
    if base_url_arg:
        return base_url_arg.rstrip("/"), None
    url = "http://127.0.0.1:8123"
    try:
        urllib.request.urlopen(url, timeout=1)
        return url, None  # something already serves; reuse
    except Exception:  # noqa: BLE001
        pass
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8123", "--bind", "127.0.0.1",
         "--directory", str(ROOT / "public")],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        try:
            urllib.request.urlopen(url, timeout=1)
            return url, proc
        except Exception:  # noqa: BLE001
            time.sleep(0.25)
    proc.terminate()
    raise RuntimeError("static server did not come up on 127.0.0.1:8123")


def md_report(report: dict) -> str:
    L = ["# Mobile audit — " + report["meta"]["name"], "",
         f"- generated: {report['meta']['timestamp']}",
         f"- base: {report['meta']['base_url']}",
         f"- run seconds: {report['meta']['run_seconds']}", "",
         "## CSS static checks (styles.css occurrences)", "",
         "| check | count |", "|---|---|"]
    for k, v in report["css_static"].items():
        L.append(f"| {k} | {v} |")
    L += ["", "## Per-viewport summary", "",
          "| viewport | views loaded | console errs | doc overflow | small tap targets | "
          "inputs <16px | clipped text | covered targets |", "|---|---|---|---|---|---|---|---|"]
    for vp in report["viewports"]:
        rows = vp["views"]
        loaded = sum(1 for r in rows if r.get("loaded"))
        errs = sum(len(r.get("errors") or []) for r in rows)
        ov = "no"
        small = 0
        fonts = 0
        clipped = 0
        over = 0
        for r in rows:
            if r.get("overflow", {}).get("scrollW", 0) > r["overflow"].get("clientW", 0):
                ov = f"yes +{r['overflow']['scrollW'] - r['overflow']['clientW']}px"
            small += r.get("targets", {}).get("small_count", 0)
            fonts += len(r.get("inputs_font") or [])
            clipped += len(r.get("clipped") or [])
            over += len(r.get("targets", {}).get("covered") or [])
        L.append(f"| {vp['name']} | {loaded}/{len(VIEWS)} | {errs} | {ov} | {small} | "
                 f"{fonts} | {clipped} | {over} |")

    # per-viewport detail for failures
    for vp in report["viewports"]:
        bad = [r for r in vp["views"]
               if not r.get("loaded") or r.get("errors") or
               r.get("overflow", {}).get("offenders")]
        if bad:
            L += ["", f"### {vp['name']} — detail", ""]
            for r in bad:
                if not r.get("loaded"):
                    L.append(f"- **{r['view']} DID NOT LOAD**: {r.get('error')}")
                for e in (r.get("errors") or [])[:4]:
                    L.append(f"- {r['view']} console: {e}")
                for o in (r.get("overflow", {}).get("offenders") or [])[:4]:
                    L.append(f"- {r['view']} overflow: `{o['sel']}` +{o['excess']}px "
                             f"(left {o['left']}, right {o['right']})")

    # P0-A
    L += ["", "## P0-A: More menu", ""]
    for vp in report["viewports"]:
        mm = vp.get("more")
        if not mm or not mm.get("available"):
            continue
        L.append(f"**{vp['name']}** — open: {mm['open']}")
        for it in mm["items"]:
            st = it.get("state") or {}
            ok = st.get("active") and st.get("visible")
            L.append(f"- {it['view']}: switched={'YES' if ok else 'NO'} "
                     f"sheet_closed={not st.get('sheet_open')} url_view={st.get('url_view')} "
                     f"errors={len(it.get('errors') or [])} "
                     f"under_pointer={((it.get('tap') or {}).get('under_pointer'))}")
            for e in (it.get("errors") or [])[:3]:
                L.append(f"  - console: {e}")
        L.append(f"- outside tap closes: {mm.get('outside_tap')}")

    # P0-B
    L += ["", "## P0-B: swipe navigation", ""]
    for vp in report["viewports"]:
        sw = vp.get("swipe")
        if not sw or not sw.get("available"):
            continue
        s1, s2 = sw.get("swipe1", {}), sw.get("swipe2", {})
        L.append(
            f"- **{vp['name']}**: view1={((s1.get('state') or {}).get('url_view'))} "
            f"cls={s1.get('cls_delta')}/{s2.get('cls_delta')} "
            f"maxDocDelta={((s1.get('sample') or {}).get('max_doc_delta'))}px "
            f"maxPanelDelta={((s1.get('sample') or {}).get('max_panel_delta'))}px "
            f"scroll {sw.get('scroll')}")
        for e in (s1.get("errors") or [])[:3]:
            L.append(f"  - console: {e}")
        entries = sw.get("cls_entries") or []
        for ent in entries:
            if ent.get("v", 0) >= 0.01:
                L.append(f"  - layout-shift {ent['v']} at {ent['t']}ms from {ent['src']}")

    # content-area swipe + tab-switch jump (mobile only)
    L += ["", "## Content-area swipe (pull-to-refresh interference)", ""]
    for vp in report["viewports"]:
        cs = vp.get("content_swipe")
        if not cs or not cs.get("available"):
            continue
        for key in ("horizontal", "diagonal"):
            s = cs.get(key) or {}
            L.append(f"- **{vp['name']}** {key}: cls_delta={s.get('cls_delta')} "
                     f"scroll_y={s.get('scroll_y')} fetches={s.get('fetches')} "
                     f"ptr={s.get('ptr')} maxDocDelta="
                     f"{(s.get('sample') or {}).get('max_doc_delta')}px "
                     f"errors={len(s.get('errors') or [])}")
    L += ["", "## Tab-switch scroll jump (tap path)", ""]
    for vp in report["viewports"]:
        tj = vp.get("tab_jump")
        if not tj:
            continue
        L.append(f"- **{vp['name']}**: scroll {tj['before']['sy']} → "
                 f"{tj['after']['sy']} (jump {tj['scroll_jump_px']}px), doc height "
                 f"delta {tj['doc_height_delta']}px, cls +{tj['cls_delta']}, "
                 f"errors={len(tj.get('errors') or [])}")

    # tab taps / team
    L += ["", "## Tab taps and team focus", ""]
    for vp in report["viewports"]:
        tabs = vp.get("tab_taps") or []
        bad_tabs = [t for t in tabs if not t.get("ok")]
        team = vp.get("team") or {}
        L.append(f"- {vp['name']}: tab taps ok={len(tabs) - len(bad_tabs)}/{len(tabs)}"
                 f"{' FAIL:' + str([t['view'] for t in bad_tabs]) if bad_tabs else ''}"
                 f" | team opened={team.get('opened')}")
    L.append("")
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="baseline")
    ap.add_argument("--base-url", default=None)
    ap.add_argument("--only", default=None,
                    help="comma list of viewport names to run")
    args = ap.parse_args()

    only = set(args.only.split(",")) if args.only else None
    vps = [v for v in VIEWPORTS if not only or v[0] in only]

    out_dir = AUDIT_DIR / f"shots-{args.out}"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    base_url, proc = serve(args.base_url)
    errs, fails = {"log": [], "mark": 0}, {"log": [], "mark": 0}
    report = {
        "meta": {"name": args.out, "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
                 "base_url": base_url, "views": VIEWS},
        "css_static": css_static_report(),
        "viewports": [],
    }
    t_start = time.time()
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for name, w, h, touch, mobile in vps:
                print(f"[{name}] ...", flush=True)
                ctx = browser.new_context(
                    viewport={"width": w, "height": h},
                    has_touch=touch, is_mobile=mobile,
                    device_scale_factor=1)
                page = ctx.new_page()
                attach(page, errs, fails)
                page.add_init_script(CLS_INIT_JS)
                vp_report = {"name": name, "w": w, "h": h, "touch": touch,
                             "mobile": mobile, "views": []}
                vp_dir = out_dir / name
                vp_dir.mkdir(exist_ok=True)

                for view in VIEWS:
                    row = go_view(page, base_url, view, errs, fails)
                    if row.get("loaded"):
                        page.screenshot(path=str(vp_dir / f"{view}.png"), full_page=True)
                    vp_report["views"].append(row)
                    print(f"  {view}: {'ok' if row.get('loaded') else 'FAIL ' + str(row.get('error'))}",
                          flush=True)

                vp_report["team"] = audit_team(page, base_url, errs, fails,
                                               vp_dir, name)
                if w <= MOBILE_CUTOFF:
                    page.goto(f"{base_url}/?view=grid", wait_until="load")
                    page.wait_for_function(VIEW_READY_JS, arg="grid", timeout=20000)
                    page.wait_for_timeout(300)
                    vp_report["more"] = audit_more_menu(ctx, page, errs, fails, vp_dir)
                    vp_report["swipe"] = audit_swipe(ctx, page, errs, fails, base_url)
                    vp_report["content_swipe"] = audit_content_swipe(
                        ctx, page, errs, fails, base_url)
                    vp_report["tab_taps"] = audit_tab_taps(page, base_url, errs, fails)
                    vp_report["tab_jump"] = audit_tab_jump(page, base_url, errs, fails)
                    more_items = vp_report["more"].get("items", [])
                    more_ok = sum(1 for i in more_items
                                  if (i.get("state") or {}).get("visible"))
                    print(f"  more: open={vp_report['more'].get('open')} "
                          f"items_ok={more_ok}/{len(more_items)}", flush=True)
                    print(f"  swipe: cls={vp_report['swipe'].get('cls_total')} "
                          f"scroll={vp_report['swipe'].get('scroll')}", flush=True)
                else:
                    vp_report["more"] = {"available": False,
                                         "note": "width > 760: desktop nav"}
                    vp_report["swipe"] = {"available": False,
                                          "note": "width > 760: no mobilebar"}
                    vp_report["tab_taps"] = audit_tab_taps(page, base_url, errs, fails)
                report["viewports"].append(vp_report)
                ctx.close()
            browser.close()
    finally:
        if proc:
            proc.terminate()

    report["meta"]["run_seconds"] = round(time.time() - t_start, 1)
    (AUDIT_DIR / f"{args.out}-report.json").write_text(
        json.dumps(report, indent=1, default=str), encoding="utf-8")
    (AUDIT_DIR / f"{args.out}-report.md").write_text(md_report(report),
                                                      encoding="utf-8")
    print(f"wrote {AUDIT_DIR / f'{args.out}-report.md'} "
          f"({report['meta']['run_seconds']}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
