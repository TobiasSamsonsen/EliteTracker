## ✅ What Has Been Done
- [x] Fetched and validated the raw match data from `data/raw/eliteserien_2026_matches.json`.
- [x] Created and executed the sorting script (`data/normalize/sort_matches.py`) to generate `matches_sorted.json`.
- [x] Verified the sorted data is correctly formatted with readable JSON and proper chronological order.
- [x] Addressed date parsing issues and ensured matches are sorted by `date` → `time` → `match_id`.

## ❗ What Has Not Been Done
- [ ] Validated the sorted file to ensure it reflects the correct chronological order.
- [ ] Counted the total number of matches in the sorted file to ensure no data loss.
- [ ] Implemented data validation checks for consistency (e.g., unique match IDs, valid scores, team names).

## 🔧 Next Steps
- [ ] Run data validation script to verify:
  - Correct chronological order (date → time → match_id)
  - Upcoming matches (`"-"` in `result`) grouped at the end
  - No duplicate matches or missing data
- [ ] Prepare for ELO implementation:
  - Load 2025 standings for initial ratings
  - Configure K-factor and home advantage parameters
  - Create deterministic ELO scaling (1700–1300 range)
- [ ] Plan and write unit tests for:
  - Data validation logic
  - ELO calculation formulas
  - Simulation reproducibility checks
- [ ] Begin work on the ELO model implementation in `models/elo/initial_ratings.py`