"""Attack/defence ratings: the grid, the conditioning on Elo odds, the update, the season pull."""

import math

from elitetracker.model.attack_defence import (
    ADConfig, AttackDefence, blend_outcomes, conditional_scorelines, outcome_probabilities, score_grid, top_scorelines,
)
from elitetracker.model.career import SeasonSlice
from elitetracker.model.probabilities import MatchProbabilities
from elitetracker.normalize.matches import Match


def match(mid, date, home, away, hg, ag, played=True):
    return Match(match_id=mid, date=date, time="18:00", home=home, away=away,
                 home_goals=hg if played else None, away_goals=ag if played else None, played=played,
                 home_id=home, away_id=away)


def slices(*seasons):
    return [SeasonSlice(league=league, league_name=league, season=season, matches=matches)
            for season, league, matches in seasons]


def test_grid_sums_to_one_and_rho_lifts_low_draws():
    grid = score_grid(1.6, 1.1, rho=0.0)
    assert abs(sum(map(sum, grid)) - 1.0) < 1e-12
    assert abs(grid[2][1] - math.exp(-1.6) * 1.6 ** 2 / 2 * math.exp(-1.1) * 1.1 / sum(map(sum, [[math.exp(-1.6) * 1.6 ** i / math.factorial(i) * math.exp(-1.1) * 1.1 ** j / math.factorial(j) for j in range(9)] for i in range(9)]))) < 1e-12
    lifted = score_grid(1.6, 1.1, rho=-0.1)
    assert lifted[0][0] > grid[0][0] and lifted[1][1] > grid[1][1] and lifted[1][0] < grid[1][0]
    p = outcome_probabilities(grid)
    assert abs(p.home_win + p.draw + p.away_win - 1.0) < 1e-12 and p.home_win > p.away_win


def test_conditioning_keeps_the_elo_odds_and_only_reshapes_within_outcomes():
    grid = score_grid(1.6, 1.1, rho=-0.05)
    odds = MatchProbabilities(0.5, 0.3, 0.2)
    cells = conditional_scorelines(grid, odds)
    assert abs(sum(v for (i, j), v in cells.items() if i > j) - 0.5) < 1e-12
    assert abs(sum(v for (i, j), v in cells.items() if i == j) - 0.3) < 1e-12
    assert abs(sum(cells.values()) - 1.0) < 1e-12
    # Within an outcome the relative shape is the grid's own.
    assert abs(cells[(2, 1)] / cells[(1, 0)] - grid[2][1] / grid[1][0]) < 1e-12
    top = top_scorelines(grid, odds, 3)
    assert len(top) == 3 and top[0][1] >= top[1][1] >= top[2][1]


def test_update_moves_attack_and_defence_together_and_caps_a_rout():
    model = AttackDefence(config=ADConfig(k=0.1, cap=2.0, early_boost=0.0), divisions={(2020, "A"): "l", (2020, "B"): "l"})
    lam, mu = model.rates("A", "B", "2020-03-01")
    model.observe(match("1", "2020-03-01", "A", "B", 9, 0))
    assert abs(model.attack["A"] - 0.1 * 2.0) < 1e-12      # capped at 2 goals of surprise
    assert abs(model.defence["B"] + 0.1 * 2.0) < 1e-12     # the conceder's defence drops as much
    assert model.attack["B"] < 0 and model.defence["A"] > 0 # B scored under expectation
    assert model.rates("A", "B", "2020-03-01")[0] > lam


