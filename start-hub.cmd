@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [lanstore] Node.js not found in PATH. Install Node 20+ and retry.
  pause
  exit /b 1
)

if not exist "%~dp0config.json" (
  if exist "%~dp0config.example.json" copy "%~dp0config.example.json" "%~dp0config.json" >nul
)

node src\server.mjs %*
if errorlevel 1 pause
