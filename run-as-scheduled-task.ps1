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

# We persist MAX_ITERATIONS into a per-user env var so the task picks it up via
# tune.js's process.env (dotenv override:true does not clobber existing env vars
# if .env does not define this key).
[Environment]::SetEnvironmentVariable('TUNER_MAX_ITERATIONS', "$MaxIters", 'User')

# Build the command. We wrap in cmd /c so we can set TUNER_MAX_ITERATIONS in the
# task's session too (User env vars do not always propagate to schtasks
# children). Output goes to tune.log via tune.js's own tee logger.
$nodeExe = (Get-Command node.exe).Source
$cmd = "cmd /c `"set TUNER_MAX_ITERATIONS=$MaxIters && cd /d $workDir && `"$nodeExe`" tune.js`""

# /SC ONCE   -- one-shot trigger
# /ST 00:00  -- placeholder time; we trigger immediately below with /Run
# /SD distant date so the trigger never re-fires
# /RL HIGHEST -- run elevated
# /F  -- overwrite without prompting
& schtasks /Create /TN $taskName /TR $cmd /SC ONCE /ST 00:00 /SD 01/01/2099 /RL HIGHEST /F | Out-Null

# Trigger it
& schtasks /Run /TN $taskName | Out-Null

Start-Sleep -Seconds 3
& schtasks /Query /TN $taskName /FO LIST /V | Select-String -Pattern 'TaskName|Status|Last Run Time|Last Result|Next Run Time'
Write-Output "log: $logPath"
