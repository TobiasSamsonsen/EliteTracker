"""Norway's UEFA association rank: parsing UEFA's payload and keeping
uefa_ranks.json current from the refresh."""

import json
from datetime import date

import pytest

from elitetracker.refresh import refresh_uefa_rank
from elitetracker.sources.fotmob import FetchError
from elitetracker.sources.uefa import association_rank


def payload(*ranks):
    return {"data": {"members": [
        {"member": {"countryCode": code}, "overallRanking": {"position": position}}
        for code, position in ranks
    ]}}


class TestAssociationRank:
    def test_reads_the_country_position(self):
        assert association_rank(payload(("ENG", 1), ("NOR", 14))) == 14

    def test_a_missing_country_or_a_changed_shape_is_a_fetch_error(self):
        with pytest.raises(FetchError):
            association_rank(payload(("ENG", 1)))
        with pytest.raises(FetchError):
            association_rank({"data": {}})


def stored(root):
    return json.loads((root / "uefa_ranks.json").read_text(encoding="utf-8"))


class TestRefreshUefaRank:
    def test_writes_the_seasons_rank(self, tmp_path):
        refresh_uefa_rank(tmp_path, 2027, fetch=lambda season: 12, today=date(2027, 4, 1))
        assert stored(tmp_path) == {"2027": 12}

    def test_a_provisional_rank_is_refetched_until_august(self, tmp_path):
        refresh_uefa_rank(tmp_path, 2027, fetch=lambda season: 12, today=date(2027, 4, 1))
        refresh_uefa_rank(tmp_path, 2027, fetch=lambda season: 13, today=date(2027, 7, 1))
        assert stored(tmp_path) == {"2027": 13}

    def test_a_final_rank_costs_no_request(self, tmp_path):
        refresh_uefa_rank(tmp_path, 2027, fetch=lambda season: 13, today=date(2027, 7, 1))

        def boom(season):
            raise AssertionError("fetched a final rank")

        refresh_uefa_rank(tmp_path, 2027, fetch=boom, today=date(2027, 8, 1))
        assert stored(tmp_path) == {"2027": 13}

    def test_a_failed_fetch_or_an_unmodelled_rank_keeps_the_file(self, tmp_path):
        refresh_uefa_rank(tmp_path, 2027, fetch=lambda season: 13, today=date(2027, 4, 1))

        def down(season):
            raise FetchError("unreachable")

        refresh_uefa_rank(tmp_path, 2027, fetch=down, today=date(2027, 5, 1))
        refresh_uefa_rank(tmp_path, 2027, fetch=lambda season: 3, today=date(2027, 5, 1))
        assert stored(tmp_path) == {"2027": 13}
