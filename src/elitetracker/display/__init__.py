"""Display-only modules, excluded from the simulation signature.

See `fixtures.py`. Nothing in this package feeds the Monte Carlo, so editing
it must not invalidate cached past-season reports.
"""

from elitetracker.display.fixtures import build_fixtures_payload, top_scorelines
from elitetracker.display.pairwise import build_pairwise_payload
from elitetracker.model.elo import EloConfig

__all__ = ["build_fixtures_payload", "top_scorelines", "build_pairwise_payload", "combined_pairwise"]


def combined_pairwise(reports: dict, elo_config: EloConfig | None = None) -> dict:
    """Three-way odds for every ordered pair across *all* divisions.

    The two leagues share one rating scale, so a club from either can meet a
    club from the other in a fictional match. Building this once over every
    club's current rating lets the compare tool mix divisions freely.
    """
    ratings = {
        row["team_id"]: row["rating"]
        for report in reports.values()
        for row in report["table"]
    }
    return build_pairwise_payload(ratings, elo_config or EloConfig())
