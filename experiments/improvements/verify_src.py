"""The shipped src (elo-v13.0) against the harness bundle built from hooks on
an elo-v12.2-equivalent base: they must agree to the bit."""
import math, sys
from dataclasses import replace
import numpy as np
sys.path.insert(0, "experiments/improvements")
from harness import IDS, INDEX, PLAYED, SEEDS, SHOTS, SLICES, ADConfig, EloRun, ad_run, blend, elo_run  # noqa: E402
from context_terms import COUNT, ad_target  # noqa: E402
from elo_update import implied_exact, score_with  # noqa: E402
from elitetracker.model.attack_defence import AttackDefence, blend_outcomes  # noqa: E402
from elitetracker.model.backtest import walk_forward  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402
from elitetracker.model.elo import EloConfig  # noqa: E402
from elitetracker.model.probabilities import MatchProbabilities  # noqa: E402
from elitetracker.pipeline import market_values  # noqa: E402

hook_elo = elo_run(EloRun(score=score_with(implied=implied_exact, margin="B", gamma=0.10, c=0.25)))
off = replace(ADConfig(), value_pull=0.0, early_boost=0.0)
hook_ad = ad_run(config=off, values={}, season_hook=ad_target(0.2, "prev"),
                 k_hook=lambda ad, t, m: 1.0 + 0.5 * math.exp(-COUNT[(t, m.date)] / 3.0))
hook_mix = blend(hook_elo, hook_ad.probs)

card = walk_forward(SLICES, SEEDS, EloConfig(), score_from_season=2015, shots=SHOTS)
src_elo = np.array([[card.predictions[m].__getitem__(0).home_win, card.predictions[m][0].draw, card.predictions[m][0].away_win] for m in IDS])
ad = AttackDefence.from_slices(SLICES, ADConfig(), shots=SHOTS, values=market_values())
src_mix = np.zeros_like(src_elo)
for i, (m, _, _) in enumerate(PLAYED):
    h, a = team_ids(m)
    p = blend_outcomes(MatchProbabilities(*src_elo[i]), ad.grid(h, a, m.date))
    src_mix[i] = (p.home_win, p.draw, p.away_win)
    ad.observe(m)
print(f"elo max diff {abs(src_elo - hook_elo).max():.2e}; blend max diff {abs(src_mix - hook_mix).max():.2e}")
