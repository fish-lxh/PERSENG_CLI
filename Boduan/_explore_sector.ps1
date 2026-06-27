Write-Host "=== scan_results directory ==="
Get-ChildItem "C:\Swing-Trader\scan_results\*.md" -Name | Select-Object -First 30
Write-Host "`n=== Check for rotation ==="
Get-ChildItem "C:\Swing-Trader" -Directory -Name
Write-Host "`n=== Check for any JSON/CSV with sector data ==="
Get-ChildItem "C:\Swing-Trader\scan_results\*.json" -Name 2>$null
Get-ChildItem "C:\Swing-Trader\scan_results\*.csv" -Name 2>$null
Write-Host "`n=== Check for rotation folder ==="
Test-Path "C:\Swing-Trader\rotation"
Test-Path "C:\Swing-Trader\赛道轮动捕手"
Write-Host "`n=== morning briefs contain sector info ==="
Get-ChildItem "C:\Swing-Trader\scan_results\morning_brief_20260603.md" -Name
