"""Generate the shipped gap-binned scoreline model from the replayed corpus.

Replays every held season with the production config (including cross-season
regression) so each match is labelled with the *pre-match* effective rating gap
it would actually have been simulated with, then bins matches by that gap and
emits `data/scoreline_model.json`. Run after a model change that moves ratings
(or periodically as more seasons accumulate):

    python -m elitetracker.build_scoreline_model
"""

from __future__ import annotations

import json
from pathlib import Path

from elitetracker.model.elo import EloConfig, updated_pair
from elitetracker.model.scorelines import (
    AWAY_WIN,
    DRAW,
    HOME_WIN,
    ScorelineModel,
)
from elitetracker.model.ratings import rating_for_unseeded_team
from elitetracker.normalize.matches import Match
from elitetracker.pipeline import load_slices, seed_ratings

BINS = 5
OUTPUT = Path(__file__).resolve().parent.parent.parent / "data" / "scoreline_model.json"


def _replay_gaps() -> list[tuple[str, float, tuple[int, int]]]:
    """Label every played match with its pre-match effective rating gap."""
    config = EloConfig()
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings().items()}
    ratings: dict[str, float] = dict(seeds)

    slices = load_slices()
    seasons_sorted = sorted({slice_.season for slice_ in slices})
    first_season = seasons_sorted[0]
    labeled: list[tuple[str, float, tuple[int, int]]] = []

    for season in seasons_sorted:
        if season != first_season and config.season_regression < 1.0:
            pool = list(ratings.values())
            if pool:
                mean = sum(pool) / len(pool)
                for team_id in list(ratings):
                    ratings[team_id] = mean + config.season_regression * (ratings[team_id] - mean)

        in_season = [slice_ for slice_ in slices if slice_.season == season]
        for slice_ in in_season:
            for match in slice_.matches:
                for team_id in (match.home_id, match.away_id):
                    ratings.setdefault(team_id, rating_for_unseeded_team())

        for slice_ in in_season:
            for match in sorted(slice_.matches, key=Match.sort_key):
                if not match.played:
                    continue
                home_id = match.home_id or match.home
                away_id = match.away_id or match.away
                gap = (ratings[home_id] + config.home_advantage) - ratings[away_id]
                if match.home_goals > match.away_goals:
                    outcome = HOME_WIN
                elif match.home_goals < match.away_goals:
                    outcome = AWAY_WIN
                else:
                    outcome = DRAW
                labeled.append((outcome, gap, (match.home_goals, match.away_goals)))
                ratings[home_id], ratings[away_id] = updated_pair(
                    ratings[home_id], ratings[away_id], match.home_goals, match.away_goals, config
                )
    return labeled


def main() -> int:
    labeled = _replay_gaps()
    model = ScorelineModel.from_corpus(labeled, bins=BINS)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8") as handle:
        json.dump(model.to_constants(), handle, indent=2, ensure_ascii=False)
    per_bin = sum(len(table) for outcome in model.flat_tables() for table in outcome)
    print(f"wrote {OUTPUT}  bins={model.bins}  matches={len(labeled)}  cells={per_bin}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
