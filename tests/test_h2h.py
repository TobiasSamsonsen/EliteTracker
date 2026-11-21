"""The head-to-head meetings are a file of their own (h2h.json), read by Compare."""

import json
from dataclasses import asdict

from elitetracker.normalize.matches import Match
from elitetracker.pipeline import careers_payload, h2h_payload


def match(match_id, season, home, away, goals, played=True):
    return Match(match_id=match_id, date=f"{season}-05-01", time="18:00", home=home.title(), away=away.title(),
                 home_goals=goals[0] if played else None, away_goals=goals[1] if played else None,
                 played=played, home_id=home, away_id=away)


def write(root, season, matches):
    (root / f"eliteserien_{season}_matches.json").write_text(json.dumps([asdict(m) for m in matches]), encoding="utf-8")


def test_the_meetings_are_compact_and_keyed_by_the_pair(tmp_path):
    write(tmp_path, 2020, [match("1", 2020, "a", "b", (2, 1)), match("2", 2020, "b", "c", (0, 0)),
                           match("3", 2020, "a", "b", (0, 0), played=False)])
    write(tmp_path, 2021, [match("4", 2021, "b", "a", (3, 3))])
    payload = h2h_payload(tmp_path)
    assert sorted(payload["matches"]) == ["a\tb", "b\tc"]   # sorted pair; the unplayed one is out
    first, second = payload["matches"]["a\tb"]
    assert first[:6] == ["2020-05-01", 2020, "a", "b", 2, 1] and second[:6] == ["2021-05-01", 2021, "b", "a", 3, 3]
    # The names are indexes into one list, each spelling once.
    assert [payload["names"][i] for i in first[6:]] == ["A", "B"]
    assert len(payload["names"]) == len(set(payload["names"])) == 3


def test_the_careers_no_longer_carry_them():
    assert "head_to_head" not in careers_payload({})