def test_xg_blend_reduces_a_lucky_win():
    shots = {"1": (0.4, 2.1, 0.5, 2.6)}  # home won 1-0 but was outshot
    goals_only = AttackDefence(config=ADConfig(k=0.1), divisions={(2020, "A"): "l", (2020, "B"): "l"})
    # Same step for both, so only the observation differs (k_shots is 0.05 by default).
    blended = AttackDefence(config=ADConfig(k=0.1, k_shots=0.1, alpha=0.5), divisions={(2020, "A"): "l", (2020, "B"): "l"}, shots=shots)
    for model in (goals_only, blended):
        model.observe(match("1", "2020-03-01", "A", "B", 1, 0))
    assert blended.attack["A"] < goals_only.attack["A"]
    assert blended.defence["A"] < goals_only.defence["A"]
    xgot = AttackDefence(config=ADConfig(k=0.1, k_shots=0.1, alpha=1.0, signal="xgot"), divisions={(2020, "A"): "l", (2020, "B"): "l"}, shots=shots)
    xgot.observe(match("1", "2020-03-01", "A", "B", 1, 0))
    assert xgot.observed(match("1", "2020-03-01", "A", "B", 1, 0)) == (0.5, 2.6, 0.1)


def test_season_start_pulls_toward_the_division_and_places_newcomers():
    data = slices(
        (2020, "eliteserien", [match("1", "2020-05-01", "A", "B", 3, 0), match("2", "2020-05-08", "B", "A", 0, 3)]),
        (2021, "eliteserien", [match("3", "2021-04-01", "A", "C", 1, 1), match("5", "2021-04-08", "B", "C", 1, 1)]),
        (2021, "obosligaen", [match("4", "2021-04-01", "D", "E", 1, 1)]),
    )
    model = AttackDefence.from_slices(data, ADConfig(k=0.1, season_regression=0.5, newcomer=0.2, division_gap=0.3))
    model.replay(data[0].matches)
    before = dict(model.attack)
    model.start_season(2021)
    mean = (before["A"] + before["B"]) / 2
    assert abs(model.attack["A"] - (mean + 0.5 * (before["A"] - mean))) < 1e-12
    assert abs(model.attack["C"] - (model.attack["A"] + model.attack["B"]) / 2 + 0.2) < 1e-12  # newcomer sits below its peers
    assert model.attack["D"] == model.defence["D"] == -0.3                                     # a first-season division is placed, not learned
    model.start_season(2021)  # idempotent
    assert abs(model.attack["C"] - (model.attack["A"] + model.attack["B"]) / 2 + 0.2) < 1e-12


def test_the_offseason_pull_aims_at_squad_value_from_the_season_before():
    data = slices(
        (2020, "eliteserien", [match("1", "2020-05-01", "A", "B", 1, 1), match("2", "2020-05-08", "B", "C", 1, 1)]),
        (2021, "eliteserien", [match("3", "2021-04-01", "A", "B", 1, 1), match("4", "2021-04-08", "B", "C", 1, 1)]),
    )
    # A's squad is worth 4x C's in 2020; B's value is missing (no shift).
    values = {2020: {"A": 8e6, "C": 2e6}, 2021: {"A": 1e6, "C": 9e6}}
    cfg = ADConfig(k=0.1, season_regression=0.5, value_pull=0.2, early_boost=0.0)
    plain = AttackDefence.from_slices(data, ADConfig(k=0.1, season_regression=0.5, value_pull=0.0, early_boost=0.0))
    priced = AttackDefence.from_slices(data, cfg, values=values)
    for model in (plain, priced):
        model.replay(data[0].matches)
        model.start_season(2021)
    v = 0.5 * math.log(4.0)   # A's log value above the (A, C) geometric mean
    for ratings in ("attack", "defence"):
        a, p = getattr(plain, ratings), getattr(priced, ratings)
        assert abs(p["A"] - a["A"] - 0.5 * 0.2 * v) < 1e-12   # (1 - regression) * value_pull * v
        assert abs(p["C"] - a["C"] + 0.5 * 0.2 * v) < 1e-12
        assert p["B"] == a["B"]
    # The 2021 page (same season) is never read for 2021, and the first season is never shifted.
    assert priced.attack["A"] - plain.attack["A"] > 0


