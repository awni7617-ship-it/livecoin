@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Forecourt - putting your site live
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed yet.
  echo.
  echo 1. Go to https://nodejs.org
  echo 2. Click the big LTS button and install it
  echo 3. Run this file again
  echo.
  pause
  exit /b 1
)

echo Your browser will open so you can approve access to your own
echo Cloudflare account. If it says you are already logged in, that is
echo fine - it carries straight on.
echo.
call npx --yes wrangler login
if errorlevel 1 goto failed

echo.
echo Deploying...
echo.
call npx --yes wrangler deploy
if errorlevel 1 goto failed

echo.
echo ============================================
echo   Done. Your address is printed just above,
echo   ending in .workers.dev
echo ============================================
echo.
echo To switch the number plate lookup on, run set-keys.bat next.
echo.
pause
exit /b 0

:failed
echo.
echo That did not finish. The error is above.
echo.
pause
exit /b 1
