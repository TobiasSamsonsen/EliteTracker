import os
from dotenv import load_dotenv

load_dotenv(".env")
import requests
import json

API_URL = 'https://api.parse.bot/scraper/508d9362-e3bc-43eb-af18-3c64cac04372/get_tournament_matches'
API_KEY = os.getenv('API_KEY')

if not API_KEY:
    print('Error: PARSE_API_KEY environment variable not set')
    exit(1)

params = {'tournament': 'eliteserien'}
headers = {'X-API-Key': API_KEY}

try:
    response = requests.get(API_URL, headers=headers, params=params)
    response.raise_for_status()
    data = response.json()

    output_file = 'data/raw/eliteserien_2026_matches.json'

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(data['data']['matches'], f, indent=2)

    print(f'Successfully saved Eliteserien matches to {output_file}')
except Exception as e:
    print(f'Error: {str(e)}')