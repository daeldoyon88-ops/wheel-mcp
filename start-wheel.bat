@echo off
setlocal

echo Demarrage du backend et du frontend Wheel Dashboard...

start "Wheel Backend" cmd /k "cd /d C:\Users\melan\Desktop\wheel-mcp-remote && npm run dev"

timeout /t 3 /nobreak >nul

start "Wheel Frontend" cmd /k "cd /d C:\Users\melan\Desktop\wheel-mcp-remote\wheel-dashboard && npm run dev"

echo Les deux services sont en cours de demarrage.
endlocal
