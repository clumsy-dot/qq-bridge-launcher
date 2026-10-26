@echo off
chcp 65001 >nul
setlocal
title qq-bridge launcher
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

node "%~dp0src\cli.cjs"
set "RC=%errorlevel%"

echo.
echo ---------------------------------------------------------------
echo You can close this window. QQ / SnowLuma / bridge keep running.
echo ---------------------------------------------------------------
pause >nul
popd
exit /b %RC%