def test_a_clubs_first_matches_of_a_season_take_a_bigger_step():
    divisions = {(2020, "A"): "l", (2020, "B"): "l", (2021, "A"): "l", (2021, "B"): "l"}
    flat = AttackDefence(config=ADConfig(k=0.1, early_boost=0.0, season_regression=1.0), divisions=divisions)
    early = AttackDefence(config=ADConfig(k=0.1, early_boost=0.5, early_tau=3.0, season_regression=1.0), divisions=divisions)
    first = match("0", "2020-04-10", "A", "B", 2, 0)
    flat.observe(first)
    early.observe(first)
    assert abs(early.attack["A"] - 1.5 * flat.attack["A"]) < 1e-12   # same surprise, 1 + 0.5 * exp(0)
    multipliers = [early._early("A")]
    for i in range(1, 6):
        early.observe(match(str(i), f"2020-04-{i + 10:02d}", "A", "B", 2, 0))
        multipliers.append(early._early("A"))
    assert abs(multipliers[0] - (1 + 0.5 * math.exp(-1 / 3))) < 1e-12
    assert multipliers == sorted(multipliers, reverse=True) and multipliers[-1] > 1.0  # it fades
    early.observe(match("9", "2021-04-01", "A", "B", 2, 0))  # a new season starts the count again
    assert early._played == {"A": 1, "B": 1}
    assert early.copy()._played == early._played


def test_copy_is_independent_and_rates_against_average_are_readable():
    data = slices((2020, "eliteserien", [match("1", "2020-05-01", "A", "B", 2, 0)]))
    model = AttackDefence.from_slices(data, ADConfig(k=0.1)).replay(data[0].matches)
    twin = model.copy()
    twin.observe(match("2", "2020-05-08", "A", "B", 4, 0))
    assert twin.attack["A"] > model.attack["A"]
    scored, conceded = model.rates_against_average("A", "eliteserien", 2020)
    assert scored > conceded > 0


def test_blend_outcomes_interpolates_between_elo_and_the_grid():
    grid = score_grid(2.0, 0.8, rho=-0.05)
    elo = MatchProbabilities(0.4, 0.3, 0.3)
    own = outcome_probabilities(grid)
    for weight, expected in ((1.0, elo), (0.0, own)):
        got = blend_outcomes(elo, grid, weight)
        assert abs(got.home_win - expected.home_win) < 1e-12 and abs(got.draw - expected.draw) < 1e-12
    mid = blend_outcomes(elo, grid, 0.5)
    assert abs(mid.home_win + mid.draw + mid.away_win - 1.0) < 1e-12
    assert min(elo.home_win, own.home_win) < mid.home_win < max(elo.home_win, own.home_win)


def test_update_xg_records_new_matches_and_survives_a_failed_fetch(tmp_path):
    from elitetracker.sources.fotmob import FetchError, load_xg, update_xg
    path = tmp_path / "xg.json"
    calls = []

    def fetch(match_id):
        calls.append(match_id)
        if match_id == "bad":
            raise FetchError("boom")
        return None if match_id == "obos" else (1.5, 0.5, 1.2, 0.4)

    games = [match("a", "2026-05-01", "A", "B", 2, 0), match("bad", "2026-05-02", "A", "B", 2, 0),
             match("obos", "2026-05-03", "A", "B", 2, 0), match("later", "2026-05-09", "A", "B", 0, 0, played=False)]
    assert update_xg(games, path=path, fetch=fetch, delay=0) == 2
    data = load_xg(path)
    assert data["matches"]["a"] == [1.5, 0.5, 1.2, 0.4] and data["none"] == ["obos"] and "later" not in calls
    assert update_xg(games, path=path, fetch=fetch, delay=0) == 0   # only the failed one is retried
    assert calls.count("bad") == 2 and calls.count("a") == 1


