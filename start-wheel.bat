@echo off
setlocal

echo ============================================
echo   Demarrage Wheel Dashboard - MODE AUTO
echo ============================================
echo.
echo Marche ouvert  = mode normal
echo Hors marche    = mode DEV automatique
echo.

start "Wheel Backend AUTO" cmd /k "cd /d C:\Users\melan\Desktop\wheel-mcp-remote && set WHEEL_DEV_SCAN=auto && npm run dev"

timeout /t 3 /nobreak >nul

start "Wheel Frontend Dashboard" cmd /k "cd /d C:\Users\melan\Desktop\wheel-mcp-remote\wheel-dashboard && npm run dev"

echo.
echo Backend + Frontend lances.
echo Cette fenetre va se fermer.
timeout /t 2 /nobreak >nul

endlocal
exit