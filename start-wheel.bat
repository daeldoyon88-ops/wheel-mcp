@echo off
setlocal

echo ============================================
echo   Demarrage Wheel Dashboard - MODE AUTO
echo ============================================
echo.
echo Fermeture des anciens processus Node...
taskkill /F /IM node.exe >nul 2>&1

echo.
echo Configuration environnement...
set WHEEL_DEV_SCAN=auto
set IBKR_TWO_PHASE_SCAN=1

echo WHEEL_DEV_SCAN=%WHEEL_DEV_SCAN%
echo IBKR_TWO_PHASE_SCAN=%IBKR_TWO_PHASE_SCAN%
echo.

echo Marche ouvert  = mode normal
echo Hors marche    = mode DEV automatique
echo IBKR mode      = TWO_PHASE explicite
echo.

start "Wheel Backend AUTO" cmd /k "cd /d C:\Users\melan\Desktop\wheel-mcp-remote && echo IBKR_TWO_PHASE_SCAN=%IBKR_TWO_PHASE_SCAN% && npm run dev"

timeout /t 3 /nobreak >nul

start "Wheel Frontend Dashboard" cmd /k "cd /d C:\Users\melan\Desktop\wheel-mcp-remote\wheel-dashboard && npm run dev"

echo.
echo Backend + Frontend lances.
timeout /t 2 /nobreak >nul

endlocal
exit