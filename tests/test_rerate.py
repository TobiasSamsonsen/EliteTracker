"""The what-if page re-rates the clubs in the browser (`public/season-sim.js`,
`rerateSeason`): a port of the Elo replay and the attack/defence update, run
over `pipeline.rerate_payload`. This builds a small season with everything the
real one has (xG and xG on target, keeping windows, a club promoted from the
other division, a played match changed and a fixture taken as played), has the
Python model replay it, and writes both the payload and what Python made of it
to `tests/fixtures/rerate.json`, which tests/frontend.test.js holds the port to.

After a deliberate model change, rewrite the golden file from the repo root
with `python -m tests.test_rerate`, then bring the port up to it."""

import dataclasses
import json
import random
from datetime import date, timedelta
from itertools import permutations
from pathlib import Path

from elitetracker.model.attack_defence import ADConfig, AttackDefence, KEEPING_LEAGUE_ROWS
from elitetracker.model.career import SeasonSlice
from elitetracker.model.elo import era_config
from elitetracker.model.initial_ratings import TeamRating
from elitetracker.model.ratings import build_rating_table
from elitetracker.normalize.matches import Match
from elitetracker.pipeline import rerate_payload

GOLDEN = Path(__file__).with_name("fixtures") / "rerate.json"

ELITE = ["A", "B", "C", "D"]
OBOS = ["E", "F", "G", "D"]  # D plays OBOS-ligaen in 2025 and is promoted for 2026


def season(year, league, clubs, rounds, rng, shots, *, played=True, first_id=0):
    """`rounds` double round robins of `clubs`, one match a day, a match in
    five without xG; shots are the model's (home xG, away xG, home xGoT, away xGoT)."""
    day = date(year, 4, 1)
    matches = []
    for number, (home, away) in enumerate(pair for _ in range(rounds) for pair in permutations(clubs, 2)):
        match_id = f"{year}-{league[0]}-{first_id + number}"
        goals = (rng.randint(0, 4), rng.randint(0, 3)) if played else (None, None)
        matches.append(Match(match_id=match_id, date=(day + timedelta(days=number)).isoformat(), time=None,
                             home=home, away=away, home_goals=goals[0], away_goals=goals[1], played=played,
                             home_id=home, away_id=away))
        if played and rng.random() < 0.8:
            xg = (round(rng.uniform(0.2, 3.0), 2), round(rng.uniform(0.2, 2.5), 2))
            shots[match_id] = (*xg, round(xg[0] * rng.uniform(0.3, 0.6), 2), round(xg[1] * rng.uniform(0.3, 0.6), 2))
    return matches


def build():
    """(payload, edits, expected before, expected after): the payload the
    report would carry, the changes made, and the Python model's ratings."""
    rng = random.Random(7)
    shots: dict[str, tuple[float, ...]] = {}
    last = season(2025, "eliteserien", ELITE, 5, rng, shots) + season(2025, "obosligaen", OBOS, 5, rng, shots)
    this = season(2026, "eliteserien", ELITE, 2, rng, shots)
    played, fixtures = this[:16], this[16:]
    # Half the 2026 matches are still to play, and have no xG.
    for match in fixtures:
        shots.pop(match.match_id, None)
    this = played + [dataclasses.replace(m, home_goals=None, away_goals=None, played=False) for m in fixtures]
    slices = [SeasonSlice("eliteserien", "Eliteserien", 2025, [m for m in last if m.match_id.startswith("2025-e")]),
              SeasonSlice("obosligaen", "OBOS-ligaen", 2025, [m for m in last if m.match_id.startswith("2025-o")]),
              SeasonSlice("eliteserien", "Eliteserien", 2026, this)]
    prior = AttackDefence.from_slices(slices, ADConfig(), shots=shots).replay(last)
    start = prior.copy()
    start.start_season(2026)
    seeds = {team: TeamRating(team, team, round(1450 + 40 * i + rng.uniform(-5, 5), 1)) for i, team in enumerate(ELITE)}
    era = era_config(2026)
    payload = rerate_payload("eliteserien", this, seeds, shots, start, era)

    def expected(matches):
        ratings = build_rating_table(seeds, matches, shots=shots)
        ad = prior.copy().replay(matches)
        ad.start_season(2026)
        return {"elo": ratings,
                "teams": {t: [ad.attack[t], ad.defence[t], ad.finishing.get(t, 0.0), ad.keeping(t)] for t in ELITE}}

    # One played match with another score, and the next fixture taken as played.
    changed_id = played[3].match_id
    new_score = [played[3].away_goals + 2, played[3].home_goals]
    taken = fixtures[0]
    edited = [dataclasses.replace(m, home_goals=new_score[0], away_goals=new_score[1]) if m.match_id == changed_id else m
              for m in this]
    edited = [dataclasses.replace(m, home_goals=1, away_goals=3, played=True) if m.match_id == taken.match_id else m
              for m in edited]
    edits = {"changed": {changed_id: new_score},
             "appended": [[taken.match_id, taken.home_id, taken.away_id, 1, 3, None, None, None, None]]}
    return payload, edits, expected(this), expected(edited)


def golden() -> dict:
    payload, edits, before, after = build()
    return {"payload": payload, "edits": edits, "expected": {"as_played": before, "edited": after}}


def rounded(value):
    """The golden numbers to 9 places, so the file survives another machine's last bit."""
    if isinstance(value, float):
        return round(value, 9)
    if isinstance(value, dict):
        return {key: rounded(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [rounded(item) for item in value]
    return value


def test_the_golden_file_is_what_the_model_makes():
    assert json.loads(GOLDEN.read_text(encoding="utf-8")) == rounded(json.loads(json.dumps(golden())))


def test_the_payload_carries_each_clubs_start_and_the_played_matches():
    payload = golden()["payload"]
    assert set(payload["start"]) == set(ELITE)
    assert len(payload["matches"]) == 16
    assert payload["windows"].keys() == {"eliteserien", "obosligaen"}  # D is still keeping against OBOS-ligaen
    assert payload["start"]["D"]["reference"] == "obosligaen"
    assert all(len(window) <= KEEPING_LEAGUE_ROWS for window in payload["windows"].values())
    assert any(row[5] is not None and row[7] is not None for row in payload["matches"])  # xG and xG on target
    assert any(row[5] is None for row in payload["matches"])  # and a match without


if __name__ == "__main__":
    GOLDEN.write_text(json.dumps(rounded(json.loads(json.dumps(golden()))), indent=1) + "\n", encoding="utf-8")
    print(f"wrote {GOLDEN}")
