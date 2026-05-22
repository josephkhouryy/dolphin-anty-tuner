# bootstrap.ps1 — one-shot installer for the Dolphin Anty tuner on a fresh Windows machine.
#
# Run inside an Administrator PowerShell on the EC2 Windows instance:
#   iwr https://raw.githubusercontent.com/josephkhouryy/dolphin-anty-tuner/main/bootstrap.ps1 -UseBasicParsing | iex
#
# After this script finishes you still need to:
#   1. Drop a .env file at $env:USERPROFILE\dolphin-anty-tuner\.env  (secrets — done outside this script)
#   2. node smoke.js       # confirm Dolphin + IPRoyal both reachable from this VM
#   3. node tune.js        # start the iterative loop
#
# Idempotent — safe to re-run.

$ErrorActionPreference = 'Stop'
$workdir = Join-Path $env:USERPROFILE 'dolphin-anty-tuner'

function Ensure-Tool {
  param([string]$Name, [string]$WingetId, [string[]]$ExtraPaths = @())
  if (Get-Command $Name -ErrorAction SilentlyContinue) {
    Write-Host "[ok] $Name already installed."
    return
  }
  Write-Host "[install] $Name via winget..."
  winget install --id $WingetId -e --silent --accept-source-agreements --accept-package-agreements
  foreach ($p in $ExtraPaths) {
    if (Test-Path $p) { $env:Path = "$p;" + $env:Path }
  }
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Installed $Name but it's still not on PATH. You may need to open a new PowerShell."
  }
}

Write-Host '== Dolphin Anty tuner bootstrap =='
Write-Host "Workdir: $workdir"
Write-Host ''

Ensure-Tool -Name git  -WingetId 'Git.Git'          -ExtraPaths @('C:\Program Files\Git\bin', 'C:\Program Files\Git\cmd')
Ensure-Tool -Name node -WingetId 'OpenJS.NodeJS.LTS' -ExtraPaths @('C:\Program Files\nodejs')

if (Test-Path $workdir) {
  Write-Host "[git] Pulling latest..."
  Push-Location $workdir
  git pull --ff-only
  Pop-Location
} else {
  Write-Host "[git] Cloning..."
  git clone --depth 1 https://github.com/josephkhouryy/dolphin-anty-tuner.git $workdir
}

Push-Location $workdir
Write-Host '[npm] Installing dependencies...'
npm install --silent

Write-Host '[playwright] Installing Chromium...'
npx --yes playwright install chromium

Write-Host ''
Write-Host '== Bootstrap complete =='
Write-Host ''
Write-Host 'Next:'
Write-Host "  1. Create $workdir\.env  (paste secrets — handled separately)"
Write-Host '  2. node smoke.js'
Write-Host '  3. node tune.js'
Write-Host ''
Pop-Location
