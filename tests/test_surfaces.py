"""The pitch-surface table and the edge it gives an Eliteserien home side."""

from elitetracker.model.backtest import walk_forward
from elitetracker.model.career import SeasonSlice
from elitetracker.normalize.matches import Match
from elitetracker.normalize.surfaces import SURFACE_EDGE, is_grass, surface_edge


def test_grounds_change_surface_on_their_dates():
    assert is_grass("8468", "2026-05-01")            # Brann: grass throughout
    assert is_grass("8478", "2017-10-01") and not is_grass("8478", "2018-04-01")  # Viking turf from 2018
    assert is_grass("9918", "2023-07-30") and not is_grass("9918", "2023-08-05")  # Stabæk, August 2023
    assert not is_grass("8402", "2016-05-01")        # unlisted: artificial turf


def test_the_edge_goes_to_the_home_side_either_way_round():
    on = "2026-05-01"
    assert surface_edge("8468", "8402", on) == SURFACE_EDGE   # grass hosts turf
    assert surface_edge("8402", "8468", on) == SURFACE_EDGE   # turf hosts grass
    assert surface_edge("8402", "9917", on) == 0.0            # turf v turf
    assert surface_edge("8468", "8422", on) == 0.0            # grass v grass


def test_the_backtest_adds_it_to_eliteserien_predictions_only():
    def season(league, home, away):
        return SeasonSlice(league, league, 2026, [Match(match_id=f"{league}1", date="2026-05-01", time="18:00",
                           home=home, away=away, home_goals=1, away_goals=0, played=True, home_id=home, away_id=away)])
    seeds = {"8468": 1500.0, "8402": 1500.0}
    elite = walk_forward([season("eliteserien", "8468", "8402")], seeds, score_from_season=2026)
    obos = walk_forward([season("obosligaen", "8468", "8402")], seeds, score_from_season=2026)
    (p_elite, _), = elite.predictions.values()
    (p_obos, _), = obos.predictions.values()
    assert p_elite.home_win > p_obos.home_win
    assert abs(p_elite.rating_gap - p_obos.rating_gap - SURFACE_EDGE / 400) < 1e-12
