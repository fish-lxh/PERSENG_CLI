$names = @("MorningPrep", "MorningBrief", "MiddayCheck", "DailyScan")
$outDir = "C:\Swing-Trader"
foreach ($n in $names) {
    $tn = "SwingTrader-" + $n
    $fp = $outDir + "\_task_" + $n + ".txt"
    schtasks /query /tn $tn /v /fo list | Out-File -FilePath $fp -Encoding UTF8
    Write-Host ("Exported: " + $fp)
}
