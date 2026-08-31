"""Display-only modules, excluded from the simulation signature.

See `fixtures.py`. Nothing in this package feeds the Monte Carlo, so editing
it must not invalidate cached past-season reports.
"""

from elitetracker.display.fixtures import build_fixtures_payload, top_scorelines

__all__ = ["build_fixtures_payload", "top_scorelines"]
