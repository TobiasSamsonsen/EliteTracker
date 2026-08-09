# AGENTS.md

## Project Overview

This project is a Python-based website for predicting and ranking teams in the top two divisions of Norwegian men's football:

* Eliteserien
* OBOS-ligaen

The initial version uses a traditional ELO rating system to estimate team strength and match probabilities. It will later be extended into a more sophisticated football prediction model incorporating additional statistics.

## Core Constraints

- Focus exclusively on the **2026 season**
- Use only the previous season's final standings for initial ELO ratings
- Avoid historical data pipelines unless explicitly requested
- Do not implement advanced prediction models yet
- Use ELO-based predictions for now

## Architectural Boundaries

Key separation points:
```text
Data Sources -> Data Acquisition/Caching -> Normalized Football Data -> ELO Model/Statistics -> Prediction Model -> Season Simulator -> Backend API -> Frontend
```

## Python Backend Rules

- Use type hints where clarity improves
- Keep functions small and focused
- Avoid clever code; use descriptive names
- Add comments for non-obvious logic (ELO calculations, simulations, data normalization)

## Data Validation

Always validate:
* Team names
* Match dates/status
* Scores
* Duplicate matches
* API response formats

Handle edge cases: postponed matches, missing data, unusual team names.

## ELO System Details

- Target rating range: 1700 (best) to 1300 (worst)
- Use deterministic method for initial ratings
- Separate expected result calculation, actual results, and rating updates
- Home-field advantage and K-factor must be configurable

## Simulation Requirements

- Use Monte Carlo with configurable simulation count
- Operate on local data only during simulations
- Support reproducible runs with fixed random seeds

## Testing

Required tests:
* ELO initialization
* Expected result calculations
* Draw probability logic
* Home advantage handling
* Standings calculations
* Simulation logic
* Data normalization

Include edge cases: draws, equal ELO ratings, missing data, promoted/relegated teams.

## API Efficiency

- Cache local data aggressively
- Avoid repeated API requests
- Use caching pipelines: request -> validate -> store -> use cached data

## Dependencies

- Prefer Python standard library where possible
- Manage dependency versions once reproducible
- Avoid adding frameworks solely for convenience

## Development Workflow

Follow this order:
1. Project structure
2. Data source integration
3. Data normalization
4. Local caching
5. Team/league data handling    
6. Initial ELO implementation
7. Match update logic
8. Match probability calculations
9. Season simulation
10. Position probability matrix
11. Backend API development
12. Frontend implementation
13. Integration testing

## Git & Changes

- Keep changes focused
- Do not overwrite working functionality
- Preserve backwards compatibility when possible
- Never delete files without understanding purpose

## Model Versioning

Use clear versioning:
```text
elo-v1
model-v2
```

Changes impacting predictions must increment model version.

## Definition of Done

Initial version is complete when:
1. 2026 data is reliably obtained
2. Data caching avoids unnecessary API calls
3. Both divisions are represented correctly
4. Teams have reproducible starting ELO ratings
5. ELO updates after completed matches
6. Upcoming matches have W/D/L probabilities
7. Simulations run without external API calls
8. Finishing-position probabilities are accurately calculated
9. Probability matrix is exposed via backend
10. Frontend displays rankings and probabilities
11. Core calculations have automated tests
12. System can accept future models without full rewrite