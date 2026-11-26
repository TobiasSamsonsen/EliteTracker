"""Static entry pages for the site's routes, written next to `public/index.html`.

The app folds every view into one document, so a crawler or a link unfurler
used to meet one page with one title. Each route below gets its own copy of
`index.html` with its own title, description, canonical address and social
card, plus a `<meta name="et-route">` that tells `app.js` which club, tool or
division to open (the address's query still wins). The page is the same app:
only the head and the `<noscript>` text differ.

    /obos-ligaen/          the second division's front page
    /klubb/<slug>/         one club, for every club in the current season
    /utforsk/<slug>/       one of the Explore tools
    /predict/              the prediction game

`sitemap.xml` is written from the same list. `SHORT_NAMES`, `club_slug` and
`EXPLORE` mirror `app.js` (`SHORT_NAMES`, `clubSlug`, `EXPLORE_SLUGS`); the
tests compare them.
"""

from __future__ import annotations

import html
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

SITE = "https://elitetracker.no"

# The names people use; app.js applies the same table to every payload.
SHORT_NAMES = {
    "Hamarkameratene": "HamKam",
    "Odds Ballklubb": "Odd",
    "Arendal Fotball": "Arendal",
    "Stjørdals Blink": "Blink",
    "FK Haugesund": "Haugesund",
    "Øygarden FK": "Øygarden",
}

# Explore item -> (path slug, i18n id): the Norwegian title and description come
# from i18n.js, so the page and the app say the same words.
EXPLORE = {
    "mountain": "sesongfjellet",
    "attack": "angrep-mot-forsvar",
    "luck": "flakstabellen",
    "referees": "dommere",
    "races": "kapplopene",
    "whatif": "hva-om",
    "runin": "restprogrammet",
    "playoff": "nedrykkskvalik",
}

LEAGUE_NAMES = {"eliteserien": "Eliteserien", "obosligaen": "OBOS-ligaen"}


def club_slug(name: str) -> str:
    """`Bodø/Glimt` -> `bodo-glimt`. The same steps as `clubSlug` in app.js."""
    text = name.lower().replace("æ", "ae").replace("ø", "o").replace("å", "a")
    text = unicodedata.normalize("NFD", text)
    text = "".join(char for char in text if not unicodedata.category(char).startswith("M"))
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def short_name(name: str) -> str:
    return SHORT_NAMES.get(name, name)


def norwegian_copy(i18n_source: str, key: str) -> str:
    """One Norwegian string out of i18n.js (its `no` table)."""
    table = i18n_source.split("\n  no: {", 1)[1]
    found = re.search(rf"'{re.escape(key)}':\s*'((?:[^'\\]|\\.)*)'", table)
    if not found:
        raise KeyError(key)
    text = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m[1], 16)), found[1])
    return text.replace("\\'", "'")


def _number(value: float, digits: int = 0) -> str:
    return f"{value:.{digits}f}"


def _replace_once(template: str, pattern: str, replacement: str, what: str) -> str:
    """Substitute the one place `pattern` matches; fail loudly if the template
    changed so far that it matches none (or several)."""
    result, count = re.subn(pattern, lambda _m: replacement, template, flags=re.DOTALL)
    if count != 1:
        raise ValueError(f"index.html: expected one {what}, found {count}")
    return result


def render_page(template: str, *, path: str, title: str, description: str, route: dict[str, str],
                heading: str, items: list[str] | None = None) -> str:
    """`template` (index.html) with one route's head and noscript text."""
    esc = html.escape
    page = _replace_once(template, r"<title>.*?</title>", f"<title>{esc(title)}</title>", "<title>")
    page = _replace_once(
        page, r'<meta name="description" content="[^"]*">',
        f'<meta name="description" content="{esc(description, quote=True)}">', "meta description")
    page = _replace_once(
        page, r'<meta property="og:title" content="[^"]*">',
        f'<meta property="og:title" content="{esc(title, quote=True)}">', "og:title")
    page = _replace_once(
        page, r'<meta property="og:description" content="[^"]*">',
        f'<meta property="og:description" content="{esc(description, quote=True)}">', "og:description")
    list_html = "<ol>" + "".join(f"<li>{esc(item)}</li>" for item in items) + "</ol>" if items else ""
    page = _replace_once(
        page, r"<noscript>.*?</noscript>",
        f'<noscript><div class="shell"><h1>{esc(heading)}</h1><p>{esc(description)}</p>{list_html}'
        "<p>Slå på JavaScript for å se rating, tabeller og kampodds.</p></div></noscript>", "<noscript>")
    head_extra = (
        f'<link rel="canonical" href="{SITE}{path}">\n'
        f'<meta property="og:url" content="{SITE}{path}">\n'
        f'<meta name="twitter:title" content="{esc(title, quote=True)}">\n'
        f'<meta name="twitter:description" content="{esc(description, quote=True)}">\n'
        f"<meta name=\"et-route\" content='{html.escape(json.dumps(route, ensure_ascii=False), quote=True)}'>\n"
    )
    return _replace_once(page, r"</head>", head_extra + "</head>", "</head>")


