"""Write data/red_cards.json, the red cards the model reads (elo-v19.0), from
the local card files: data/raw/fotmob_match_extras.json (Eliteserien
2020-2026, oriented by its shots) and data/raw/fotmob_match_cards.json
(fetch_red_cards.py: Eliteserien 2015-2019 and late 2026, OBOS-ligaen
2015-2026), as red_cards_data.py reads them. A one-off, November 2026; the
hourly refresh keeps the file up to date for new Eliteserien matches from the
match details it already fetches (`sources.fotmob.update_xg`).

    .venv/Scripts/python experiments/improvements/build_red_cards.py
"""
import sys
sys.path.insert(0, "experiments/improvements")
from red_cards_data import RED  # noqa: E402
from elitetracker.sources.fotmob import RED_CARDS_PATH, load_red_cards, save_red_cards  # noqa: E402

if __name__ == "__main__":
    out = {mid: [[minute, 0 if home else 1] for minute, home in reds] for mid, reds in RED.items() if reds}
    before = load_red_cards(RED_CARDS_PATH)
    kept = {mid: reds for mid, reds in before.items() if mid not in out and mid not in RED}
    save_red_cards({**kept, **out}, RED_CARDS_PATH)
    print(f"{len(out)} matches with a red card from {len(RED)} with card data; {len(kept)} kept from the file")
