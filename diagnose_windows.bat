@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo [Spartacus LocalCAST v1.0.5 診断]
where node
node -v
where npm
npm -v
if exist server.js node --check server.js
if exist package.json type package.json
pause
