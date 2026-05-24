# ec2-bootstrap.ps1 — one-shot installer to migrate the full chain onto Windows EC2.
#
# Run inside an Administrator PowerShell on the EC2 instance:
#
#   iwr https://raw.githubusercontent.com/josephkhouryy/dolphin-anty-tuner/main/ec2-bootstrap.ps1 -UseBasicParsing | iex
#
# (or just paste this entire script into PowerShell after RDPing in.)
#
# Idempotent — safe to re-run. Assumes the existing dolphin-anty-tuner
# bootstrap already ran (Node, git, Dolphin Anty installed).
#
# What this does:
#   1. Clones Good IP Finder + Hotmail Multi Creator + Twilio Multi Account Creator
#   2. Runs `npm install` in each
#   3. Writes .env files for each (with shared IPRoyal + Dolphin creds embedded;
#      AbuseIPDB key embedded)
#   4. Writes PowerShell equivalents of the continuous-loop bash scripts
#   5. Prints the launch commands

$ErrorActionPreference = 'Stop'

# ───── shared creds (copied from your Mac .env files 2026-05-24) ─────
$IPROYAL_USERNAME      = 'mzEcAaG0CQUNGzuc'
$IPROYAL_BASE_PASSWORD = 'FmY0zsaPTGuaFL7W'
$IPROYAL_HOST          = 'geo.iproyal.com'
$IPROYAL_PORT          = '12321'
$IPROYAL_COUNTRY       = 'us'
$IPROYAL_LIFETIME      = '24h'
$IPROYAL_STREAMING     = ''
$IPROYAL_COUNTRIES     = 'us,gb,ca,de,fr,nl,au,it,es'
$POOL_TARGET           = '3'
$POOL_STALE_MIN        = '60'
$DOLPHIN_API_TOKEN     = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiODhkNGVhMDU3MTE5YzFkODRlOGRjYjY0ZDhlOTU2NGMzYjFmMDlhNTQ2NmQ0NTc0ZmU0NjI1ZmRkYWMzN2IzNmQyMWIxYTY2ZTFiMTdlMTUiLCJpYXQiOjE3Nzk0Mjc4NTIuMzE3NTE0LCJuYmYiOjE3Nzk0Mjc4NTIuMzE3NTE3LCJleHAiOjE4MTA5NjM4NTIuMzA5MjE2LCJzdWIiOiI1MDg4NjM5Iiwic2NvcGVzIjpbXSwidGVhbV9pZCI6NDk4NTczMywidGVhbV9wbGFuIjoic3RhcnRlciIsInRlYW1fcGxhbl9leHBpcmF0aW9uIjoxNzgyMDE5Nzk1fQ.EqyYJQjvKj-eT10xq2393r3FRmsuoAPUYtPgwG5nzGqGyEO0a2-Cn9p2bMtkA2qJGZJ9OUTnPEwnYh75KECUBqbaMo4oP03sABPAIoDPFLFR0V8_YDvP6RPRvZ-uNSEs7CTignlJYvCHkdHc-AlQ0Cefim8XNTIGlDJImNC-sNsiuxOOIXdCCB-QdMlIqQ07liMCzw4rBqjAafAV4Nzx8Pc2wbPtiTjiniUaWqv1MQAbXulEHs7rXct9y1qUEDybL23T12WFZSzmUXzZUITjIaaaCntGfm7eaVFBvpMAGATL21C9az3EcylsbrmGbNxWCNMtRvN8UQ02M1IMThugRibMWX_uIjKKrz-GTjbXQn-Oq90p90NnfgHGdlDapZFvXFrrS3RFp782fknNKei0TzJ0ayQl0-yBRW1EwCLsyJe6lHXBGqvTj39B17VJlLRqdaNTx0G8gKXnj9Gv09xN14xgK_FLmY_DcJTcF5cSvQU2AeR2fteX_KVJNJ6HU4AhEcC95ZxNk63AITgoaSW74FRVWxkO-tACz_xRN_hfKzd4jk57LcqP65RGT1S8UmdR2IIbTXJLK4KUnRtljNtM9irZ-McWlJGjD6pe5xRaW8bF4OSdV7WqAlwR8sn6wOjmU0UEBCetOPmVSUzuMKLKbjptFvHspXFyb0nhozXNDQ0'
$ABUSEIPDB_API_KEY     = 'b484a11241db249d0e46def8930eb4615f3998346241f35f2f45e66860c38f7791a0adc75f54b00c'

