@echo off
chcp 65001 >nul
setlocal
title qq-bridge launcher select account
pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found in PATH.
  pause
  popd
  exit /b 1
)

node "%~dp0src\cli.cjs" --ask
set "RC=%errorlevel%"

echo.
echo ---------------------------------------------------------------
echo You can close this window. QQ / SnowLuma / bridge keep running.
echo ---------------------------------------------------------------
pause >nul
popd
exit /b %RC%
