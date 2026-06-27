$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder("\")
$task = $folder.GetTask("SwingTrader-DailyScan")
$def = $task.Definition
$settings = $def.Settings
$settings.WakeToRun = $true
$folder.RegisterTaskDefinition("SwingTrader-DailyScan", $def, 4, $null, $null, $null)
Write-Host "DailyScan -> WakeToRun=True"
$check = $folder.GetTask("SwingTrader-DailyScan")
Write-Host ("Verified: WakeToRun = " + $check.Definition.Settings.WakeToRun)
