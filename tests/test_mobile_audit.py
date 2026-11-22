"""The mobile-first check, as a test: every view at 360x800 and 375x812.

Drives the built site in headless Chromium (experiments/mobile-audit/check.py)
and asserts, per view: no sideways page overflow, no overlapping masthead
parts or fixed bottom bars, touch targets of 44px (24px inside dense data)
and no console errors. It takes a minute or two and needs Playwright's
Chromium and a built public/data, so it runs only when asked:

    ELITETRACKER_MOBILE_AUDIT=1 .venv/Scripts/python -m pytest -q tests/test_mobile_audit.py
"""

import importlib.util
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CHECK = ROOT / "experiments" / "mobile-audit" / "check.py"

pytestmark = pytest.mark.skipif(
    not os.environ.get("ELITETRACKER_MOBILE_AUDIT"),
    reason="slow browser check; set ELITETRACKER_MOBILE_AUDIT=1 to run it",
)


def _check_module():
    spec = importlib.util.spec_from_file_location("mobile_check", CHECK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_view_is_mobile_clean():
    pytest.importorskip("playwright")
    if not (ROOT / "public" / "data" / "report.json").exists():
        pytest.skip("public/data is not built")
    check = _check_module()
    findings = check.run({"360x800", "375x812"}, check.VIEWS, shots=None, consent=False)
    # A dropped local connection (Windows' ERR_NO_BUFFER_SPACE under load) is
    # the test server's, not the page's.
    findings = [
        f for f in findings
        if not (f["check"] == "console" and all("ERR_NO_BUFFER_SPACE" in line for line in f["detail"]))
    ]
    assert not findings, "\n".join(f"[{f['viewport']}] {f['view']}: {f['check']}: {f['detail']}" for f in findings)