# Dolphin Anty's local API on EC2 listens on the same port as on Mac: 3001.
$DOLPHIN_LOCAL_API     = 'http://localhost:3001'
$DOLPHIN_CLOUD_API     = 'https://anty-api.com'

$root = $env:USERPROFILE
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
  $p = Join-Path $root $d
  Write-Host "[npm] installing deps in $d" -ForegroundColor Green
  Push-Location $p
  npm install --no-audit --no-fund --loglevel=error
  Pop-Location
}

# ───── 3. Write .env files ─────
function Write-Env {
  param([string]$DirName, [string]$Body)
  $envFile = Join-Path $root "$DirName\.env"
  if (Test-Path $envFile) {
    Write-Host "[env] $DirName\.env already exists — backing up to .env.bak and overwriting." -ForegroundColor Yellow
    Copy-Item $envFile "$envFile.bak" -Force
  } else {
    Write-Host "[env] writing fresh $DirName\.env" -ForegroundColor Green
  }
  $Body | Out-File -FilePath $envFile -Encoding ASCII -NoNewline
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

# ───── 4. PowerShell loop scripts (mirrors of the Mac bash scripts) ─────

$scriptsDir = Join-Path $root 'chain-loops'
New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null

function Write-LoopScript {
  param([string]$Name, [string]$Body)
  $path = Join-Path $scriptsDir "$Name.ps1"
  $Body | Out-File -FilePath $path -Encoding UTF8 -NoNewline
  Write-Host "[loop] wrote $path" -ForegroundColor Green
}

Write-LoopScript 'start-ip-finder' @'
# Good IP Finder daemon — runs continuously, sleeps 5min when pool full.
# Kill via Stop-Process by PID, or Ctrl-C.
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE "good-ip-finder"
Push-Location $dir
Write-Host "[ip-finder] starting in $dir" -ForegroundColor Cyan
node "Good IP finder.js"
'@

Write-LoopScript 'start-hotmail-loop' @'
# Continuous Hotmail producer. Sleeps when upstream profile pool is dry.
# Ctrl-C to stop.
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
# Continuous Twilio producer. Sleeps when upstream Hotmail pool or IP pool is dry.
# RDP in to click Twilio's invisible Turnstile CAPTCHA on each iteration.
# Ctrl-C to stop.
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
  if ($hotmails -lt 1) {
    Write-Host " hotmail pool empty -- sleeping 60s" -ForegroundColor DarkYellow
    Start-Sleep 60; continue
  }
  if ($ips -lt 1) {
    Write-Host " IP pool empty -- sleeping 60s" -ForegroundColor DarkYellow
    Start-Sleep 60; continue
  }
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
Write-Host "Next steps — open THREE PowerShell windows (or use Windows Terminal tabs):" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Window 1 (IP finder):" -ForegroundColor Yellow
Write-Host "    & '$scriptsDir\start-ip-finder.ps1'"
Write-Host ""
Write-Host "  Window 2 (Hotmail loop, click MS CAPTCHA when prompted):" -ForegroundColor Yellow
Write-Host "    & '$scriptsDir\start-hotmail-loop.ps1'"
Write-Host ""
Write-Host "  Window 3 (Twilio loop, click Turnstile CAPTCHA when prompted):" -ForegroundColor Yellow
Write-Host "    & '$scriptsDir\start-twilio-loop.ps1'"
Write-Host ""
Write-Host "The Dolphin Anty tuner (existing scheduled task) is your Step 2 profile producer." -ForegroundColor Cyan
Write-Host "It feeds the Hotmail loop. If it isn't running, restart with:" -ForegroundColor Cyan
Write-Host "    cd `$env:USERPROFILE\dolphin-anty-tuner; git pull; .\run-producer-as-scheduled-task.ps1"
Write-Host ""
Write-Host "Outputs land in each repo's output\ folder. You can keep your Mac closed —" -ForegroundColor Green
Write-Host "the chain runs entirely on this VM. RDP in periodically to click CAPTCHAs." -ForegroundColor Green
