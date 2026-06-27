# Create risk monitor scheduled tasks
# AM: 10:00 Mon-Fri, PM: 14:30 Mon-Fri

$python = "C:\Users\46649\AppData\Local\Programs\Python\Python312\python.exe"
$script = "C:\Swing-Trader\跟踪用户持仓\risk_monitor.py"
$wd = "C:\Swing-Trader\跟踪用户持仓"
$action = New-ScheduledTaskAction -Execute $python -Argument $script -WorkingDirectory $wd

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# Mon-Fri bitmask: Mon=2, Tue=4, Wed=8, Thu=16, Fri=32 => 2+4+8+16+32=62
$daysOfWeek = 62

$triggerAM = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "10:00" -WeeksInterval 1
Register-ScheduledTask -TaskName "SwingTrader-RiskMonitor-AM" -Action $action -Trigger $triggerAM -Settings $settings -User "SYSTEM" -RunLevel Limited -Force
Write-Host "AM task created (10:00 Mon-Fri)"

$triggerPM = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "14:30" -WeeksInterval 1
Register-ScheduledTask -TaskName "SwingTrader-RiskMonitor-PM" -Action $action -Trigger $triggerPM -Settings $settings -User "SYSTEM" -RunLevel Limited -Force
Write-Host "PM task created (14:30 Mon-Fri)"

Write-Host "Done."
