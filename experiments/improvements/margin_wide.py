"""1.1 follow-up: widen the variant-B grid (gamma beyond 0.12, smaller c)."""
import sys
sys.path.insert(0, "experiments/improvements")
from harness import EloRun, HAS_XG, WINDOWS, ad_run, blend, elo_run, line, oos_report  # noqa: E402
from elo_update import implied_exact, score_with  # noqa: E402

base = elo_run()
grid = ad_run().probs
mix = blend(base, grid)
fam = {"base": base}
for g in (0.05, 0.08, 0.12, 0.15, 0.20, 0.25, 0.30, 0.40):
    for c in (0.05, 0.10, 0.15, 0.25):
        e = elo_run(EloRun(score=score_with(implied=implied_exact, margin="B", gamma=g, c=c)))
        fam[(g, c)] = e
        print(line(f"B g={g} c={c} elo [xg]", e, base, WINDOWS["xg"]), "|", line("blend", blend(e, grid), mix, WINDOWS["xg"])[35:70])
oos_report("B wide elo", fam, "base", first=2021, restrict=HAS_XG, windows=("all16", "xg", "es16", "ob16"))
oos_report("B wide blend", {k: blend(v, grid) for k, v in fam.items()}, "base", first=2021, restrict=HAS_XG, windows=("all16", "xg", "es16", "ob16"))
