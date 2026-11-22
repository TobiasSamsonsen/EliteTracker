"""Play-off matches in the Elo replay (elo-v18.0), backtested (November 2026).

The play-off matches after every season 2015-2025 (`research playoffs`,
fotmob league 60, into data/normalized/playoff_fixtures.json) rated like
league matches in the Elo replay, against the replay without them. The goals
model leaves them out in both. Scored walk-forward on every league match
2016+, both divisions; the effect can only reach a season through its
starting ratings (and, within a season, nothing: the play-off comes last).

    python experiments/improvements/playoff_elo.py
"""

from elitetracker.model.backtest import paired, restrict, shipped_cards
from elitetracker.pipeline import load_slices, market_values, playoff_played, seed_ratings, shot_table, stakes_table

slices = load_slices()
seeds = {team_id: seed.rating for team_id, seed in seed_ratings().items()}
kw = dict(score_from_season=2016, shots=shot_table(), values=market_values(), stakes=stakes_table())
dates = {m.match_id: m.date for s in slices for m in s.matches}
league = {m.match_id: s.league for s in slices for m in s.matches}
played = playoff_played()
print(f"play-off matches: {sum(len(v) for v in played.values())} over {len(played)} seasons")
elo0, ship0 = shipped_cards(slices, seeds, **kw)
elo1, ship1 = shipped_cards(slices, seeds, playoffs=played, **kw)


def report(name, a, b):
    ids = set(a.losses)
    early = {m for m in ids if dates[m][:4] <= "2020"}
    for label, keep in (("all 2016+", ids), ("2016-2020", early), ("2021+", ids - early),
                        ("Eliteserien", {m for m in ids if league[m] == "eliteserien"}),
                        ("OBOS-ligaen", {m for m in ids if league[m] == "obosligaen"})):
        cells = []
        for metric in ("log_loss", "brier", "rps"):
            n, d, t = paired(restrict(a, keep), restrict(b, keep), metric)
            cells.append(f"{metric} {d:+.5f} (t {t:+.2f})")
        print(f"  {name:8} {label:12} n={n:5d}  " + "  ".join(cells))


print("with play-offs minus without (negative = the play-offs help):")
report("shipped", ship1, ship0)
report("elo", elo1, elo0)
