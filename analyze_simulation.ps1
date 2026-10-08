# Analyze elitetracker simulation code
$seasonPath = 'C:\Users\tobia\Documents\Programming\Elitetracker\src\elitetracker\simulation\season.py'
$content = Get-Content $seasonPath -Raw

Write-Host '=== SIMULATION ANALYSIS ===' -ForegroundColor Green
Write-Host ''

# Find the simulate_season function
defLine = ($content -split '\n') | Where-Object { $_ -match 'def simulate_season\(' } | Select-Object -First 1
Write-Host '1. ENTRY POINT:' -ForegroundColor Yellow
Write-Host "   Function: $defLine"
Write-Host '   Returns: SeasonProjection dataclass'
Write-Host ''

# Find default constants
$defaults = @()
($content -split '\n') | ForEach-Object {
    if ($_ -match 'DEFAULT_SIMULATIONS =') { $defaults += $_ }
    elseif ($_ -match 'DEFAULT_SEED =') { $defaults += $_ }
    elseif ($_ -match 'STRENGTH_SD =') { $defaults += $_ }
}
Write-Host '2. DEFAULT CONSTANTS:' -ForegroundColor Yellow
foreach ($def in $defaults) { Write-Host "   $def" }
Write-Host ''

# Find SeasonProjection class
$seasonProjectionLines = ($content -split '\n') | Where-Object { $_ -match 'class SeasonProjection:' } | Select-Object -First 1
Write-Host '3. RETURN VALUE (SeasonProjection):' -ForegroundColor Yellow
Write-Host "   Dataclass: $seasonProjectionLines"

# Find key aggregation code
$aggLines = ($content -split '\n') | Where-Object { $_ -match 'counts\[index\]\[position\] += 1' -or $_ -match 'position_probabilities' } | Select-Object -First 10
Write-Host '4. AGGREGATION CODE:' -ForegroundColor Yellow
Write-Host '   Key aggregation lines:'
foreach ($line in $aggLines) { Write-Host "     $line" }
Write-Host ''

# Find strength shock code
$shockLines = ($content -split '\n') | Where-Object { $_ -match 'boost = \[math\.exp' -or $_ -match 'strength_sd' } | Select-Object -First 5
Write-Host '5. STRENGTH SHOCK:' -ForegroundColor Yellow
Write-Host '   Draw location:'
foreach ($line in $shockLines) { Write-Host "     $line" }
Write-Host ''

# Find fixture selection
$fixtureLines = ($content -split '\n') | Where-Object { $_ -match 'if match\.played:' } | Select-Object -First 3
Write-Host '6. FIXTURE SELECTION:' -ForegroundColor Yellow
Write-Host '   Filter for unplayed matches:'
foreach ($line in $fixtureLines) { Write-Host "     $line" }
Write-Host ''

# Search for importance metrics
$terms = @('pivotal', 'swing', 'importance', 'clinch', 'decisive', 'decider')
$foundMetrics = $false
foreach ($term in $terms) {
    if ($content -match "\b$term\b") { Write-Host "7. METRICS FOUND: $term" ; $foundMetrics = $true }
}
if (-not $foundMetrics) { Write-Host '7. METRICS NOT FOUND: No per-match importance metrics in codebase' }