def test_update_xg_asks_again_3_and_24_hours_after_the_whistle(tmp_path):
    """One request when a match is first seen, one 3 hours after the final
    whistle and one 24 hours after it, then none (the hourly job used to ask
    every run for two days)."""
    from datetime import datetime, timedelta, timezone

    from elitetracker.sources.fotmob import MATCH_HOURS, load_xg, update_xg
    path = tmp_path / "xg.json"
    calls = []

    def fetch(match_id):
        calls.append(match_id)
        return (1.0, 0.5, 0.8, 0.3)

    kickoff = datetime(2026, 10, 17, 18, 0, tzinfo=timezone.utc)  # "18:00", read as UTC
    games = [match("fresh", "2026-10-17", "A", "B", 2, 0), match("old", "2026-10-01", "A", "B", 3, 1)]
    at = lambda hours: kickoff + timedelta(hours=MATCH_HOURS + hours)  # hours after the whistle
    assert update_xg(games, path=path, fetch=fetch, delay=0, now=at(0)) == 2
    assert set(load_xg(path)["pending"]) == {"fresh"}
    assert update_xg(games, path=path, fetch=fetch, delay=0, now=at(2.9)) == 0
    assert update_xg(games, path=path, fetch=fetch, delay=0, now=at(3)) == 1
    assert set(load_xg(path)["pending"]) == {"fresh"}
    for hours in (4, 12, 23.9):
        assert update_xg(games, path=path, fetch=fetch, delay=0, now=at(hours)) == 0
    assert update_xg(games, path=path, fetch=fetch, delay=0, now=at(24)) == 1
    assert load_xg(path)["pending"] == {}
    assert update_xg(games, path=path, fetch=fetch, delay=0, now=at(48)) == 0
    assert calls == ["fresh", "old", "fresh", "fresh"]


def test_update_xg_asks_once_for_missed_refetches(tmp_path):
    """A match fetched at the whistle whose re-fetch times have all passed
    (the 48-hour rule's pending entries, or a stalled job) costs one request."""
    from datetime import datetime, timedelta, timezone

    from elitetracker.sources.fotmob import load_xg, save_xg, update_xg
    path = tmp_path / "xg.json"
    save_xg({"matches": {"bodo": [2.216, 1.36]}, "none": [], "pending": {"bodo": "2026-10-24T20:00:08Z"}}, path)
    calls = []

    def fetch(match_id):
        calls.append(match_id)
        return (2.8, 1.35, 1.9, 1.0)

    kickoff = datetime(2026, 10, 24, 18, 0, tzinfo=timezone.utc)
    games = [match("bodo", "2026-10-24", "A", "B", 0, 1)]
    assert update_xg(games, path=path, fetch=fetch, delay=0, now=kickoff + timedelta(hours=29)) == 1
    assert load_xg(path)["matches"]["bodo"] == [2.8, 1.35, 1.9, 1.0] and load_xg(path)["pending"] == {}
    assert update_xg(games, path=path, fetch=fetch, delay=0, now=kickoff + timedelta(hours=30)) == 0
    assert calls == ["bodo"]


def test_update_xg_marks_a_recent_match_fetched_before_the_rule(tmp_path):
    from datetime import datetime, timedelta, timezone

    from elitetracker.sources.fotmob import load_xg, save_xg, update_xg
    path = tmp_path / "xg.json"
    save_xg({"matches": {"fresh": [1.0, 0.5]}, "none": []}, path)
    calls = []

    def fetch(match_id):
        calls.append(match_id)
        return (1.2, 0.4, 0.9, 0.3)

    kickoff = datetime(2026, 10, 17, 18, 0, tzinfo=timezone.utc)
    games = [match("fresh", "2026-10-17", "A", "B", 2, 0)]
    assert update_xg(games, path=path, fetch=fetch, delay=0, now=kickoff + timedelta(hours=4)) == 0
    assert "fresh" in load_xg(path)["pending"] and calls == []
    assert update_xg(games, path=path, fetch=fetch, delay=0, now=kickoff + timedelta(hours=5)) == 1
    assert load_xg(path)["matches"]["fresh"] == [1.2, 0.4, 0.9, 0.3]


