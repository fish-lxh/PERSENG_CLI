# PowerShell script to run daily_scan.py with full output capture
$logFile = "C:\Swing-Trader\logs\scan_run.log"
$doneMarker = "C:\Swing-Trader\logs\scan_done.marker"

# Clean up old marker
Remove-Item $doneMarker -ErrorAction Ignore

Write-Host "Starting daily_scan.py at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')..."
Write-Host "Log: $logFile"

# Run Python and capture ALL output
$output = & "C:\Users\46649\AppData\Local\Programs\Python\Python312\python.exe" -u "C:\Swing-Trader\daily_scan.py" 2>&1

# Write output to log
$output | Out-File -FilePath $logFile -Encoding utf8 -Width 4096

# Write done marker
"Done at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ExitCode: $LASTEXITCODE" | Out-File $doneMarker -Encoding utf8

Write-Host "Completed at $(Get-Date -Format 'HH:mm:ss')"
Write-Host "Exit code: $LASTEXITCODE"
Write-Host "Lines: $($output.Count)"
