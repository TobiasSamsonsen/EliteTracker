"""Season-odds check on variants of the new model (see season_check.py):

    season_variants.py elo_only      # elo-v13.0 Elo, goals model without value pull / early step
    season_variants.py no_value      # everything but the value pull
    season_variants.py sd=0.10       # full model, another strength shock
"""
import sys
from dataclasses import replace

sys.path.insert(0, "experiments/improvements")
import elitetracker.pipeline as pipeline  # noqa: E402
from elitetracker.model.attack_defence import ADConfig  # noqa: E402
import season_check  # noqa: E402

name = sys.argv[1]
if name == "elo_only":
    pipeline.ADConfig = lambda: replace(ADConfig(), value_pull=0.0, early_boost=0.0)
elif name == "no_value":
    pipeline.ADConfig = lambda: replace(ADConfig(), value_pull=0.0)
elif name == "no_early":
    pipeline.ADConfig = lambda: replace(ADConfig(), early_boost=0.0)
elif name.startswith("sd="):
    sd = float(name[3:])
    real = season_check.SimulationConfig
    season_check.SimulationConfig = lambda simulations: real(simulations=simulations, strength_sd=sd)
season_check.run(f"experiments/improvements/out/season_{name}.json")