def _club_copy(row: dict[str, Any], body: dict[str, Any], league_name: str) -> tuple[str, str]:
    """Title and description for one club's page, in Norwegian."""
    season = body["league"]["season"]
    team = short_name(row["team"])
    elo = _number(row["rating"])
    played_out = not (body.get("model") or {}).get("matches_remaining")
    if played_out:
        title = f"{team} {season}: plass {row['position']}, Elo {elo} — EliteTracker"
        description = (f"{team} endte på {row['position']}. plass i {league_name} {season}. "
                       f"Elo-rating {elo}, kamper, odds og sesonghistorikk.")
        return title, description
    top = row["position_probabilities"][0]
    chance = _number(100 * top, 1)
    expected = _number(sum((i + 1) * p for i, p in enumerate(row["position_probabilities"])), 1)
    what = "gullsjanse" if body["league"]["slug"] == "eliteserien" else "sjanse for førsteplass"
    title = f"{team} {season}: {chance} % {what}, Elo {elo} — EliteTracker"
    description = (f"{team} i {league_name} {season}: {chance} % {what}, forventet sluttplass {expected} "
                   f"og Elo-rating {elo}. Kampodds, kamper og sesonghistorikk.")
    return title, description


def build_pages(site_dir: Path, data_dir: Path) -> list[str]:
    """Write the route pages and `sitemap.xml` into `site_dir`; returns the
    paths written. Needs `site_dir/index.html` and `data_dir/report.json` (the
    current season); with either missing, nothing is written."""
    template_path, report_path = site_dir / "index.html", data_dir / "report.json"
    if not (template_path.exists() and report_path.exists()):
        return []
    template = template_path.read_text(encoding="utf-8")
    i18n_source = (site_dir / "i18n.js").read_text(encoding="utf-8")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    written: list[str] = []

    def put(path: str, **page: Any) -> None:
        target = site_dir / path.strip("/") / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(render_page(template, path=path, **page), encoding="utf-8")
        written.append(path)

    season = report["eliteserien"]["league"]["season"]
    for slug, body in report.items():
        league_name = LEAGUE_NAMES.get(slug, body["league"]["name"])
        ordered = sorted(body["table"], key=lambda row: row["position"])
        if slug != "eliteserien":  # the first division is the front page, "/"
            title = f"{league_name} {season}: rating, odds og tabellprognose — EliteTracker"
            description = (f"ELO-rating og simulert sluttplassering for {league_name} {season}: "
                           "sjansen for opprykk og nedrykk, kampodds og alle sesonger siden 2015.")
            items = [f"{short_name(row['team'])} (Elo {_number(row['rating'])})" for row in ordered]
            put(f"/{club_slug(league_name)}/", title=title, description=description,
                route={"league": slug}, heading=f"{league_name} {season}", items=items)
        for row in ordered:
            team = short_name(row["team"])
            title, description = _club_copy(row, body, league_name)
            put(f"/klubb/{club_slug(team)}/", title=title, description=description,
                route={"league": slug, "view": "team", "team": team}, heading=f"{team} {season}")
    first = report["eliteserien"]
    for item, slug in EXPLORE.items():
        name = norwegian_copy(i18n_source, f"explore.{item}.title")
        description = norwegian_copy(i18n_source, f"explore.{item}.desc")
        put(f"/utforsk/{slug}/", title=f"{name} — {first['league']['name']} {season} — EliteTracker",
            description=description, route={"view": "explore", "viz": item}, heading=name)

    # The prediction game is a view of the app like the rest (app.js loads its code when it opens).
    put("/predict/", title=f"Predict: tipp kampene i Eliteserien og OBOS-ligaen {season} — EliteTracker",
        description=norwegian_copy(i18n_source, "predict.tagline"), route={"view": "predict"}, heading="Predict")

    urls = [f"{SITE}/"] + [f"{SITE}{path}" for path in written] + [f"{SITE}/model.html"]
    sitemap = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{html.escape(url)}</loc></url>\n" for url in urls)
        + "</urlset>\n"
    )
    (site_dir / "sitemap.xml").write_text(sitemap, encoding="utf-8")
    return written