def test_rates_against_average_runs_the_offseason_pull_first():
    """Before a season's first match the readable rates must already carry the
    offseason pull, as rates() would (the pipeline used to have to call
    start_season itself)."""
    divisions = {(2020, "A"): "l", (2020, "B"): "l", (2021, "A"): "l", (2021, "B"): "l"}
    model = AttackDefence(config=ADConfig(), divisions=divisions)
    model.observe(match("1", "2020-05-01", "A", "B", 3, 0))
    pulled = model.copy()
    pulled.start_season(2021)
    assert model.rates_against_average("A", "l", 2021) == pulled.rates_against_average("A", "l", 2021)


def test_spread_stretches_predictions_but_not_what_the_ratings_learn():
    divisions = {(2020, "A"): "l", (2020, "B"): "l"}
    plain = AttackDefence(config=ADConfig(k=0.1, spread=1.0), divisions=divisions)
    wide = AttackDefence(config=ADConfig(k=0.1, spread=1.5), divisions=divisions)
    for model in (plain, wide):
        model.observe(match("1", "2020-03-01", "A", "B", 3, 0))
    assert wide.attack == plain.attack and wide.defence == plain.defence
    cfg = plain.config
    lam_plain, mu_plain = plain.rates("A", "B", "2020-03-02")
    lam_wide, mu_wide = wide.rates("A", "B", "2020-03-02")
    # log rate minus its constant part scales by exactly the spread
    assert math.isclose(math.log(lam_wide) - cfg.base - cfg.home, 1.5 * (math.log(lam_plain) - cfg.base - cfg.home))
    assert math.isclose(math.log(mu_wide) - cfg.base, 1.5 * (math.log(mu_plain) - cfg.base))
    assert wide.predict("A", "B", "2020-03-02").home_win > plain.predict("A", "B", "2020-03-02").home_win


def test_keeping_lowers_the_other_sides_rate_once_its_window_is_half_full():
    """The keeper (elo-v14.0): log(xG on target faced / goals let in) over a
    club's last `keeping_window` matches, against its division's, times the
    weight; it comes off the other side's expected goals. Ratings held still
    (k 0) so the rates show keeping alone."""
    cfg = ADConfig(k=0.0, k_shots=0.0, keeping_window=4, keeping_weight=1.0, spread=1.0, early_boost=0.0)
    divisions = {(2020, t): "eliteserien" for t in "ABCD"}
    # A v B 1-1: B faces 2.0 xG on target, A 1.0; C v D 1-1, each faces 1.0.
    shots = {f"{side}{i}": xg for i in range(2) for side, xg in (("ab", (1.0, 1.0, 2.0, 1.0)), ("cd", (1.0, 1.0, 1.0, 1.0)))}
    model = AttackDefence(config=cfg, divisions=divisions, shots=shots)
    model.observe(match("ab0", "2020-04-01", "A", "B", 1, 1))
    model.observe(match("cd0", "2020-04-01", "C", "D", 1, 1))
    assert model.keeping("B") == 0.0          # one match: under half the window
    model.observe(match("ab1", "2020-04-08", "A", "B", 1, 1))
    model.observe(match("cd1", "2020-04-08", "C", "D", 1, 1))
    # B let in 2 from 4.0; the division 8 from 10.0.
    assert abs(model.keeping("B") - (math.log(4 / 2) - math.log(10 / 8))) < 1e-12
    assert abs(model.keeping("A") - (math.log(2 / 2) - math.log(10 / 8))) < 1e-12
    lam, mu = model.rates("A", "B", "2020-04-15")
    assert abs(lam - math.exp(cfg.base + cfg.home) / 1.6) < 1e-12
    assert abs(mu - math.exp(cfg.base) * 1.25) < 1e-12
    # A copy carries it; matches without xG on target add nothing to it.
    copy = model.copy()
    copy.shots["ab2"] = (1.0, 1.0)
    copy.observe(match("ab2", "2020-04-22", "A", "B", 0, 5))
    assert copy.keeping("B") == model.keeping("B")


