"""The "round closes" calendar feed (public/predict/rounds.ics).

A plain iCalendar file that a phone can subscribe to: one event per open or
coming round, at its first kick-off, with a reminder an hour before. It is the
cheap trigger from the plan, with no push infrastructure.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Iterable, Mapping

LEAGUE_NAMES = {"eliteserien": "Eliteserien", "obosligaen": "OBOS-ligaen"}


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _fold(line: str) -> list[str]:
    """RFC 5545 line folding at 75 octets (continuation lines start with a space)."""
    parts: list[str] = []
    current = ""
    for char in line:
        if len((current + char).encode("utf-8")) > (75 if not parts else 74):
            parts.append(current)
            current = char
        else:
            current += char
    parts.append(current)
    return [parts[0]] + [" " + p for p in parts[1:]]


def calendar(fixtures: Iterable[Mapping], now: datetime) -> str:
    """``fixtures``: round documents with league, round, season, closes (aware datetime)."""
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//EliteTracker//Predict//NB", "CALSCALE:GREGORIAN",
             "X-WR-CALNAME:Predict: runder som stenger", "X-WR-TIMEZONE:Europe/Oslo"]
    for doc in sorted(fixtures, key=lambda d: (d["closes"], d["league"])):
        if doc["closes"] <= now:
            continue
        league = LEAGUE_NAMES.get(doc["league"], doc["league"])
        uid = f"predict-{doc['season']}-{doc['league']}-{doc['round']}@elitetracker.no"
        lines += ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{_stamp(now)}", f"DTSTART:{_stamp(doc['closes'])}",
                  "DURATION:PT15M"]
        lines += _fold(f"SUMMARY:Predict: runde {doc['round']} stenger ({league})")
        lines += _fold(f"DESCRIPTION:Tipp kampene i runde {doc['round']} før første avspark. "
                       f"Round {doc['round']} closes at the first kick-off.")
        lines += ["URL:https://elitetracker.no/predict/", "BEGIN:VALARM", "ACTION:DISPLAY",
                  "DESCRIPTION:Runden stenger om en time", "TRIGGER:-PT1H", "END:VALARM", "END:VEVENT"]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"
