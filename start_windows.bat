@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo [Spartacus LocalCAST v1.0.5]
echo 起動準備中です...
if not exist server.js (
  echo server.js が見つかりません。このBATはZIPを展開したフォルダで実行してください。
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js が見つかりません。Node.jsをインストールしてから再実行してください。
  pause
  exit /b 1
)
if not exist node_modules (
  echo 初回のみ必要なパッケージをインストールします...
  npm install
  if errorlevel 1 (
    echo npm install に失敗しました。
    pause
    exit /b 1
  )
)
echo.
echo ブラウザで http://localhost:3000 を開いてください。
echo 同じWi-Fi内の端末からは、このPCのIPアドレス:3000 でアクセスできます。
echo 終了する場合はこの画面で Ctrl + C を押してください。
echo.
node server.js
pause
