# ec2-bootstrap.ps1 — one-shot installer to migrate the full chain onto Windows EC2.
#
# Run inside an Administrator PowerShell on the EC2 instance:
#
#   iwr https://raw.githubusercontent.com/josephkhouryy/dolphin-anty-tuner/main/ec2-bootstrap.ps1 -UseBasicParsing | iex
#
# What this does:
#   1. Prompts you for each credential (NEVER embedded in this script — that
#      was the security incident on 2026-05-24 that this version fixes).
#   2. Clones good-ip-finder, hotmail-multi-creator, twilio-multi-account-creator.
#   3. Runs `npm install` in each.
#   4. Writes .env files using the credentials you just typed.
#   5. Creates PowerShell loop scripts in %USERPROFILE%\chain-loops\.
#   6. Prints the launch commands.
#
# Idempotent — safe to re-run. Existing clones get `git pull`. Existing .env
# files get backed up to .env.bak before being overwritten.
#
# Assumes the existing `dolphin-anty-tuner` bootstrap already ran on this VM
# (Node, git, Dolphin Anty installed). If not, run that one first:
#   iwr https://raw.githubusercontent.com/josephkhouryy/dolphin-anty-tuner/main/bootstrap.ps1 -UseBasicParsing | iex

$ErrorActionPreference = 'Stop'

Write-Host "================================================" -ForegroundColor Cyan
Write-Host " EC2 full-chain bootstrap" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "You will be prompted for 5 credentials. Paste each from your IPRoyal /" -ForegroundColor Yellow
Write-Host "Dolphin Anty / AbuseIPDB dashboards. Nothing is logged or transmitted —" -ForegroundColor Yellow
Write-Host "values stay on this VM in the .env files this script writes." -ForegroundColor Yellow
Write-Host ""

