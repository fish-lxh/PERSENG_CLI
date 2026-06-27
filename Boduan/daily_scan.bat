@echo off
chcp 65001 >nul
cd /d C:\Swing-Trader
C:\Users\46649\AppData\Local\Programs\Python\Python312\python.exe daily_scan_runner.py
exit /b %ERRORLEVEL%
