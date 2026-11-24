"""The pre-season table game: club order against the final table.

The error is a footrule, the sum of absolute place differences, less bonus
points for the places that matter most. Accuracy is the field's median error
(the model's expected table counts as one voter) minus yours, so positive is
better than half. The bonus values are the plan's starting values; they are
meant to be tuned later (docs/predict-plan.md, section 2).
"""

from __future__ import annotations

from statistics import median
from typing import Mapping, Sequence

# league slug -> {band tone: points per correctly named club}. A band of one
# place (the champion) must be named in that place; a wider band takes the
# club in any of its places.
BONUSES = {
    "eliteserien": {"champion": 6, "relegation": 3},
    "obosligaen": {"top": 4, "relegation": 3},   # "top" is the two promotion places
}


def bonus_plan(slug: str, bands: Sequence[Mapping]) -> list[dict]:
    """The bonuses that apply, as {first, last, points} from the league's bands
    (league.bands in the report)."""
    wanted = BONUSES.get(slug, {})
    return [{"first": b["first"], "last": b["last"], "points": wanted[b["tone"]]}
            for b in bands if b.get("tone") in wanted]


def footrule(order: Sequence[str], truth: Sequence[str]) -> int:
    place = {club: i for i, club in enumerate(truth)}
    return sum(abs(i - place[club]) for i, club in enumerate(order))


def bonus(order: Sequence[str], truth: Sequence[str], plan: Sequence[Mapping]) -> int:
    total = 0
    for band in plan:
        first, last = band["first"] - 1, band["last"] - 1
        if first == last:
            total += band["points"] if order[first] == truth[first] else 0
        else:
            named = set(order[first:last + 1])
            total += band["points"] * sum(1 for club in truth[first:last + 1] if club in named)
    return total


def error(order: Sequence[str], truth: Sequence[str], plan: Sequence[Mapping]) -> int:
    return footrule(order, truth) - bonus(order, truth, plan)


def score_tables(orders: Mapping[str, Sequence[str]], truth: Sequence[str], model_order: Sequence[str],
                 plan: Sequence[Mapping]) -> dict:
    """Errors and Accuracy (median error minus yours) for every player, plus the model."""
    errors = {uid: error(order, truth, plan) for uid, order in orders.items()}
    model_error = error(model_order, truth, plan)
    reference = median(list(errors.values()) + [model_error])
    return {"players": {uid: {"error": e, "accuracy": reference - e} for uid, e in errors.items()},
            "model": {"error": model_error, "accuracy": reference - model_error},
            "median": reference}
