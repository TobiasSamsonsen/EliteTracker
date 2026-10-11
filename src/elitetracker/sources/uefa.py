"""Norway's UEFA association rank, which decides which Eliteserien places
lead into Europe (see `pipeline._europe_by_rank`).

UEFA's coefficient API needs no key. `seasonYear` is the year a European
season ends in, and its ranking decides the access list two seasons on --
which is the one the Eliteserien season of that same year feeds.
"""

from __future__ import annotations

import json
from typing import Any

from elitetracker.sources.fotmob import FetchError, _download

_URL = (
    "https://comp.uefa.com/v2/coefficients?coefficientRange=OVERALL"
    "&coefficientType=MEN_ASSOCIATION&language=EN&page=1&pagesize=60&seasonYear={season}"
)


def association_rank(payload: dict[str, Any], country: str = "NOR") -> int:
    """The association's position in one coefficients payload."""
    try:
        for entry in payload["data"]["members"]:
            if entry["member"]["countryCode"] == country:
                return int(entry["overallRanking"]["position"])
    except (KeyError, TypeError, ValueError) as exc:
        raise FetchError(f"unexpected UEFA coefficients payload: {exc!r}") from exc
    raise FetchError(f"{country} missing from the UEFA coefficients payload")


def fetch_rank(season: int, country: str = "NOR") -> int:
    url = _URL.format(season=season)
    try:
        payload = json.loads(_download(url))
    except json.JSONDecodeError as exc:
        raise FetchError(f"{url} did not return JSON") from exc
    return association_rank(payload, country)
