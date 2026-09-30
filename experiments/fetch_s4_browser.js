// S4 browser fetcher — paste into the DevTools console on https://www.sofascore.com
// (any page). Collects seasons 2022–2026 finished events + xG, cumulative in
// localStorage.s4raw, downloads xg_sofascore_es_raw.json. Keep the tab in the
// foreground while it runs (~30 min at 1.5s/event). Re-run to retry failures.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SEASONS = { 2022: 40405, 2023: 47806, 2024: 57322, 2025: 70174, 2026: 87809 };
  const KEY = "s4raw";
  const out = JSON.parse(localStorage.getItem(KEY) || "{}");
  const save = () => localStorage.setItem(KEY, JSON.stringify(out));
  const row = (e, year, xg) => ({
    y: +year,
    h: e.homeTeam.name,
    a: e.awayTeam.name,
    hg: e.homeScore.current,
    ag: e.awayScore.current,
    xg,
  });
  let n = 0;
  console.log("starting with", Object.keys(out).length, "already collected");

  for (const year of Object.keys(SEASONS)) {
    const sid = SEASONS[year];
    let page = 0;
    const evs = [];
    while (true) {
      const r = await fetch(
        `/api/v1/unique-tournament/20/season/${sid}/events/last/${page}`
      );
      if (!r.ok) {
        console.log("FAIL list", year, "page", page, r.status, "- keep tab open and re-run");
        break;
      }
      const j = await r.json();
      evs.push(
        ...(j.events || []).filter(
          (e) => e.status && e.status.type === "finished"
        )
      );
      if (!j.hasNextPage) break;
      page += 1;
      await sleep(700);
    }
    console.log(year, evs.length, "finished events");

    for (const e of evs) {
      if (out[e.id]) continue;
      const r = await fetch(`/api/v1/event/${e.id}/statistics`);
      if (r.ok) {
        const j = await r.json();
        let xg = null;
        for (const p of j.statistics || []) {
          if (p.period !== "ALL") continue;
          for (const g of p.groups || [])
            for (const it of g.statisticsItems || [])
              if (it.key === "expectedGoals") xg = [it.homeValue, it.awayValue];
        }
        out[e.id] = row(e, year, xg);
        save();
      } else if (r.status === 404) {
        out[e.id] = row(e, year, null); // no statistics resource
        save();
      } else {
        console.log("FAIL event", e.id, r.status, "- will retry on re-run");
      }
      if (++n % 25 === 0)
        console.log(
          "progress:", n, "this run,", Object.keys(out).length, "total"
        );
      await sleep(1500);
    }
  }

  const blob = new Blob([JSON.stringify(out)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "xg_sofascore_es_raw.json";
  a.click();
  console.log("DONE — downloaded", Object.keys(out).length, "events");
})();
