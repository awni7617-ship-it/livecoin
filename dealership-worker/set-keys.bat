@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Forecourt - number plate lookup keys
echo ============================================
echo.
echo You need free accounts with two government services:
echo.
echo   DVLA          https://developer-portal.driver-vehicle-licensing.api.gov.uk
echo   MOT history   https://documentation.history.mot.api.gov.uk
echo.
echo Each one emails you the values. You can do one now and the other
echo later - press Enter to skip anything you have not got yet.
echo.
pause

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org first.
  pause
  exit /b 1
)

echo.
set /p DOKEY="Set the DVLA key now? (y/n): "
if /i "%DOKEY%"=="y" call npx --yes wrangler secret put DVLA_API_KEY

echo.
set /p DOMOT="Set the three MOT history values now? (y/n): "
if /i "%DOMOT%"=="y" (
  call npx --yes wrangler secret put MOT_CLIENT_ID
  call npx --yes wrangler secret put MOT_CLIENT_SECRET
  call npx --yes wrangler secret put MOT_API_KEY
)

echo.
echo Deploying again so the keys take effect...
echo.
call npx --yes wrangler deploy

echo.
echo ============================================
echo   Check it worked: open your site, then
echo   Settings - Number plate lookup
echo ============================================
echo.
pause
