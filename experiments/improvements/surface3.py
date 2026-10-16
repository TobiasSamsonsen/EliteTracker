"""1.10, one more form: the Eliteserien mismatch edge on the prediction only
(the rating update unchanged), like `spread`."""
import sys
sys.path.insert(0, "experiments/improvements")
from harness import LEAGUE, WINDOWS, EloRun, ad_run, blend, elo_run, line, oos_report  # noqa: E402
from surface2 import MISMATCH, elo_shift  # noqa: E402

base_elo = elo_run(); base_ad = ad_run(); base = blend(base_elo, base_ad.probs)
es = (LEAGUE == "eliteserien").astype(float)
fam = {0: base}
for g in (10, 20, 30, 40, 60):
    e = elo_run(EloRun(home_shift=elo_shift(MISMATCH * es, g), shift_in_update=False))
    fam[g] = blend(e, base_ad.probs)
    print(line(f"ES-only predict-only g={g}", fam[g], base, WINDOWS["es16"]))
    print(line(f"ES-only predict-only g={g} (Elo odds)", e, base_elo, WINDOWS["es16"]))
oos_report("ES-only predict-only", fam, 0, restrict=LEAGUE == "eliteserien", windows=("es16",))
narrow = {k: v for k, v in fam.items() if k in (0, 10, 20)}
oos_report("ES-only predict-only, grid 0-20", narrow, 0, restrict=LEAGUE == "eliteserien", windows=("es16",))
