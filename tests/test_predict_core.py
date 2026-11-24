"""Predict's pure logic: the curve, scoring, the table game, boards, nicknames."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from elitetracker.model import crowd
from elitetracker.model.probabilities import MatchProbabilities
from elitetracker.model.scores import brier, rps
from elitetracker.predict import boards, curve, nicknames, scoring, tables

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))


def test_the_shared_vector_file_is_current():
    import predict_vectors

    stored = json.loads(predict_vectors.PATH.read_text(encoding="utf-8"))
    assert stored == json.loads(json.dumps(predict_vectors.make())), "run tools/predict_vectors.py"


# ---- the curve ---------------------------------------------------------------

def test_the_game_curve_is_the_models_curve_at_the_normal_draw_tendency():
    from elitetracker.model.elo import EloConfig
    from elitetracker.model.probabilities import _draw_model_probabilities

    config = EloConfig()
    assert (config.draw_base, config.draw_scale) == (curve.DRAW_BASE, curve.DRAW_SCALE), \
        "the model's draw curve was refitted: the game's frozen copy stays (bump CURVE_VERSION only on purpose)"
    for gap in (-300, -60, 0, 25, 120, 400):
        model = _draw_model_probabilities(gap, config)
        assert curve.odds(gap) == pytest.approx((model.home_win, model.draw, model.away_win), abs=1e-12)


def test_every_slider_position_stores_whole_percents_that_sum_to_100_within_the_clip():
    for gap in range(curve.GAP_MIN, curve.GAP_MAX + 1, curve.GAP_STEP):
        for tenths in range(curve.K_MIN, curve.K_MAX + 1):
            h, d, a = curve.pick_percentages(gap, tenths)
            assert h + d + a == 100 and all(curve.PCT_MIN <= x <= curve.PCT_MAX for x in (h, d, a)), (gap, tenths)


def test_the_slider_moves_the_bar_the_way_the_model_figure_does():
    h0, d0, a0 = curve.pick_percentages(0)
    assert h0 == a0
    assert curve.pick_percentages(200)[0] > h0 > curve.pick_percentages(-200)[0]
    assert d0 > curve.pick_percentages(400)[1] and d0 > curve.pick_percentages(-400)[1]   # the draw swells near the middle
    assert curve.pick_percentages(curve.GAP_MAX) == (96, 2, 2)                             # a strong favourite reaches the clip
    assert curve.pick_percentages(curve.GAP_MIN) == (2, 2, 96)
    assert curve.pick_percentages(0, 18)[1] > d0 > curve.pick_percentages(0, 5)[1]        # the draw tendency scales it


def test_equivalent_gap_inverts_the_expected_score():
    for gap in (-250, -40, 0, 90, 310):
        h, d, a = curve.odds(gap)
        assert curve.equivalent_gap(h, d) == pytest.approx(gap, abs=1e-6)


# ---- scoring -------------------------------------------------------------------

def test_brier_and_rps_are_the_ffi_and_backtest_numbers():
    assert brier(0.4, 0.3, 0.3, "home_win") == pytest.approx(0.54)               # the plan's example
    assert brier(1.0, 0.0, 0.0, "home_win") == 0.0 and brier(1.0, 0.0, 0.0, "away_win") == 2.0
    assert brier(0.0, 0.5, 0.5, "home_win") == pytest.approx(1.5)
    assert rps(1.0, 0.0, 0.0, "away_win") == 1.0
    from elitetracker.model.backtest import ranked_probability_score
    for outcome in ("home_win", "draw", "away_win"):
        assert ranked_probability_score(MatchProbabilities(0.5, 0.3, 0.2), outcome) == rps(0.5, 0.3, 0.2, outcome)


def test_accuracy_is_the_median_of_the_field_and_the_model_minus_yours():
    picks = {"a": (45, 27, 28), "b": (70, 20, 10), "c": (10, 20, 70)}
    scored = scoring.score_match(picks, (0.5, 0.25, 0.25), "home_win")
    briers = sorted([scored["players"][u]["brier"] for u in picks] + [scored["model"]["brier"]])
    assert scored["median_brier"] == pytest.approx((briers[1] + briers[2]) / 2)        # four voters: the middle two
    for uid in picks:
        row = scored["players"][uid]
        assert row["acc_brier"] == pytest.approx(scored["median_brier"] - row["brier"])
        assert row["vs_model"] == pytest.approx(scored["model"]["brier"] - row["brier"])
    # the best of the field has the highest accuracy, the worst the lowest
    order = sorted(picks, key=lambda u: -scored["players"][u]["acc_brier"])
    assert order[0] == "b" and order[-1] == "c"
    assert scored["crowd"] is None   # three players: below the published minimum


def test_the_model_is_one_voter_so_a_lone_player_has_a_reference():
    scored = scoring.score_match({"solo": (60, 20, 20)}, (0.5, 0.25, 0.25), "home_win")
    mid = (scored["players"]["solo"]["brier"] + scored["model"]["brier"]) / 2
    assert scored["median_brier"] == pytest.approx(mid)
    assert scored["players"]["solo"]["acc_brier"] == pytest.approx(-scored["model"]["acc_brier"])


def test_honest_forecasts_win_in_expectation():
    """The Brier score is proper: the true probabilities score best on average."""
    import random
    rng = random.Random(7)
    truth = (0.5, 0.25, 0.25)
    honest, bold = 0.0, 0.0
    for _ in range(4000):
        roll = rng.random()
        result = "home_win" if roll < 0.5 else "draw" if roll < 0.75 else "away_win"
        honest += brier(*truth, result)
        bold += brier(0.8, 0.1, 0.1, result)
    assert honest < bold


def test_a_crowd_needs_five_players():
    assert scoring.crowd_odds([(50, 25, 25)] * 4) is None
    assert scoring.crowd_odds([(50, 25, 25)] * 5) == pytest.approx((0.5, 0.25, 0.25))


def test_score_round_adds_up_the_matches_a_player_tipped_and_skips_the_rest():
    entries = {"a": {"s1": (60, 20, 20), "s2": (20, 20, 60)}, "b": {"s1": (40, 30, 30)}}
    matches = [{"slot": "s1", "result": "home_win", "model": (0.5, 0.25, 0.25)},
               {"slot": "s2", "result": "away_win", "model": (0.3, 0.3, 0.4)}]
    out = scoring.score_round(entries, matches)
    assert out["players"]["a"]["n"] == 2 and out["players"]["b"]["n"] == 1 and out["matches"] == 2
    assert out["model"]["n"] == 2 and set(out["per_match"]) == {"s1", "s2"} and out["per_match"]["s1"]["n"] == 2


# ---- the table game ----------------------------------------------------------------

TRUTH = list("ABCDEFGHIJKLMNOP")
BANDS_ES = [{"first": 1, "last": 1, "tone": "champion"}, {"first": 1, "last": 2, "tone": "top"},
            {"first": 15, "last": 16, "tone": "relegation"}]


def test_the_footrule_is_the_sum_of_place_differences():
    assert tables.footrule(TRUTH, TRUTH) == 0
    assert tables.footrule(list("BACDEFGHIJKLMNOP"), TRUTH) == 2
    assert tables.footrule(TRUTH[::-1], TRUTH) == 128


def test_bonuses_reward_the_champion_and_the_relegated_in_eliteserien():
    plan = tables.bonus_plan("eliteserien", BANDS_ES)
    assert tables.bonus(TRUTH, TRUTH, plan) == 6 + 3 + 3
    wrong_champion = list("BACDEFGHIJKLMNOP")
    assert tables.bonus(wrong_champion, TRUTH, plan) == 6 - 6 + 6    # champion missed; both relegated still named
    swapped_relegated = list("ABCDEFGHIJKLMNPO")
    assert tables.bonus(swapped_relegated, TRUTH, plan) == 12          # either order counts
    assert tables.error(TRUTH, TRUTH, plan) == -12


def test_obos_ligaen_rewards_the_two_promoted_in_either_order():
    plan = tables.bonus_plan("obosligaen", BANDS_ES)
    assert tables.bonus(list("BACDEFGHIJKLMNOP"), TRUTH, plan) == 4 + 4 + 3 + 3


def test_table_accuracy_is_the_median_error_minus_yours():
    plan = tables.bonus_plan("eliteserien", BANDS_ES)
    out = tables.score_tables({"x": TRUTH, "y": TRUTH[::-1], "z": list("BACDEFGHIJKLMNOP")}, TRUTH, TRUTH, plan)
    assert out["players"]["x"]["accuracy"] > 0 > out["players"]["y"]["accuracy"]
    assert out["players"]["x"]["error"] == -12 and out["model"]["error"] == -12


# ---- boards, nicknames, the crowd --------------------------------------------

def test_a_board_ranks_by_points_and_keeps_hidden_players_in_the_percentiles():
    players = [{"uid": "a", "nick": "Aa_1", "hidden": False, "totals": {"n": 3, "b": 1.0, "r": 0.3, "ab": 0.5, "ar": 0.2, "vm": 0.1}},
               {"uid": "b", "nick": "Bb_1", "hidden": True, "totals": {"n": 3, "b": 1.5, "r": 0.3, "ab": 0.9, "ar": 0.2, "vm": 0.1}},
               {"uid": "c", "nick": "Cc_1", "hidden": False, "totals": {"n": 0, "b": 0, "r": 0, "ab": 0, "ar": 0, "vm": 0}},
               {"uid": "d", "nick": "Dd_1", "hidden": False, "totals": {"n": 1, "b": 0.1, "r": 0.1, "ab": 0.9, "ar": 0.2, "vm": 0.1}}]
    model = {"n": 3, "b": 1.2, "r": 0.4, "ab": 0.7, "ar": 0.1, "vm": 0.0}
    board = boards.make_board("season", players, model=model, crowd=None, updated="now")
    # hidden b and idle c are not listed; three matches at a Brier of 1/3 beat one near-perfect match
    assert [r["nick"] for r in board["rows"]] == ["Aa_1", "Modellen", "Dd_1"]
    assert [r["pts"] for r in board["rows"]] == [20.0, 18.0, 9.0]
    # places count the hidden player (b, 15 points, is second), so Dd_1 is third; the model takes none
    assert [r.get("place") for r in board["rows"]] == [1, None, 3]
    assert board["rows"][0]["acc"] == pytest.approx(100 * (1 - 1 / 3 / 2), abs=1e-4) and board["rows"][2]["acc"] == 95.0
    assert board["players"] == 3 and board["pct"][100] == 20.0 and board["pct"][0] == 9.0
    assert boards.uid_hash("abc") == boards.uid_hash("abc") and len(boards.uid_hash("abc")) == 10
    assert boards.uid_hash("abc") != "abc"


def test_points_are_brier_shifted_so_a_cautious_pick_never_loses():
    assert scoring.match_points(0.0) == 10.0 and scoring.match_points(1.0) == 0.0
    # 37 / 26 / 37 scores above zero whatever happens; 96 / 2 / 2 that misses loses 8.8
    for result in (scoring.HOME, scoring.DRAW, scoring.AWAY):
        assert scoring.match_points(brier(0.37, 0.26, 0.37, result)) > 0
    assert scoring.match_points(brier(0.96, 0.02, 0.02, scoring.AWAY)) == pytest.approx(-8.824, abs=0.001)
    assert scoring.total_points(2, 0.5) == 15.0 and scoring.accuracy(2, 0.8) == 80.0 and scoring.accuracy(0, 0) is None


def test_percentiles():
    assert boards.percentile_table([]) == []
    table = boards.percentile_table([1, 2, 3, 4, 5])
    assert len(table) == 101 and table[0] == 1 and table[50] == 3 and table[100] == 5


def test_nickname_rules():
    assert nicknames.problems("Tipper_1") == [] and nicknames.problems("Øyvind_9") == []
    assert nicknames.problems("ab") == ["format"] and nicknames.problems(" lead") == ["format"]
    assert nicknames.problems("Modellen") == ["reserved"] and nicknames.problems("FOLKET") == ["reserved"]
    assert nicknames.key("Øyvind_9") == "~oyvind_9" and nicknames.key("ÆØÅ æøå") == "~e~o~a ~e~o~a"
    assert nicknames.blocked("Sh1t_head") and not nicknames.blocked("Greit_Navn")


def test_the_crowd_signal_is_zero_below_thirty_players_and_follows_a_real_deviation():
    assert crowd.signal(0.5, 0.25, [(100.0, 0.5)] * 29) == 0.0
    model_gap = curve.equivalent_gap(0.5, 0.25)
    copiers = [(model_gap, 1.0)] * 40
    assert crowd.signal(0.5, 0.25, copiers) == pytest.approx(0.0, abs=1e-9)          # a copier adds nothing
    informed = [(model_gap + 60, 0.5)] * 40
    shift = crowd.signal(0.5, 0.25, informed)
    assert 0 < shift < 60                                                            # shrunk toward the model
    stale = [(model_gap + 60, 10.0)] * 40
    assert 0 < crowd.signal(0.5, 0.25, stale) < shift                                # an older pick weighs less


def test_the_overall_board_adds_both_divisions():
    t = lambda n, b: {"n": n, "b": b, "r": 0.0, "ab": 0.0, "ar": 0.0, "vm": 0.0}
    es_rounds = [{"key": "2026_eliteserien_1", "round": 1, "matches": 2, "settled": 2}]
    obos_rounds = [{"key": "2026_obosligaen_1", "round": 1, "matches": 2, "settled": 2}]
    es = {"a": {"nick": "Aa_1", "hidden": False, "rounds": {"2026_eliteserien_1": t(2, 0.4)}}}
    obos = {"a": {"nick": "Aa_1", "hidden": False, "rounds": {"2026_obosligaen_1": t(1, 0.5)}},
            "b": {"nick": "Bb_1", "hidden": False, "rounds": {"2026_obosligaen_1": t(2, 1.0)}}}
    board = boards.build_overall_board(2026, {"eliteserien": (es, es_rounds), "obosligaen": (obos, obos_rounds)},
                                       model_rounds={"2026_eliteserien_1": t(2, 0.6), "2026_obosligaen_1": t(2, 0.6)},
                                       crowd_rounds={}, updated="now")
    rows = {r["nick"]: r for r in board["rows"]}
    assert rows["Aa_1"]["n"] == 3 and rows["Aa_1"]["pts"] == pytest.approx(30 - 9.0)
    assert "streak" not in rows["Aa_1"]
    assert rows["Modellen"]["n"] == 4 and board["players"] == 2 and board["league"] == "all"
