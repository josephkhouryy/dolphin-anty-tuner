# run-producer-as-scheduled-task.ps1 -- Launch produce/produce.js inside a
# Windows Scheduled Task (survives SSH disconnect). Mirrors the shape of
# run-as-scheduled-task.ps1 (which launches the legacy tune.js hill climber);
# this one launches the new continuous multi-judge producer.
#
# Usage:
#   .\run-producer-as-scheduled-task.ps1                    # run forever
#   .\run-producer-as-scheduled-task.ps1 -MaxAttempts 200   # soft cap
#   .\run-producer-as-scheduled-task.ps1 -Stop              # tear down

param(
  [int]$MaxAttempts = 0,
  [int]$SummaryEvery = 25,
  [string]$AllowedLocalIps = '',
  [switch]$SkipLocalIpCheck,
  [switch]$Stop
)

$taskName = 'DolphinAntyProducer'
$workDir  = $PSScriptRoot
$logPath  = Join-Path $workDir 'produce.log'

function Silent-Schtasks {
  param([string[]]$args)
  try { & schtasks.exe @args *>&1 | Out-Null } catch {}
}

if ($Stop) {
  Silent-Schtasks @('/End','/TN', $taskName)
  Silent-Schtasks @('/Delete','/TN', $taskName, '/F')
  Write-Output "Stopped and removed $taskName"
  return
}

Silent-Schtasks @('/End','/TN', $taskName)
Silent-Schtasks @('/Delete','/TN', $taskName, '/F')

Set-Content -Path $logPath -Value '' -Force

$cmdLauncher = Join-Path $workDir 'producer-task.cmd'
$nodeExe = (Get-Command node.exe).Source
$envLines = @()
if ($MaxAttempts -gt 0)     { $envLines += "set PRODUCE_MAX_ATTEMPTS=$MaxAttempts" }
if ($SummaryEvery -gt 0)    { $envLines += "set PRODUCE_SUMMARY_EVERY=$SummaryEvery" }
if ($AllowedLocalIps -ne '') { $envLines += "set BENCH_ALLOWED_LOCAL_IPS=$AllowedLocalIps" }
if ($SkipLocalIpCheck)       { $envLines += "set BENCH_SKIP_LOCAL_IP_CHECK=1" }
$envBlock = $envLines -join "`r`n"

@"
@echo off
cd /d "$workDir"
$envBlock
"$nodeExe" produce\produce.js
"@ | Set-Content -Path $cmdLauncher -Encoding ASCII -Force

& schtasks /Create /TN $taskName /TR $cmdLauncher /SC ONCE /ST 00:00 /SD 01/01/2099 /RL HIGHEST /F | Out-Null
& schtasks /Run /TN $taskName | Out-Null

Start-Sleep -Seconds 3
& schtasks /Query /TN $taskName /FO LIST /V | Select-String -Pattern 'TaskName|Status|Last Run Time|Last Result|Next Run Time'
Write-Output "log: $logPath"
