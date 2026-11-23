"""Parse the saved Wikipedia season pages (data/raw/wikipedia_standings/) into
data/history_standings.json: {"tier1": {year: [row]}, "tier2": {year: [row]}}, a row being
position, team (cleaned name), played, wins, draws, losses, goals for/against and points3
(3 W + D, whatever the printed column says: two points a win before 1987, deductions).
Standard library only. Prints every season whose table is not a plain league table.

    .venv/Scripts/python -X utf8 experiments/improvements/parse_wikipedia_standings.py
"""
import json, re
from html.parser import HTMLParser
from pathlib import Path

RAW = Path(__file__).resolve().parents[2] / "data" / "raw" / "wikipedia_standings"
OUT = Path(__file__).resolve().parents[2] / "data" / "history_standings.json"
MINUS, ENDASH = chr(0x2212), chr(0x2013)

class T(HTMLParser):
    def __init__(s):
        super().__init__(); s.tables = []; s.stack = []; s.row = None; s.cell = None; s.skip = 0
    def handle_starttag(s, tag, a):
        if tag == "table": s.tables.append([]); s.stack.append(s.tables[-1])
        elif tag == "tr" and s.stack: s.row = []; s.stack[-1].append(s.row)
        elif tag in ("td", "th") and s.row is not None: s.cell = []
        elif tag == "sup" and s.cell is not None: s.skip += 1
    def handle_endtag(s, tag):
        if tag in ("td", "th") and s.cell is not None: s.row.append("".join(s.cell).strip()); s.cell = None
        elif tag == "table" and s.stack: s.stack.pop(); s.row = None
        elif tag == "sup" and s.skip: s.skip -= 1
    def handle_data(s, d):
        if s.cell is not None and not s.skip: s.cell.append(d)

def num(x):
    x = re.sub(r"\[.*?\]", "", x).replace(MINUS, "-").replace(ENDASH, "-").strip()
    m = re.match(r"^[+-]?\d+", x)
    return int(m.group()) if m else None

def clean(name):
    name = re.sub(r"\[.*?\]", "", name)
    name = re.sub(r"\s*\([A-Z](?:,\s*[A-Z])*\)\s*", " ", name)
    return re.sub(r"\s+", " ", name).strip()

def parse(path):
    p = T(); p.feed(path.read_text(encoding="utf-8"))
    found = []
    for t in p.tables:
        head = None
        for r in t[:3]:
            low = [c.lower() for c in r]
            if "team" in low and any(c in low for c in ("pld", "p", "pl", "gp")):
                head = low; break
        if not head: continue
        tcol = head.index("team")
        pl = next(head.index(c) for c in ("pld", "p", "pl", "gp") if c in head)
        try: w, l = head.index("w"), head.index("l")
        except ValueError: continue
        # 1987 gave a shootout winner two points and its loser one in a drawn match: those are draws
        d_ = head.index("d") if "d" in head else None
        pkw, pkl = (head.index("pkw"), head.index("pkl")) if "pkw" in head and "pkl" in head else (None, None)
        if d_ is None and pkw is None: continue
        gf = head.index("gf") if "gf" in head else None; ga = head.index("ga") if "ga" in head else None
        rows = []
        for r in t:
            if len(r) <= max(x for x in (w, d_, l, pl, tcol, pkw, pkl) if x is not None): continue
            tm = clean(r[tcol]); nw, nl, npl = num(r[w]), num(r[l]), num(r[pl])
            nd = num(r[d_]) if d_ is not None else (num(r[pkw]) or 0) + (num(r[pkl]) or 0) if num(r[pkw]) is not None and num(r[pkl]) is not None else None
            if None in (nw, nd, nl, npl) or not tm or npl == 0: continue   # npl 0: a club expelled mid-season (Lyn, 2010)
            rows.append({"pos": len(rows) + 1, "team": tm, "played": npl, "wins": nw, "draws": nd, "losses": nl,
                         "gf": num(r[gf]) if gf is not None and len(r) > gf else None,
                         "ga": num(r[ga]) if ga is not None and len(r) > ga else None, "points3": 3 * nw + nd})
        if len(rows) >= 6: found.append(rows)
    return found

def main():
    out = {"tier1": {}, "tier2": {}}
    for path in sorted(RAW.glob("tier*_*.html")):
        tier, year = path.stem.split("_"); tier = tier.replace("tier", ""); year = int(year)
        tabs = parse(path)
        if not tabs:
            print(f"NO TABLE {path.stem}"); continue
        first = tabs[0]
        if tier == "2" and len(tabs) == 2 and len(tabs[0]) == len(tabs[1]) == 12:   # 1991-1996: two groups of 12, each ranked on its own
            first = [dict(r, group=g) for g, t in enumerate(tabs) for r in t]
            print(f"note {path.stem}: two groups of 12 kept as groups 0 and 1")
        elif len(tabs) > 1 or len({r["played"] for r in first}) > 1:
            print(f"CHECK {path.stem}: {len(tabs)} tables: " + ", ".join(f"{len(t)} clubs / played {sorted({r['played'] for r in t})}" for t in tabs))
        out["tier" + tier][str(year)] = first
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    print({k: len(v) for k, v in out.items()}, "->", OUT)

if __name__ == "__main__":
    main()
