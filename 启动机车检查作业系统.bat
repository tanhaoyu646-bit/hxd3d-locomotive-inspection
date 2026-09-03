@echo off
chcp 65001 >nul
title Locomotive Inspection Operation System
cd /d "%~dp0"

set "NODE_EXE=C:\Users\Tan\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

echo.
echo   Starting local server for Locomotive Inspection System...
echo   If the browser does not open automatically, visit:
echo   http://localhost:8777/
echo.

"%NODE_EXE%" tools\serve.js %1

pause
