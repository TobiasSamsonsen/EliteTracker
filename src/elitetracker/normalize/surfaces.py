"""Which clubs play their home matches on grass, and the edge a home side gets
when its visitor is used to the other surface (elo-v13.0).

Every club plays on artificial turf unless listed here. Sources (checked
2026-10-16): Wikipedia's "List of Eliteserien venues" (surface, and the year a
ground went artificial), then per ground: Nye Høddvoll (Hødd, artificial since
it opened in April 2015), Melløs (Moss, natural grass, NFF's facility
register), Øster Hus Arena (Sandnes Ulf from 2020, artificial; Sandnes Stadion
before it, grass), Nammo stadion (Raufoss, artificial), Bislett (Lyn, grass).
A club that changes ground or surface needs its date here; a newly promoted
club on grass needs a line.

The edge: in Eliteserien, a home side whose visitor normally plays on the
other surface does better than the ratings expect, in both directions (grass
hosting a turf side and turf hosting a grass side), which reads as
familiarity rather than one surface being harder. Measured on elo-v13.0,
both divisions 2016+ (experiments/improvements/surface2.py, surface3.py):

    Eliteserien only, on the prediction, +10 Elo:  -0.00031 log loss (t -2.98),
        Brier and RPS alike, halves t -2.13 / -2.08
    walk-forward over 0-20, Eliteserien 2019+:     -0.00045 (t -1.88), both halves
    OBOS-ligaen (24 % of matches mismatched):       +0.00022 (worse), so not there

The pick runs to 20-60 with the gain growing and t falling; 10 is the shrunk
value. It moves the prediction only: the rating update and the displayed
ratings do not see it.
"""

from __future__ import annotations

# team id -> the first date on artificial turf ("9999": grass throughout).
GRASS_UNTIL: dict[str, str] = {
    "8422": "9999",        # Rosenborg, Lerkendal
    "8468": "9999",        # Brann, Brann Stadion
    "8476": "9999",        # Lillestrøm, Åråsen
    "8512": "9999",        # FK Haugesund, Haugesund Sparebank Arena
    "8531": "9999",        # Bryne, Bryne Stadion
    "8405": "9999",        # Moss, Melløs
    "10224": "9999",       # Lyn, Bislett
    "8478": "2018-01-01",  # Viking: artificial from 2018
    "8007": "2017-01-01",  # Vålerenga: Ullevaal, then Intility Arena from 2017
    "9918": "2023-08-01",  # Stabæk, Nadderud: artificial from August 2023
    "8609": "2024-01-01",  # Sandefjord, Jotun Arena: artificial from 2024
    "8133": "2020-01-01",  # Sandnes Ulf: Sandnes Stadion, then Øster Hus Arena from 2020
}

# Elo points added to the home side's rating when the two surfaces differ
# (Eliteserien league matches only; see the module docstring).
SURFACE_EDGE = 10.0


def is_grass(team_id: str, on: str) -> bool:
    """Whether the club's home ground was grass on that ISO date."""
    return on < GRASS_UNTIL.get(team_id, "0000")


def surface_edge(home_id: str, away_id: str, on: str, edge: float = SURFACE_EDGE) -> float:
    """The home side's extra rating for one Eliteserien match."""
    return edge if is_grass(home_id, on) != is_grass(away_id, on) else 0.0
