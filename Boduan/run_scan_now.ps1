# PowerShell script to run daily_scan.py
$logFile = "C:\Swing-Trader\logs\scan_manual_run.log"
Write-Host "Starting scan at $(Get-Date -Format 'HH:mm:ss')..."
Write-Host "Output will be saved to $logFile"

$result = & "C:\Users\46649\AppData\Local\Programs\Python\Python312\python.exe" -u "C:\Swing-Trader\daily_scan.py" 2>&1

$result | Out-File -FilePath $logFile -Encoding utf8 -Force
$exitCode = $LASTEXITCODE

Write-Host "Finished at $(Get-Date -Format 'HH:mm:ss')"
Write-Host "Exit code: $exitCode"
Write-Host "Total lines: $($result.Count)"
