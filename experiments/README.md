# experiments/ — operations

Protocol lives in `TEST_PLAN.md` (frozen — read before touching anything), trials
in `LOG.md`, kills in `TRIAGE.md`, ideas in `IDEAS.md` / `DEEP_DIVE.md`. This file
is only the runbook: how to refresh data and re-run an experiment. All commands
run from the repo root.

## Seasonal Sofascore xG refresh (S4 pipeline)

Sofascore's WAF blocks non-browser clients (IP + fingerprint reputation), so the
data is collected from your own browser:

1. Open sofascore.com in Chrome (reload first if API calls show 403), F12 -> Console.
2. Paste the whole of `fetch_s4_browser.js`, Enter. Keep the tab in the FOREGROUND —
   hidden tabs throttle the 1.5s pacing to ~1/min and the run stretches to hours.
   State accumulates in `localStorage.s4raw`; fetched events are skipped, so
   re-runs only fill gaps.
3. On `DONE`, `xg_sofascore_es_raw.json` downloads. Chrome appends ` (1)`, ` (2)`
   to duplicates — always import the NEWEST file by timestamp.
4. `python experiments/import_s4_raw.py <path-to-raw> --dry-run` — check the join:
   `no-fixture` should be playoff rows only; every score-mismatch is printed with
   its match id and both scores.
5. Same command without `--dry-run` writes `experiments/data/xg_sofascore_es.json`.
6. `python experiments/s4_experiment.py` — identity gates first, then verdict.

### Handoff gotchas (all hit during 2026-09)

- Download never appeared: paste the retry snippet below. If that fails too,
  `copy(localStorage.s4raw)` in the console and save the clipboard to the file.
- 403s mid-run: the browser session got re-challenged. Reload the page (the
  challenge re-solves on navigation) and re-run — stored events are kept.
- A league fixture stuck in `no-fixture` (not a playoff): the club name differs
  between feeds. Add it to `ALIASES` in `import_s4_raw.py`
  (raw-key -> our-key; precedent: `hamkam` -> `hamarkameratene`).
- Score mismatches are skipped on purpose: Sofascore keeps pre-ruling scores
  (2025-11-22 Valerenga–Kristiansund ended 3-3 on the pitch, was ruled 3-0).

Retry / status snippet:

```js
(() => {
  const s = localStorage.getItem("s4raw");
  const n = s ? Object.keys(JSON.parse(s)).length : 0;
  console.log("entries:", n, "bytes:", s ? s.length : 0);
  if (!n) { console.log("EMPTY - run fetch_s4_browser.js first"); return; }
  const b = new Blob([s], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = "xg_sofascore_es_raw.json";
  a.click();
  console.log("download re-triggered");
})();
```

`fetch_s4.py` is the non-browser variant (resumable, stop-on-403, 3s delay); use
it only when the WAF lets this IP through. Facts that the fetchers rely on:
2020–2021 have no Sofascore xG at all, and `hasXg` in the list payloads lies
(2024 has xG despite flag-false) — never gate the statistics call on it.
