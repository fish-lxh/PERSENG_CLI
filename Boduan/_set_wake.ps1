$tasks = @("SwingTrader-MorningPrep", "SwingTrader-MorningBrief", "SwingTrader-MiddayCheck")
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder("\")
foreach ($tn in $tasks) {
    $task = $folder.GetTask($tn)
    $def = $task.Definition
    $settings = $def.Settings

    # 设置 WakeToRun = True
    $settings.WakeToRun = $true

    # 注册更新
    $folder.RegisterTaskDefinition($tn, $def, 4, $null, $null, $null)
    Write-Host ("[OK] " + $tn + " -> WakeToRun=True")

    # 验证
    $check = $folder.GetTask($tn)
    if ($check.Definition.Settings.WakeToRun -eq $true) {
        Write-Host ("  Verified: WakeToRun = True")
    } else {
        Write-Host ("  FAILED: WakeToRun = " + $check.Definition.Settings.WakeToRun)
    }
    Write-Host ""
}
