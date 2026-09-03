@echo off
chcp 65001 >nul
title Locomotive Inspection - PC + Mobile (8777 / 8778)
cd /d "%~dp0"

set "NODE_EXE=C:\Users\Tan\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo.
echo   Starting two servers:
echo     PC     -^> http://localhost:8777  (this computer)
echo     Mobile -^> http://^<your-LAN-IP^>:8778  (scan QR code below)
echo.
echo   Keep this window open. Press Ctrl+C to stop both.
echo.

"%NODE_EXE%" tools\serve-dual.js

pause
