# Docs

Where to look, by question. Each file is a lookup page: short sections, the
module or command that owns each fact, and links instead of copies.

| Question | File |
|---|---|
| How do the pieces fit together? Where does a number come from? | [architecture.md](architecture.md) |
| How is a match priced, a rating moved, a season simulated? How do I test a model change? | [model.md](model.md) |
| What is in `data/`, where does it come from, what may be scraped, what needs doing once a year? | [data.md](data.md) |
| How do I run, build, deploy or republish? What does CI do? | [operations.md](operations.md) |
| How is `public/` organised? How are the browser's ports of the model tested? | [frontend.md](frontend.md) |
| Which tracker, labels and domain docs do the agent skills use? | [agents/](agents/) |
| What UI and view ideas are queued for later (and where do they come from)? | [ui-ideas.md](ui-ideas.md) |

Elsewhere in the repo:

- `README.md`: what the site shows, for a reader of the site.
- `AGENTS.md`: the hard rules (dependencies, model versioning, decimal point,
  the decision log) and how an agent should work here.
- `PROJECT_STATUS.md`: the version table ("Model versions") and every model
  idea ever tested, shipped or rejected, with its numbers. Read it before
  proposing a model change.
- `HANDOFF.md`: the open Explore branches and other loose ends.
- `DESIGN_PLAN.md`: the design ideas being tested one by one (from
  2026-10-23), each kept or dropped.

The October 2026 plans (`IMPROVEMENTS.md`, `IMPROVEMENTS2.md`), their
questions (`QUESTIONS.md`) and the September UI audit (`ux-audit.md`) were
retired on 2026-10-18; their results are in `PROJECT_STATUS.md` under the same
names, and the files themselves in git history (`git log --all -- IMPROVEMENTS.md`).
