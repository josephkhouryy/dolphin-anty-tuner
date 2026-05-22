# run-as-scheduled-task.ps1 -- Run tune.js inside a Windows Scheduled Task so
# it survives SSH disconnect (Windows OpenSSH kills its session's whole job
# tree on exit, even Node `detached:true` children -- Scheduled Tasks run in a
# separate session and escape this).
#
# Usage (from inside this folder):
#   .\run-as-scheduled-task.ps1                 # default 30 iterations
#   .\run-as-scheduled-task.ps1 -MaxIters 20    # override
#   .\run-as-scheduled-task.ps1 -Stop           # cancel a running task
#
# Output:
#   tune.log inside this folder -- refreshed each launch.
#   The task is named 'DolphinAntyTuner'.

param(
  [int]$MaxIters = 30,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$taskName = 'DolphinAntyTuner'
$workDir = $PSScriptRoot

if ($Stop) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Stopped + unregistered $taskName"
  return
}

# Always start fresh
Stop-ScheduledTask    -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

# tune.js tees console to tune.log itself; no extra wrapping needed.
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction `
    -Execute $nodeExe `
    -Argument 'tune.js' `
    -WorkingDirectory $workDir

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::FromHours(4))

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Dolphin Anty fingerprint tuner -- runs tune.js once; max $MaxIters iterations" | Out-Null

# Pass MAX_ITERATIONS to the task. The Settings API doesn't accept env vars
# directly, so we set it system-wide for THIS user before triggering.
[Environment]::SetEnvironmentVariable('TUNER_MAX_ITERATIONS', "$MaxIters", 'User')

# Reset the log
$logPath = Join-Path $workDir 'tune.log'
Set-Content -Path $logPath -Value '' -Force

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
Get-ScheduledTaskInfo -TaskName $taskName | Format-List TaskName, LastRunTime, NextRunTime, LastTaskResult
