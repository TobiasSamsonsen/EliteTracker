import pandas as pd
from datetime import datetime

# Load raw match data
raw_data = pd.read_json('data/raw/eliteserien_2026_matches.json')

# Extract original date string and parse for sorting
raw_data['original_date'] = raw_data['date'].apply(
    lambda x: x.split()[-1] if isinstance(x, str) else pd.NaT
)

# Explicitly parse original_date with DD.MM.YY format
raw_data['date'] = pd.to_datetime(raw_data['original_date'], format='%d.%m.%y', errors='coerce')

import pandas as pd
from datetime import datetime

# Load raw match data
raw_data = pd.read_json('data/raw/eliteserien_2026_matches.json')

# Extract original date string and parse for sorting
raw_data['original_date'] = raw_data['date'].apply(
    lambda x: x.split()[-1] if isinstance(x, str) else pd.NaT
)
raw_data['date'] = pd.to_datetime(raw_data['original_date'], format='%d.%m.%y', errors='coerce')

# Process time field: fill invalid values and convert to string
raw_data['time'] = raw_data['time'].fillna('').astype(str).str.replace('-', '')

# Ensure match_id is treated as string
raw_data['match_id'] = raw_data['match_id'].astype(str)

# Sort by date, time (invalid times last), and match_id
sorted_data = raw_data.sort_values(by=['date', 'time', 'match_id'])

# Save sorted data (preserving original date format)
cleaned_data = sorted_data.dropna(subset=['original_date'])
cleaned_data.to_json('data/raw/matches_sorted.json', orient='records', indent=2)

# Save sorted data (preserving original date format)
cleaned_data = sorted_data.dropna(subset=['original_date'])
cleaned_data.to_json('data/raw/matches_sorted.json', orient='records', indent=2)