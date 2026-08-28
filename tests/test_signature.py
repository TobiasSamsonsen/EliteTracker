"""The deploy cache key: when are past-season reports still valid?"""

import json
from pathlib import Path

from elitetracker.pipeline import (
    _source_paths,
    current_data_signature,
    current_season,
    simulation_signature,
)


def _write(root: Path, slug: str, season: int, content: str) -> None:
    (root / f"{slug}_{season}_matches.json").write_text(content, encoding="utf-8")


def _norm_dir(tmp_path: Path) -> Path:
    root = tmp_path / "data" / "normalized"
    root.mkdir(parents=True)
    for season in (2025, 2026):
        for slug in ("eliteserien", "obosligaen"):
            _write(root, slug, season, json.dumps([{"season": season}]))
    return root


def test_signatures_are_deterministic(tmp_path: Path):
    root = _norm_dir(tmp_path)
    assert simulation_signature(root) == simulation_signature(root)
    assert len(simulation_signature(root)) == 64
    assert current_data_signature(root) == current_data_signature(root)


def test_current_season_is_the_latest(tmp_path: Path):
    root = _norm_dir(tmp_path)
    assert current_season(root) == 2026


def test_current_data_change_does_not_bust_model_cache(tmp_path: Path):
    """A results refresh only touches the current season, so past reports stay valid."""
    root = _norm_dir(tmp_path)
    model_before = simulation_signature(root)
    data_before = current_data_signature(root)

    # New result arrives in the current (2026) season only.
    _write(root, "eliteserien", 2026, json.dumps([{"season": 2026, "goals": 3}]))

    assert current_data_signature(root) != data_before
    assert simulation_signature(root) == model_before


def test_past_data_change_busts_model_cache(tmp_path: Path):
    """Backfilling a past season must force a full rebuild."""
    root = _norm_dir(tmp_path)
    model_before = simulation_signature(root)

    _write(root, "eliteserien", 2025, json.dumps([{"season": 2025, "goals": 9}]))

    assert simulation_signature(root) != model_before


def test_scoreline_model_change_busts_model_cache(tmp_path: Path):
    root = _norm_dir(tmp_path)
    model_before = simulation_signature(root)

    # Put a (different) scoreline model next to the normalized dir so the
    # signature picks it up.
    (root.parent / "scoreline_model.json").write_text("changed", encoding="utf-8")

    assert simulation_signature(root) != model_before


def test_display_package_is_excluded_from_the_signature(tmp_path: Path):
    """Display code never feeds the simulation, so editing it must not
    invalidate cached past-season reports."""
    root = _norm_dir(tmp_path)
    src_root = Path(__file__).resolve().parents[1] / "src" / "elitetracker"
    sources = _source_paths(src_root)
    assert not any("display" in path.parts for path in sources)


def test_display_change_does_not_bust_model_cache(tmp_path: Path):
    root = _norm_dir(tmp_path)
    model_before = simulation_signature(root)

    # Edit the display package: it is hashed nowhere, so the signature holds.
    display_dir = Path(__file__).resolve().parents[1] / "src" / "elitetracker" / "display"
    fixtures = display_dir / "fixtures.py"
    original = fixtures.read_text(encoding="utf-8")
    try:
        fixtures.write_text(original + "\n# display-only edit\n", encoding="utf-8")
        assert simulation_signature(root) == model_before
    finally:
        fixtures.write_text(original, encoding="utf-8")
