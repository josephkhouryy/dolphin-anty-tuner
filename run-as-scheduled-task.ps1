# run-as-scheduled-task.ps1 -- Launch tune.js inside a Windows Scheduled Task
# (survives SSH disconnect; Windows OpenSSH kills the SSH session job tree on
# exit, even Node detached children). Uses the classic schtasks.exe -- the
# Register-ScheduledTask cmdlets refused to run under SSH for unclear reasons.
#
# Usage:
#   .\run-as-scheduled-task.ps1                 # default 30 iterations
#   .\run-as-scheduled-task.ps1 -MaxIters 20
#   .\run-as-scheduled-task.ps1 -Stop

param(
  [int]$MaxIters = 30,
  [switch]$Stop
)

$taskName = 'DolphinAntyTuner'
$workDir  = $PSScriptRoot
$logPath  = Join-Path $workDir 'tune.log'

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

# Clear any prior copy
Silent-Schtasks @('/End','/TN', $taskName)
Silent-Schtasks @('/Delete','/TN', $taskName, '/F')

# Reset the log
Set-Content -Path $logPath -Value '' -Force

# Write a tiny .cmd launcher so schtasks doesn't have to parse the command line.
$cmdLauncher = Join-Path $workDir 'tuner-task.cmd'
$nodeExe = (Get-Command node.exe).Source
@"
@echo off
cd /d "$workDir"
set TUNER_MAX_ITERATIONS=$MaxIters
"$nodeExe" tune.js
"@ | Set-Content -Path $cmdLauncher -Encoding ASCII -Force

# /SC ONCE   -- one-shot trigger
# /ST 00:00  -- placeholder time; we trigger immediately below with /Run
# /SD distant date so the trigger never re-fires
# /RL HIGHEST -- run elevated
# /F  -- overwrite without prompting
# Quote the /TR path literally -- schtasks stores it verbatim and cmd.exe
# splits unquoted paths on spaces, so a $PSScriptRoot like
# "C:\Users\John Smith\..." would create the task but silently fail to run.
& schtasks /Create /TN $taskName /TR "`"$cmdLauncher`"" /SC ONCE /ST 00:00 /SD 01/01/2099 /RL HIGHEST /F | Out-Null

# Trigger it
& schtasks /Run /TN $taskName | Out-Null

Start-Sleep -Seconds 3
& schtasks /Query /TN $taskName /FO LIST /V | Select-String -Pattern 'TaskName|Status|Last Run Time|Last Result|Next Run Time'
Write-Output "log: $logPath"
