# Questions from the IMPROVEMENTS.md pass (October 2026)

**Answered 2026-10-16; the answers and what is left are in `HANDOFF.md`.**

Things that need your call. Everything else in IMPROVEMENTS.md was done
without asking; the numbers are in `PROJECT_STATUS.md`, "elo-v13.0". Each
question says what I did in the meantime, so nothing waits on the answer.

## 1. Squad market values in the model: keep them?

**Shipped by default.** The goals model's offseason pull now aims at the
division average shifted by each club's Transfermarkt squad value from the
season before (`ADConfig.value_pull` 0.2). Out of sample it is worth -0.00127
log loss (t -2.84, Brier and RPS too, both halves), almost all of it in
OBOS-ligaen seasons without xG; in Eliteserien and the xG era it is about
zero. The same pull on the Elo ratings added nothing, so the displayed
ratings do not use market values.

What it costs: `data/market_values.json` needs the new season's two pages
(Eliteserien, OBOS-ligaen) once a year. With a season missing the pull simply
switches off for the next season; nothing breaks. There is no fetch command for
it in `src` (the file was put together by hand in September).

- Keep it, and should I write an opt-in, throttled
  `research market-values --season YYYY` (two requests a season, abort on
  403/429, per the scraping rules)?
- Or drop it (`value_pull = 0.0`, a version bump, and the match-odds gain falls
  to about -0.0005)?

AGENTS.md still lists "squad value priors" as a rejected model not to retry. I
left that line alone; it now contradicts the code. Say how you want it worded.

## 2. AGENTS.md's "do not re-attempt rejected models" rule

You told me to re-test old rejections, and several came back different on
today's model (the value prior; the old xG margin turned out to be a sign bug).
I saved that as a working rule for myself, but AGENTS.md still tells every
agent the opposite. Change it to something like "re-test old rejections
against the current model; the log is the baseline, not a veto"?

## 3. Contact form (IMPROVEMENTS 3.4)

Not built: it needs an account on your side. Options for a static Firebase
site:

- **A form service** (Formspree, Web3Forms, Getform): a plain HTML form posting
  to their endpoint, a honeypot field against bots, the address never in the
  page. Free tiers are enough. I need the endpoint (or which service, and I
  write it ready for you to paste the key in).
- **A Firebase function** that sends mail: needs the Blaze plan and a mail
  provider (SendGrid or similar).
- **No form**: a "Contact" link that builds the mailto address in JavaScript on
  click, so crawlers reading the HTML never see it. No account, but scrapers
  that run JS can still find it.

Which one, and which address should mail go to?

## 4. Play-off ("kvalik") chances (IMPROVEMENTS 3.2)

Checked: the table's play-off band is only the chance of finishing 3rd-6th
(OBOS) or 14th (Eliteserien); nobody's chance of going up or staying up
*through* the play-off is simulated. It can be: each run already has a final
table, so playing 5th v 6th, the winner at 4th, then at 3rd (single matches,
home side the higher seed, a draw settled 50/50 or with a small home edge) is
cheap. The final against Eliteserien's 14th is the awkward part, because the
two divisions are simulated in separate reports; options are simulating
Eliteserien inside the OBOS report too (about +1 s a view) or using the
Eliteserien report's chances of 14th as a fixed opponent mix.

- Do you want it, and where: a line in the team view's Outlook ("Promoted via
  the play-off: 9 %") only, or also a key figure under Explore? Not a new table
  column, as IMPROVEMENTS.md suggests.

## 5. Re-publishing past seasons

elo-v13.0 changes every report of every season (new ratings, odds and season
odds). The live season rebuilds on the next deploy, but 2015-2025 on the site
come from the past-seasons release asset. Once this is merged, rerun
`gh workflow run past-seasons.yml` (it also brings the pre-season views and
`results[].xg` to the old seasons, which the new scorecard and luck table
use)? I have not triggered any workflow, pushed or committed.

## 6. Pitch surface (IMPROVEMENTS 1.10): pursue or close?

Rejected for now, but not dead: a home side on its own surface against a
visitor used to the other one does better than the model expects in-sample
(t -2.3), in both directions (turf v grass and grass v turf), but the gain sits
in 2016-2020 and is -0.00024 out of sample (t -0.55). Eliteserien alone, where
the surface table is surest, is -0.00093 (t -1.53). The table I used
(`experiments/improvements/surface.py`) comes from Wikipedia's list of
Eliteserien venues; the second-tier grounds marked `(?)` there (Hødd, Moss,
Raufoss, Sandnes Ulf, Lyn) are guesses from old rows. If you know the surfaces
better, correct the table and I will re-run it; otherwise it stays closed.

## 7. More Explore views

Built: the prediction scorecard (#1), the luck table (#3), the run-in heatmap
(#4) and match-odds calibration (#10). Of the rest of the list in
PROJECT_STATUS.md (race lines, "Heisen", rating river, head-to-head matrix,
scorelines, stakes calendar), which do you want next?

## 8. The restored decision log

`PROJECT_STATUS.md` lost its first 1,479 lines (elo-v2 through elo-v12.0, the
whole decision log) in commit 1c0ace5 ("High-stakes matches"), which looks
accidental. I put them back from the commit before it and fixed the `±`/`≥`
that had turned into `�`. Shout if the cut was deliberate.
