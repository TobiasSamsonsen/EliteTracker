# AGENTS.md

Norwegian men's football rating & prediction system (Eliteserien & OBOS-ligaen).
Core model: Elo + xG attack/defence Poisson grid (version in `MODEL_VERSION`, `model/elo.py`).

---

## 1. Hard Constraints & Invariants

- **Dependencies Need a Case**: Third-party dependencies (Python or frontend) are allowed, but each one needs a stated justification when it is proposed or added: what it is for, why the standard library or plain JS is not enough, and what it costs (install, size, CI, upkeep). Record the case where the dependency is declared (`pyproject.toml` comment, or a note next to vendored files). Current ones: `numpy` (vectorised season simulation), `curl-cffi` (Sofascore), `tzdata` (Windows only), and three.js vendored for the season mountain.
- **Model Versioning**: Any change affecting prediction or simulation output MUST bump `MODEL_VERSION` in `model/elo.py`.
- **Design Philosophy**: Keep diffs focused; do not add speculative abstractions or unrequested refactors.
- **Historical Decision Log**: Do not re-attempt rejected statistical models (ordered-logit, Dixon-Coles standalone, squad value priors). Check `PROJECT_STATUS.md` before proposing model changes.

---

## 2. Repository Layout (On-Demand Inspection)

- `sources/`: Data scraping & ingestion (`fotmob.py`, `sofascore.py`, `refresh.py`)
- `normalize/` & `validation/`: Raw-to-canonical `Match` schemas and validation guards
- `model/`: Rating calculations (`elo.py`, `attack_defence.py`, `career.py`, `probabilities.py`)
- `simulation/`: Monte Carlo season outcomes (`season.py`, `history.py`)
- `pipeline.py`: Central data builder connecting models to JSON report payloads
- `api/server.py` & `build_site.py`: Live HTTP server and static JSON site generator
- `public/`: Dependency-free vanilla JS/HTML frontend (`app.js`, `i18n.js`)

---

## 3. Pi Operational & Tool Directives

- **Turn Budget (Target <= 2 Turns)**: Every tool step consumes an API request. Collapse workflows into a strict 2-turn cycle:
  - *Turn 1*: Gather all required context, inspect error lines, and locate target logic.
  - *Turn 2*: Emit all edits, run tests, and report results.
- **Batch Tool Invocations**: Never inspect or edit files incrementally across turns. Emit multiple parallel `read` or `edit` calls in a single turn.
- **Compound Shell Exploration**: Chain search and inspection into a single compound `bash` call rather than splitting search and reading across multiple requests (e.g., `rg -n 'def replay' model/ && sed -n '15,45p' model/career.py`).
- **Immediate Tool Execution**: Never spend a request on conversational preamble, planning summaries, or confirmations. Call tools immediately.
- **Surgical Edits**: Default to `edit`. Use `write` only when creating new files. Anchor search blocks with 2 - 3 unique lines. Match local indentation exactly.
- **Quiet Execution**: Always filter shell commands to conserve tokens:
  - Run tests cleanly: `python -m pytest -q` from the repo root, with the venv's Python (`.venv/Scripts/python` on Windows, `.venv/bin/python` elsewhere); bare `pytest` cannot import the `tests` package
  - Truncate large outputs: pipe through `head -n 30` or `tail -n 30`.
- **Concise Responses**: State the issue, make the edit, report the test output, and halt. Do not summarize unchanged code.

---

## 4. Verification

Run the test suite after any modification to ensure zero regressions:
```bash
python -m pytest -q && node --test tests/frontend.test.js