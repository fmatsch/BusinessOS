@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Bitte Node.js 20.9 oder neuer installieren: https://nodejs.org
  exit /b 1
)
node "%~dp0install.mjs" %*
