"""Tests for the display-only pairwise odds payload."""

from __future__ import annotations

import pytest

from elitetracker.display import build_pairwise_payload
from elitetracker.model.elo import EloConfig


def test_pairwise_covers_every_ordered_pair():
    ratings = {"A": 1600.0, "B": 1500.0, "C": 1400.0}
    payload = build_pairwise_payload(ratings, EloConfig())
    assert set(payload) == {"A", "B", "C"}
    for home in ratings:
        for away in ratings:
            if home == away:
                assert away not in payload[home]
            else:
                assert away in payload[home]


def test_pairwise_probabilities_sum_to_one_and_respect_strength():
    ratings = {"A": 1650.0, "B": 1450.0}
    payload = build_pairwise_payload(ratings, EloConfig())
    a_home = payload["A"]["B"]
    b_home = payload["B"]["A"]
    for entry in (a_home, b_home):
        assert entry["home_win"] + entry["draw"] + entry["away_win"] == pytest.approx(1.0)
    # The stronger club (A) is the favourite whichever side hosts.
    assert a_home["home_win"] > a_home["away_win"]
    assert b_home["away_win"] > b_home["home_win"]
    # At home, the stronger club is more likely to win than the weaker club is.
    assert a_home["home_win"] > b_home["home_win"]


def test_pairwise_scorelines_present_and_ordered():
    ratings = {"A": 1600.0, "B": 1500.0}
    payload = build_pairwise_payload(ratings, EloConfig())
    lines = payload["A"]["B"]["scorelines"]
    assert lines
    probs = [line["probability"] for line in lines]
    assert probs == sorted(probs, reverse=True)
    assert all(0.0 < line["probability"] <= 1.0 for line in lines)