def test_each_division_has_its_own_offseason_pull():
    cfg = ADConfig(k=0.1, season_regression=0.5, obos_season_regression=0.25,
                   value_pull=0.0, obos_value_pull=0.0, early_boost=0.0)
    assert cfg.offseason("eliteserien") == (0.5, 0.0) and cfg.offseason("obosligaen") == (0.25, 0.0)
    data = slices(
        (2020, "eliteserien", [match("1", "2020-05-01", "A", "B", 3, 0)]),
        (2020, "obosligaen", [match("2", "2020-05-01", "C", "D", 3, 0)]),
        (2021, "eliteserien", [match("3", "2021-04-01", "A", "B", 1, 1)]),
        (2021, "obosligaen", [match("4", "2021-04-01", "C", "D", 1, 1)]),
    )
    model = AttackDefence.from_slices(data, cfg)
    model.replay(data[0].matches + data[1].matches)
    before = (model.attack["A"] - model.attack["B"], model.attack["C"] - model.attack["D"])
    model.start_season(2021)
    assert abs(model.attack["A"] - model.attack["B"] - 0.5 * before[0]) < 1e-12
    assert abs(model.attack["C"] - model.attack["D"] - 0.25 * before[1]) < 1e-12


def test_elo_v14_defaults():
    cfg = ADConfig()
    assert (cfg.alpha, cfg.keeping_window, cfg.keeping_weight) == (0.9, 45, 0.75)
    assert cfg.offseason("eliteserien") == (0.88, 0.2) and cfg.offseason("obosligaen") == (0.75, 0.3)


def test_a_club_relegated_into_obos_ligaen_keeps_less_and_leans_on_its_value():
    data = slices(
        (2020, "eliteserien", [match("1", "2020-05-01", "A", "B", 3, 0)]),
        (2020, "obosligaen", [match("2", "2020-05-01", "C", "D", 0, 2)]),
        (2021, "eliteserien", [match("3", "2021-04-01", "B", "C", 1, 1)]),
        (2021, "obosligaen", [match("4", "2021-04-01", "A", "D", 1, 1)]),
    )
    cfg = ADConfig(k=0.1, season_regression=0.5, obos_season_regression=0.75, relegated_regression=0.25,
                   value_pull=0.0, obos_value_pull=0.3, early_boost=0.0)
    model = AttackDefence.from_slices(data, cfg, values={2020: {"A": 4e6, "D": 1e6}})
    model.replay(data[0].matches + data[1].matches)
    pre = {name: dict(getattr(model, name)) for name in ("attack", "defence")}
    model.start_season(2021)
    v = 0.5 * math.log(4.0)   # A's log value above the (A, D) geometric mean
    for name in ("attack", "defence"):
        mean = (pre[name]["A"] + pre[name]["D"]) / 2
        after = getattr(model, name)
        # A came down from Eliteserien: keeps a quarter, value shift (1 - 0.25) * 0.3 * v.
        assert abs(after["A"] - (mean + 0.25 * (pre[name]["A"] - mean) + 0.75 * 0.3 * v)) < 1e-12
        assert abs(after["D"] - (mean + 0.75 * (pre[name]["D"] - mean) - 0.25 * 0.3 * v)) < 1e-12
    # C went up: Eliteserien's ordinary pull.
    es_mean = (pre["attack"]["B"] + pre["attack"]["C"]) / 2
    assert abs(model.attack["C"] - (es_mean + 0.5 * (pre["attack"]["C"] - es_mean))) < 1e-12
