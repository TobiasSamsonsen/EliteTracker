"""Adapter for fotmob payloads: matches and final league tables.

fotmob timestamps kickoffs in UTC. The matchday a fixture belongs to is the
*local* date, so we convert to Europe/Oslo before splitting into date and time
-- a 22:00 CEST kickoff is 20:00 UTC on the same day, but a late kickoff near
midnight would otherwise land on the wrong matchday.

Team identity comes from fotmob's numeric team id rather than the name, so
standings and fixtures join reliably even when a club is written differently
("Sandefjord" vs "Sandefjord Fotball").
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

from elitetracker.normalize.matches import (
    Match,
    NormalizationError,
    clean_text,
    dump,
    finalize,
    parse_score,
)
from elitetracker.normalize.standings import Standing

LEAGUE_TIMEZONE = ZoneInfo("Europe/Oslo")


def _parse_utc(raw: Any) -> datetime:
    text = clean_text(raw)
    if text is None:
        raise NormalizationError("missing kickoff time")
    try:
        # fotmob writes a trailing "Z"; fromisoformat wants an explicit offset
        # on Python versions before 3.11.
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError as exc:
        raise NormalizationError(f"unparseable kickoff {text!r}") from exc


def _team(raw: Any, side: str, match_id: str) -> tuple[str, str | None]:
    if not isinstance(raw, dict):
        raise NormalizationError(f"match {match_id}: missing {side} team")
    name = clean_text(raw.get("name"))
    if name is None:
        raise NormalizationError(f"match {match_id}: missing {side} team name")
    return name, clean_text(raw.get("id"))


def _round_number(raw: dict[str, Any]) -> int | None:
    for key in ("roundName", "round"):
        value = raw.get(key)
        if value is None:
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def normalize_match(raw: dict[str, Any]) -> Match:
    match_id = clean_text(raw.get("id"))
    if match_id is None:
        raise NormalizationError("missing match id")

    home, home_id = _team(raw.get("home"), "home", match_id)
    away, away_id = _team(raw.get("away"), "away", match_id)
    if home_id is not None and home_id == away_id:
        raise NormalizationError(f"match {match_id}: {home} plays itself")

    status = raw.get("status") or {}
    kickoff = _parse_utc(status.get("utcTime"))
    local = kickoff.astimezone(LEAGUE_TIMEZONE)

    finished = bool(status.get("finished")) and not status.get("cancelled")
    home_goals, away_goals = parse_score(status.get("scoreStr")) if finished else (None, None)
    if finished and home_goals is None:
        raise NormalizationError(f"match {match_id}: finished but has no score")

    return Match(
        match_id=match_id,
        date=local.date().isoformat(),
        time=local.strftime("%H:%M"),
        home=home,
        away=away,
        venue=None,  # not present in the fotmob league payload
        home_goals=home_goals,
        away_goals=away_goals,
        played=home_goals is not None,
        kickoff_utc=kickoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
        round=_round_number(raw),
        home_id=home_id,
        away_id=away_id,
    )


def is_cancelled(raw: dict[str, Any]) -> bool:
    """An abandoned or cancelled fixture, which is not part of the schedule.

    Eliteserien 2024 carries both the abandoned Rosenborg v Lillestrøm of
    21 July and its replay on 21 August, so the raw list has 241 rows for a
    240-match season. The void record has to go, or those two clubs end up
    with an extra fixture each.
    """
    return bool((raw.get("status") or {}).get("cancelled"))


def normalize_matches(raw_matches: list[dict[str, Any]]) -> list[Match]:
    return finalize(normalize_match(raw) for raw in raw_matches if not is_cancelled(raw))


def normalize_standing(raw: dict[str, Any]) -> Standing:
    team = clean_text(raw.get("name"))
    team_id = clean_text(raw.get("id"))
    if team is None or team_id is None:
        raise NormalizationError(f"standings row missing team identity: {raw}")

    scores = clean_text(raw.get("scoresStr"))
    goals_for, goals_against = parse_score(scores)
    if goals_for is None:
        raise NormalizationError(f"{team}: unparseable goals {scores!r}")

    try:
        position = int(raw["idx"])
        played = int(raw["played"])
        wins = int(raw["wins"])
        draws = int(raw["draws"])
        losses = int(raw["losses"])
        points = int(raw["pts"])
    except (KeyError, TypeError, ValueError) as exc:
        raise NormalizationError(f"{team}: malformed standings row ({exc})") from exc

    return Standing(
        position=position,
        team=team,
        team_id=team_id,
        played=played,
        wins=wins,
        draws=draws,
        losses=losses,
        goals_for=goals_for,
        goals_against=goals_against,
        points=points,
        # fotmob reports deductions as a negative number, or null for none.
        deduction=int(raw.get("deduction") or 0),
    )


def normalize_standings(raw_rows: list[dict[str, Any]]) -> list[Standing]:
    return sorted((normalize_standing(row) for row in raw_rows), key=lambda s: s.position)
