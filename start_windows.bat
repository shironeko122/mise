@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo iPhone Photo Bridge v1.1.0 - GitHub Private Repo Local

echo.
if not exist server.js (
  echo ERROR: server.js was not found.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not in PATH.
  echo Install Node.js 20 or later, then run this file again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm is not installed or not in PATH.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)
echo.
call node scripts\print_network_urls.js
echo.
echo Starting server...
echo Press Ctrl+C to stop.
echo.
start "" http://localhost:3000
call npm start
pause
