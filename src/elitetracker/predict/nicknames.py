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
# A deliberately short list of the plain worst; the report link does the rest. The long, unambiguous
# words are caught anywhere in a name; the short ones only as a whole word, so Thore, Håkon_Thore and
# Scunthorpe stay legal (and "Hore_99", "h0re" and "h_o_r_e" do not).
_BLOCKED_ANYWHERE = ("fuck", "shit", "nigg", "dritt", "rasist", "hitler")
_BLOCKED_WORDS = ("cunt", "fitte", "hore", "faen", "pikk", "nazi")
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


def _leet(text: str) -> str:
    return text.replace("0", "o").replace("1", "i").replace("3", "e")


def blocked(nick: str) -> bool:
    tokens = [part for part in re.split(r"[\s_-]+", lower(nick)) if part]
    squashed = "".join(tokens)
    if any(word in _leet(squashed) for word in _BLOCKED_ANYWHERE):
        return True
    # a whole word, with or without a number after it: "Hore", "hore99", "h0re", "h_o_r_e"
    return any(_leet(part.rstrip("0123456789")) in _BLOCKED_WORDS for part in (squashed, *tokens))
