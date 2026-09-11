"""The bookmaker benchmark: name folding, the join, overround normalisation, paired scoring."""

import csv
from pathlib import Path

from elitetracker.model import benchmark
from elitetracker.model.backtest import Scorecard, paired
from elitetracker.normalize.matches import Match


def match(match_id, date, home, away, hg, ag):
    return Match(match_id=match_id, date=date, time="18:00", home=home, away=away,
                 home_goals=hg, away_goals=ag, played=True, home_id=home, away_id=away)


def test_fold_handles_norwegian_letters_and_aliases():
    assert benchmark.fold("Bodø/Glimt") == "bodoglimt"
    assert benchmark.fold("Vålerenga") == "valerenga"
    assert benchmark.fold("Ham-Kam") == benchmark.fold("Hamarkameratene") == "hamkam"
    assert benchmark.same_club("FK Haugesund", "Haugesund")
    assert benchmark.same_club("Odds Ballklubb", "Odd")
    assert benchmark.same_club("KFUM", "KFUM Oslo")
    assert not benchmark.same_club("Start", "Stabaek")


def test_prices_prefer_pinnacle_and_normalise_the_overround():
    row = {"PSCH": "2.0", "PSCD": "4.0", "PSCA": "4.0", "AvgCH": "1.5", "AvgCD": "9", "AvgCA": "9"}
    p = benchmark._prices(row)
    assert abs(sum(p) - 1.0) < 1e-12 and abs(p[0] - 0.5) < 1e-12 and p[1] == p[2]
    assert benchmark._prices({"AvgCH": "1.5", "AvgCD": "9", "AvgCA": "9"})[0] > 0.6
    assert benchmark._prices({"PSCH": ""}) is None


def test_join_uses_folded_names_and_a_one_day_window(tmp_path):
    csv_path = tmp_path / "nor.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["Date", "Home", "Away", "PSCH", "PSCD", "PSCA"])
        writer.writeheader()
        writer.writerow({"Date": "02/05/2026", "Home": "Bodo/Glimt", "Away": "Ham-Kam", "PSCH": "1.5", "PSCD": "4", "PSCA": "6"})
        writer.writerow({"Date": "10/05/2026", "Home": "Odd", "Away": "KFUM Oslo", "PSCH": "2", "PSCD": "3.5", "PSCA": "3.5"})
    matches = [
        match("a", "2026-05-01", "Bodø/Glimt", "Hamarkameratene", 2, 0),  # one day off, still joins
        match("b", "2026-05-10", "Odds Ballklubb", "KFUM", 1, 1),
        match("c", "2026-05-20", "Odds Ballklubb", "KFUM", 1, 1),          # no row within a day
    ]
    joined, unmatched = benchmark.build_odds(matches, csv_path=csv_path, out=tmp_path / "odds.json")
    assert joined == 2 and unmatched == ["c"]
    odds = benchmark.load_odds(tmp_path / "odds.json")
    assert odds["a"][0] > odds["a"][1] > odds["a"][2]
    card = benchmark.benchmark_card(odds, matches)
    assert card.matches == 2 and set(card.losses) == {"a", "b"}


def test_paired_compares_only_shared_matches():
    a, b = Scorecard(name="a"), Scorecard(name="b")
    a.losses = {"1": 1.0, "2": 0.5, "3": 0.9, "x": 5.0}
    b.losses = {"1": 1.2, "2": 0.6, "3": 1.0, "y": 0.1}
    n, mean, t = paired(a, b)
    assert n == 3
    assert abs(mean - (-0.2 - 0.1 - 0.1) / 3) < 1e-12
    assert t < 0
    assert paired(Scorecard(), Scorecard())[0] == 0
