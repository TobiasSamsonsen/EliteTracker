"""The route pages: one entry page per club, tool and division, and the sitemap."""

import json
import re
from pathlib import Path

import pytest

from elitetracker import pages

ROOT = Path(__file__).resolve().parent.parent
APP = (ROOT / "public" / "app.js").read_text(encoding="utf-8")

TEMPLATE = """<!doctype html>
<html lang="nb">
<head>
<title>Generic</title>
<meta name="description" content="generic">
<meta property="og:title" content="generic">
<meta property="og:description" content="generic">
</head>
<body>
<noscript><p>generic</p></noscript>
</body>
</html>
"""


def test_slugs_match_the_browsers():
    # The same names are pinned in tests/frontend.test.js against clubSlug.
    assert pages.club_slug("Bodø/Glimt") == "bodo-glimt"
    assert pages.club_slug("Sarpsborg 08") == "sarpsborg-08"
    assert pages.club_slug("Ullensaker/Kisa") == "ullensaker-kisa"
    assert pages.club_slug("Strømsgodset") == "stromsgodset"
    assert pages.club_slug("Åsane") == "asane"
    assert pages.club_slug("Lillestrøm") == "lillestrom"
    assert pages.club_slug("Kvik Halden") == "kvik-halden"


def test_names_and_slugs_agree_with_app_js():
    short = re.search(r"const SHORT_NAMES = \{(.*?)\};", APP, re.DOTALL)[1]
    assert dict(re.findall(r"'([^']+)':\s*'([^']+)'", short)) == pages.SHORT_NAMES
    slugs = re.search(r"const EXPLORE_SLUGS = \{(.*?)\};", APP, re.DOTALL)[1]
    assert dict(re.findall(r"(\w+):\s*'([^']+)'", slugs)) == pages.EXPLORE


def test_every_tool_has_norwegian_copy_in_i18n():
    source = (ROOT / "public" / "i18n.js").read_text(encoding="utf-8")
    for item in pages.EXPLORE:
        assert pages.norwegian_copy(source, f"explore.{item}.title")
        assert pages.norwegian_copy(source, f"explore.{item}.desc")


def test_render_page_swaps_the_head_and_names_the_route():
    page = pages.render_page(
        TEMPLATE, path="/klubb/viking/", title='Viking "2026" — EliteTracker', description="Beskrivelse",
        route={"league": "eliteserien", "view": "team", "team": "Viking"}, heading="Viking 2026")
    assert "<title>Viking &quot;2026&quot; — EliteTracker</title>" in page
    assert '<link rel="canonical" href="https://elitetracker.no/klubb/viking/">' in page
    assert 'name="description" content="Beskrivelse"' in page
    assert "<noscript><div" in page and "generic" not in page
    route = re.search(r"name=\"et-route\" content='([^']*)'", page)[1]
    assert json.loads(route.replace("&quot;", '"')) == {"league": "eliteserien", "view": "team", "team": "Viking"}


def test_render_page_fails_loudly_when_the_template_loses_an_anchor():
    broken = TEMPLATE.replace('<meta property="og:title" content="generic">\n', "")
    with pytest.raises(ValueError, match="og:title"):
        pages.render_page(broken, path="/x/", title="t", description="d", route={}, heading="h")


def _table(rows, slug, name):
    return {"league": {"season": 2026, "slug": slug, "name": name}, "model": {"matches_remaining": 10},
            "table": rows}


def test_build_pages_writes_a_page_per_club_tool_and_division(tmp_path):
    site, data = tmp_path / "public", tmp_path / "public" / "data"
    data.mkdir(parents=True)
    (site / "index.html").write_text(TEMPLATE, encoding="utf-8")
    shutil_i18n = (ROOT / "public" / "i18n.js").read_text(encoding="utf-8")
    (site / "i18n.js").write_text(shutil_i18n, encoding="utf-8")
    row = lambda team, position, rating, probs: {"team": team, "position": position, "rating": rating, "position_probabilities": probs}  # noqa: E731
    (data / "report.json").write_text(json.dumps({
        "eliteserien": _table([row("Bodø/Glimt", 1, 1890.4, [0.575, 0.425]), row("Hamarkameratene", 2, 1700.0, [0.1, 0.9])],
                              "eliteserien", "Eliteserien"),
        "obosligaen": _table([row("Aalesund", 1, 1500.0, [0.3, 0.7])], "obosligaen", "OBOS-ligaen"),
    }), encoding="utf-8")

    written = pages.build_pages(site, data)

    assert "/obos-ligaen/" in written
    assert "/klubb/bodo-glimt/" in written and "/klubb/hamkam/" in written and "/klubb/aalesund/" in written
    assert "/utforsk/hva-om/" in written
    glimt = (site / "klubb" / "bodo-glimt" / "index.html").read_text(encoding="utf-8")
    assert "57.5 % gullsjanse, Elo 1890" in glimt
    assert '"team": "HamKam"' in (site / "klubb" / "hamkam" / "index.html").read_text(encoding="utf-8").replace("&quot;", '"')
    sitemap = (site / "sitemap.xml").read_text(encoding="utf-8")
    assert "<loc>https://elitetracker.no/klubb/hamkam/</loc>" in sitemap and "<loc>https://elitetracker.no/</loc>" in sitemap


def test_build_pages_does_nothing_without_a_template_or_a_report(tmp_path):
    assert pages.build_pages(tmp_path, tmp_path) == []
