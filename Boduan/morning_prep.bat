@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ========================================
REM Swing-Trader 早间综合准备
REM 执行时间: 每天 08:30（周六由脚本自动跳过）
REM 内容: 晓胜文章 + 知更鸟信号
REM ========================================

set PROJECT_DIR=C:\Swing-Trader
set LOG_DIR=%PROJECT_DIR%\logs
set LOG_FILE=%LOG_DIR%\morning_prep_%date:~0,4%%date:~5,2%%date:~8,2%.log

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo ======================================== >> "%LOG_FILE%"
echo Swing-Trader Morning Prep >> "%LOG_FILE%"
echo Started: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"

cd /d "%PROJECT_DIR%"

C:\Users\46649\AppData\Local\Programs\Python\Python312\python.exe morning_prep.py >> "%LOG_FILE%" 2>&1

echo. >> "%LOG_FILE%"
echo Finished: %date% %time% >> "%LOG_FILE%"
echo ======================================== >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

endlocal
