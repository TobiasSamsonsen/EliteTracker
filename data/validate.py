import json
from datetime import datetime

with open("data/raw/matches_sorted.json", "r") as f:
    matches = json.load(f)

# Verify date format preservation
for match in matches:
    assert isinstance(match["date"], str), "Date should be a string (e.g., '09.08.26')"
    assert len(match["date"].split(".")) == 3, "Date format should be DD.MM.YY"

# Verify time field integrity
for match in matches:
    assert match["time"] is not None, "Time field should not be null"

# Verify match_id format
for match in matches:
    assert isinstance(match["match_id"], str), "match_id should be a string"

# Verify chronological order
for i in range(1, len(matches)):
    assert matches[i]["date"] >= matches[i-1]["date"], "Matches are not sorted chronologically"