@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo iPhone Photo Bridge v1.1.0 diagnostics

echo.
echo [1] Node.js
where node
if errorlevel 1 echo Node.js was not found.
node -v
echo.
echo [2] npm
where npm
if errorlevel 1 echo npm was not found.
npm -v
echo.
echo [3] server.js syntax
node --check server.js
echo.
echo [4] public/app.js syntax
node --check public/app.js
echo.
echo [5] package.json
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json OK')"
echo.
echo [6] detected network URLs
node scripts\print_network_urls.js
echo.
echo Diagnostics finished.
pause
