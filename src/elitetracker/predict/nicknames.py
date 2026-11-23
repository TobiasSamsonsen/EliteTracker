"""Nickname rules: the usual ones, in one place (the browser mirrors them and
firestore.rules enforces the format, the reserved names and the ASCII claim key).

3 to 20 characters: letters including æøå, digits, spaces, ``_`` and ``-``, with
no space at either end; unique ignoring case; some names are reserved for the
game's own rows. Profanity is not in the rules language: the job hides a name
that fails ``blocked`` (or has been reported by enough different players) from
the boards.
"""

from __future__ import annotations

import re

RESERVED = {"modellen", "folket", "model", "crowd", "predict", "admin", "elitetracker", "moderator"}
_FORMAT = re.compile(r"^[A-Za-zÆØÅæøå0-9_-][A-Za-zÆØÅæøå0-9_ -]{1,18}[A-Za-zÆØÅæøå0-9_-]$")
# A deliberately short list of the plain worst; the report link does the rest.
_BLOCKED = ("fuck", "shit", "cunt", "nigg", "fitte", "hore", "faen", "dritt", "pikk", "rasist", "nazi", "hitler")
REPORTS_TO_HIDE = 3


def lower(nick: str) -> str:
    """Lowercase like the browser's toLowerCase(): Unicode-aware (the rules do the
    three Norwegian capitals by hand, because their lower() is ASCII-only)."""
    return nick.lower()


def key(nick: str) -> str:
    """The ASCII document id of a nickname claim: æ, ø, å become ~e, ~o, ~a."""
    return lower(nick).replace("æ", "~e").replace("ø", "~o").replace("å", "~a")


def problems(nick: str) -> list[str]:
    found = []
    if not _FORMAT.match(nick):
        found.append("format")
    if lower(nick) in RESERVED:
        found.append("reserved")
    return found


def blocked(nick: str) -> bool:
    squashed = re.sub(r"[\s_-]+", "", lower(nick)).replace("0", "o").replace("1", "i").replace("3", "e")
    return any(word in squashed for word in _BLOCKED)
