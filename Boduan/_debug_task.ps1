$names = @("SwingTrader-MorningPrep", "SwingTrader-MorningBrief", "SwingTrader-MiddayCheck", "SwingTrader-DailyScan")

foreach ($n in $names) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if (-not $t) {
        Write-Host "=== $n === [任务不存在]"
        continue
    }

    $info = Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue

    Write-Host "=== $n ==="
    Write-Host "  状态: $($t.State)"
    Write-Host "  上次运行: $($info.LastRunTime)"
    Write-Host "  上次结果: $($info.LastTaskResult)"
    Write-Host "  下次运行: $($info.NextRunTime)"
    Write-Host ""
}
