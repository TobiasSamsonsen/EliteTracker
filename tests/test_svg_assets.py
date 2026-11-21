"""Every SVG the site serves as a file is well-formed XML.

A browser drops an SVG image (a favicon included) that is not, without a word:
`icons/mark.svg` once had `--` inside a comment and the site showed no
favicon. Inline SVG in HTML is parsed leniently, so only the files need this.
"""

from pathlib import Path
from xml.dom import minidom

import pytest

PUBLIC = Path(__file__).resolve().parent.parent / "public"
SVGS = sorted(path for path in PUBLIC.rglob("*.svg") if "vendor" not in path.parts)


@pytest.mark.parametrize("path", SVGS, ids=lambda path: str(path.relative_to(PUBLIC)))
def test_svg_is_well_formed(path):
    minidom.parse(str(path))


def test_pages_link_the_favicon():
    for name in ("index.html", "404.html", "model.html", "personvern.html"):
        assert '<link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">' in (PUBLIC / name).read_text(encoding="utf-8"), name