function Read-Secret {
  param([string]$Prompt)
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr   = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$IPROYAL_USERNAME      = Read-Host  -Prompt "IPRoyal proxy username (Mobile or Residential — from your iproyal.com dashboard)"
$IPROYAL_BASE_PASSWORD = Read-Secret -Prompt "IPRoyal proxy password (the BASE — without _country/_session/_lifetime suffixes)"
$DOLPHIN_API_TOKEN     = Read-Secret -Prompt "Dolphin Anty API token (long JWT from Settings -> API)"
$ABUSEIPDB_API_KEY     = Read-Secret -Prompt "AbuseIPDB API key (from https://www.abuseipdb.com/account/api)"
$IPROYAL_COUNTRY       = Read-Host  -Prompt "Default IPRoyal country code (lowercase, e.g. us, gb, ca) — press Enter for 'us'"
if ([string]::IsNullOrWhiteSpace($IPROYAL_COUNTRY)) { $IPROYAL_COUNTRY = 'us' }

# Static config — not secret, safe to embed.
$IPROYAL_HOST       = 'geo.iproyal.com'
$IPROYAL_PORT       = '12321'
$IPROYAL_LIFETIME   = '24h'
$IPROYAL_STREAMING  = ''
$IPROYAL_COUNTRIES  = 'us,gb,ca,de,fr,nl,au,it,es'
$POOL_TARGET        = '3'
$POOL_STALE_MIN     = '60'
$DOLPHIN_LOCAL_API  = 'http://localhost:3001'
$DOLPHIN_CLOUD_API  = 'https://anty-api.com'

$root = $env:USERPROFILE
Write-Host ""
Write-Host "[bootstrap] Working in $root" -ForegroundColor Cyan

# ───── 1. Clone the three repos ─────
function Clone-Repo {
  param([string]$RepoSlug, [string]$DirName)
  $target = Join-Path $root $DirName
  if (Test-Path $target) {
    Write-Host "[git] $DirName already cloned — pulling latest." -ForegroundColor Yellow
    Push-Location $target
    git pull --ff-only
    Pop-Location
  } else {
    Write-Host "[git] cloning $RepoSlug -> $DirName" -ForegroundColor Green
    git clone "https://github.com/$RepoSlug.git" $target
  }
}
Clone-Repo 'josephkhouryy/good-ip-finder'                'good-ip-finder'
Clone-Repo 'josephkhouryy/hotmail-multi-creator'         'hotmail-multi-creator'
Clone-Repo 'josephkhouryy/twilio-multi-account-creator'  'twilio-multi-account-creator'

# ───── 2. npm install in each ─────
foreach ($d in @('good-ip-finder', 'hotmail-multi-creator', 'twilio-multi-account-creator')) {
  Write-Host "[npm] installing deps in $d" -ForegroundColor Green
  Push-Location (Join-Path $root $d)
  npm install --no-audit --no-fund --loglevel=error
  Pop-Location
}

# ───── 3. Write .env files ─────
function Write-Env {
  param([string]$DirName, [string]$Body)
  $envFile = Join-Path $root "$DirName\.env"
  if (Test-Path $envFile) {
    Copy-Item $envFile "$envFile.bak" -Force
    Write-Host "[env] backed up old $DirName\.env to .env.bak" -ForegroundColor Yellow
  }
  $Body | Out-File -FilePath $envFile -Encoding ASCII -NoNewline
  Write-Host "[env] wrote fresh $DirName\.env" -ForegroundColor Green
}

Write-Env 'good-ip-finder' @"
IPROYAL_USERNAME=$IPROYAL_USERNAME
IPROYAL_BASE_PASSWORD=$IPROYAL_BASE_PASSWORD
IPROYAL_HOST=$IPROYAL_HOST
IPROYAL_PORT=$IPROYAL_PORT
IPROYAL_COUNTRY=$IPROYAL_COUNTRY
IPROYAL_LIFETIME=$IPROYAL_LIFETIME
IPROYAL_STREAMING=$IPROYAL_STREAMING
IPROYAL_COUNTRIES=$IPROYAL_COUNTRIES
POOL_TARGET=$POOL_TARGET
POOL_STALE_MIN=$POOL_STALE_MIN
DOLPHIN_API_TOKEN=$DOLPHIN_API_TOKEN
ABUSEIPDB_API_KEY=$ABUSEIPDB_API_KEY
"@

Write-Env 'hotmail-multi-creator' @"
DOLPHIN_API_TOKEN=$DOLPHIN_API_TOKEN
IPROYAL_USERNAME=$IPROYAL_USERNAME
IPROYAL_BASE_PASSWORD=$IPROYAL_BASE_PASSWORD
IPROYAL_HOST=$IPROYAL_HOST
IPROYAL_PORT=$IPROYAL_PORT
IPROYAL_COUNTRY=$IPROYAL_COUNTRY
IPROYAL_LIFETIME=$IPROYAL_LIFETIME
IPROYAL_STREAMING=$IPROYAL_STREAMING
SMS_PROVIDER=manual
CAPTCHA_PROVIDER=manual
CAPTCHA_API_KEY=
DEBUG_SCREENSHOTS=
GOOGLE_SHEET_ID=
GOOGLE_SHEET_TAB=
"@

Write-Env 'twilio-multi-account-creator' @"
DOLPHIN_API_TOKEN=$DOLPHIN_API_TOKEN
DOLPHIN_LOCAL_API=$DOLPHIN_LOCAL_API
DOLPHIN_CLOUD_API=$DOLPHIN_CLOUD_API
RECEIVE_SMSS_DEFAULT_COUNTRY=us
LLM_BACKEND=
GEMINI_API_KEY=
GEMINI_MODEL=
OPENAI_API_KEY=
OPENAI_MODEL=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
DIALER_API_URL=
DIALER_API_PATH=
DIALER_API_TOKEN=
CAPSOLVER_API_KEY=
"@

# ───── 4. PowerShell loop scripts ─────
$scriptsDir = Join-Path $root 'chain-loops'
New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null

function Write-LoopScript {
  param([string]$Name, [string]$Body)
  $path = Join-Path $scriptsDir "$Name.ps1"
  $Body | Out-File -FilePath $path -Encoding UTF8 -NoNewline
  Write-Host "[loop] wrote $path" -ForegroundColor Green
}

Write-LoopScript 'start-ip-finder' @'
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE "good-ip-finder"
Push-Location $dir
Write-Host "[ip-finder] starting in $dir" -ForegroundColor Cyan
node "Good IP finder.js"
'@

Write-LoopScript 'start-hotmail-loop' @'
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE "hotmail-multi-creator"
$tunerOut = Join-Path $env:USERPROFILE "dolphin-anty-tuner\output"
$iter = 0
Write-Host "================================================" -ForegroundColor Cyan
Write-Host " Continuous Hotmail producer (forever loop)" -ForegroundColor Cyan
Write-Host " RDP in to click the Microsoft CAPTCHA when prompted." -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
while ($true) {
  $iter++
  $profiles = if (Test-Path $tunerOut) {
    (Get-ChildItem $tunerOut -File | Where-Object { $_.Name -notmatch "^(index\.jsonl|README\.md|\.)" }).Count
  } else { 0 }
  Write-Host "`n--- iter $iter at $(Get-Date -Format 'HH:mm:ss') --- profile pool: $profiles" -ForegroundColor Yellow
  if ($profiles -lt 1) {
    Write-Host " upstream profile pool empty -- sleeping 60s" -ForegroundColor DarkYellow
    Start-Sleep 60; continue
  }
  Push-Location $dir
  try { node index.js }
  catch { Write-Host " iter exited with error: $_" -ForegroundColor Red; Start-Sleep 120; Pop-Location; continue }
  Pop-Location
  Start-Sleep 30
}
'@

Write-LoopScript 'start-twilio-loop' @'
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE "twilio-multi-account-creator"
$hotmailOut = Join-Path $env:USERPROFILE "hotmail-multi-creator\output"
$ipOut = Join-Path $env:USERPROFILE "good-ip-finder\output"
$iter = 0
Write-Host "================================================" -ForegroundColor Cyan
Write-Host " Continuous Twilio producer (forever loop)" -ForegroundColor Cyan
Write-Host " RDP in to click the Turnstile CAPTCHA when prompted." -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
while ($true) {
  $iter++
  $hotmails = if (Test-Path $hotmailOut) {
    (Get-ChildItem $hotmailOut -File | Where-Object { $_.Name -notmatch "^(index\.jsonl|README\.md|\.)" }).Count
  } else { 0 }
  $ips = if (Test-Path $ipOut) {
    (Get-ChildItem $ipOut -File | Where-Object { $_.Name -notmatch "^(index\.jsonl|README\.md|\.)" }).Count
  } else { 0 }
  Write-Host "`n--- iter $iter at $(Get-Date -Format 'HH:mm:ss') --- hotmails: $hotmails IPs: $ips" -ForegroundColor Yellow
  if ($hotmails -lt 1) { Write-Host " hotmail pool empty -- sleeping 60s" -ForegroundColor DarkYellow; Start-Sleep 60; continue }
  if ($ips -lt 1)      { Write-Host " IP pool empty -- sleeping 60s"      -ForegroundColor DarkYellow; Start-Sleep 60; continue }
  Push-Location $dir
  try { node index.js }
  catch { Write-Host " iter exited with error: $_" -ForegroundColor Red; Start-Sleep 180; Pop-Location; continue }
  Pop-Location
  Start-Sleep 60
}
'@

# ───── 5. Final instructions ─────
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host " EC2 BOOTSTRAP COMPLETE" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps — open three PowerShell windows (or Windows Terminal tabs):" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Window 1 (IP finder):" -ForegroundColor Yellow
Write-Host "    & '$scriptsDir\start-ip-finder.ps1'"
Write-Host ""
Write-Host "  Window 2 (Hotmail loop, click Microsoft CAPTCHA when prompted):" -ForegroundColor Yellow
Write-Host "    & '$scriptsDir\start-hotmail-loop.ps1'"
Write-Host ""
Write-Host "  Window 3 (Twilio loop, click Turnstile CAPTCHA when prompted):" -ForegroundColor Yellow
Write-Host "    & '$scriptsDir\start-twilio-loop.ps1'"
Write-Host ""
Write-Host "The Dolphin Anty tuner (existing scheduled task) is your Step 2 profile producer." -ForegroundColor Cyan
Write-Host "It feeds the Hotmail loop. If it isn't running, restart with:" -ForegroundColor Cyan
Write-Host "    cd `$env:USERPROFILE\dolphin-anty-tuner; git pull; .\run-producer-as-scheduled-task.ps1"
Write-Host ""
Write-Host "Outputs land in each repo's output\ folder. RDP in periodically to click CAPTCHAs." -ForegroundColor Green
