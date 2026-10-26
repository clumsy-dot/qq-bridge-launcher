@echo off
chcp 65001 >nul
setlocal
title QQ 桥接
pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found in PATH.
  echo         Install Node.js 18+ from https://nodejs.org/ and run this again.
  echo.
  pause
  popd
  exit /b 1
)

rem Single desktop entry: interactive menu (start / switch account / dry-run / rebuild shortcut)
node "%~dp0src\cli.cjs" --menu
set "RC=%errorlevel%"

echo.
echo ---------------------------------------------------------------
echo You can close this window. QQ / SnowLuma / bridge keep running.
echo ---------------------------------------------------------------
pause >nul
popd
exit /b %RC%
