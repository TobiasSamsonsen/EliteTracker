"""Shared by frozen_checks.py: the ladder scores from data/history_standings.json (1963-2015) and
the matches (2016+), and the long-run level of every club-season through the season before
(EWMA memory delta, minus the division's mean, x10; 'kind' = prom / rel / new / None)."""
import json, unicodedata
from pathlib import Path
import numpy as np
import harness as H
from elitetracker.model.career import team_ids

HIST = json.loads((Path(__file__).resolve().parents[2] / "data" / "history_standings.json").read_text(encoding="utf-8"))
ALIAS = {"odd grenland": "odd", "odds ballklubb": "odd", "ham-kam": "hamkam", "hamarkameratene": "hamkam", "honefoss bk": "honefoss",
         "l/f honefoss": "honefoss", "kristiansund bk": "kristiansund", "sandefjord bk": "sandefjord", "vif fotball": "valerenga",
         "valerengen": "valerenga", "pors grenland": "pors", "vard haugesund": "vard", "sarpsborg fk": "sarpsborg 08", "sarpsborg": "sarpsborg 08", "gjovik-lyn": "lyn"}

def key2(name):
    low = name.lower().replace("\xf8", "o").replace("\xe5", "a").replace("\xe6", "ae")
    low = unicodedata.normalize("NFKD", low).encode("ascii", "ignore").decode().strip()
    return ALIAS.get(low, low)

def build(d):
    names = {}
    for m, lg, s in H.PLAYED:
        for side, t in enumerate(team_ids(m)): names[t] = m.home if side == 0 else m.away
    id2key = {t: key2(n) for t, n in names.items()}
    score = {}
    for year in range(1963, 2016):
        t1, t2 = HIST["tier1"].get(str(year)), HIST["tier2"].get(str(year))
        if not t1: continue
        n1 = len(t1); rank = {key2(r["team"]): r["pos"] for r in t1}
        if t2:
            G = len({r.get("group", 0) for r in t2}); n2 = len(t2)
            for r in t2: rank[key2(r["team"])] = n1 + (r["pos"] - 1) * G + r.get("group", 0) + 1 if G > 1 else n1 + r["pos"]
            floor, denom = n1 + n2 + 8, n1 + n2 + 16
        else:
            floor, denom = n1 + 16, n1 + 14 + 16
        for k in set(id2key.values()) | set(rank): score[(k, year)] = 1 - rank.get(k, floor) / denom
    fin = {}
    for m, lg, s in H.PLAYED:
        if s < 2016: continue
        for side, t in enumerate(team_ids(m)):
            g = fin.setdefault((s, lg), {}).setdefault(t, [0, 0])
            gf, ga = (m.home_goals, m.away_goals) if side == 0 else (m.away_goals, m.home_goals)
            g[0] += 3 if gf > ga else (1 if gf == ga else 0); g[1] += gf - ga
    for s in range(2016, 2027):
        t1 = sorted(fin.get((s, "eliteserien"), {}).items(), key=lambda kv: (-kv[1][0], -kv[1][1]))
        t2 = sorted(fin.get((s, "obosligaen"), {}).items(), key=lambda kv: (-kv[1][0], -kv[1][1]))
        n1, n2 = len(t1) or 16, len(t2) or 16; rank = {}
        for i, (t, _) in enumerate(t1): rank[id2key[t]] = i + 1
        for i, (t, _) in enumerate(t2): rank[id2key[t]] = n1 + i + 1
        for k in set(id2key.values()): score[(k, s)] = 1 - rank.get(k, n1 + n2 + 8) / (n1 + n2 + 16)
    div = {(d["team"][r], d["season"][r]): d["league"][r] for r in range(len(d["mi"]))}
    return names, id2key, score, div

def level_table(score, id2key, div, delta=0.9, last_season=2026):
    out = {}
    for s in range(2016, last_season + 1):
        ids = [t for (t, ss) in div if ss == s]
        A = {}
        for t in ids:
            k = id2key[t]; num = wsum = 0.0
            for y in range(1963, s):
                w = delta ** (s - 1 - y); num += w * score[(k, y)]; wsum += w
            A[t] = num / wsum
        for lg in ("eliteserien", "obosligaen"):
            idl = [t for t in A if div.get((t, s)) == lg]
            if not idl: continue
            mean = np.mean([A[t] for t in idl])
            for t in idl:
                prev = div.get((t, s - 1))
                kind = ("prom" if (prev == "obosligaen" and lg == "eliteserien") else "rel" if (prev == "eliteserien" and lg == "obosligaen")
                        else "new" if prev is None and s > 2016 else None)
                out[(t, s)] = ((A[t] - mean) * 10, kind)
    return out
