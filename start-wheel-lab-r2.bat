@echo off
setlocal EnableExtensions

set "STABLE_ROOT=C:\Users\melan\Desktop\wheel-mcp-remote"
set "LEGACY_ROOT=C:\Users\melan\Desktop\wheel-mcp-ui-lab"
set "R2_ROOT=C:\Users\melan\Desktop\wheel-mcp-ui-lab-r2"

rem Preserve the effective scanner/runtime settings from the working launchers.
set "WHEEL_DEV_SCAN=auto"
set "IBKR_TWO_PHASE_SCAN=1"
set "NODE_OPTIONS=--use-system-ca"

if not "%~1"=="" (
  set "WHEEL_SELECTION=%~1"
) else (
  cls
  echo ========================================
  echo         WHEEL LAB R2 LAUNCHER
  echo ========================================
  echo.
  echo 1 - Wheel Stable             5173
  echo 2 - Legacy UI Lab            5174
  echo 3 - New UI Lab R2            5175
  echo 4 - Stable + Legacy          5173 + 5174
  echo 5 - Stable + R2              5173 + 5175
  echo 6 - Legacy + R2              5174 + 5175
  echo 7 - Stable + Legacy + R2     5173 + 5174 + 5175
  echo R - Reset Wheel runtimes only
  echo Q - Quit
  echo.
  set /p "WHEEL_SELECTION=Selection: "
)

if /i "%WHEEL_SELECTION%"=="Q" exit /b 0
if /i "%WHEEL_SELECTION%"=="R" goto reset_only
if "%WHEEL_SELECTION%"=="1" goto mode_1
if "%WHEEL_SELECTION%"=="2" goto mode_2
if "%WHEEL_SELECTION%"=="3" goto mode_3
if "%WHEEL_SELECTION%"=="4" goto mode_4
if "%WHEEL_SELECTION%"=="5" goto mode_5
if "%WHEEL_SELECTION%"=="6" goto mode_6
if "%WHEEL_SELECTION%"=="7" goto mode_7
echo Invalid selection: %WHEEL_SELECTION%
exit /b 2

:prepare
echo.
echo Resetting verified Wheel runtimes on ports 3001, 5173, 5174 and 5175...
call :reset_wheel
if errorlevel 1 exit /b %errorlevel%
echo Required Wheel ports are clean.
echo Effective environment: WHEEL_DEV_SCAN=%WHEEL_DEV_SCAN% IBKR_TWO_PHASE_SCAN=%IBKR_TWO_PHASE_SCAN% NODE_OPTIONS=%NODE_OPTIONS%
exit /b 0

:mode_1
call :prepare
if errorlevel 1 exit /b %errorlevel%
call :start_backend "%STABLE_ROOT%" "Stable"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%STABLE_ROOT%\wheel-dashboard" 5173 "Stable"
exit /b %errorlevel%

:mode_2
call :prepare
if errorlevel 1 exit /b %errorlevel%
call :start_backend "%STABLE_ROOT%" "Stable shared"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%LEGACY_ROOT%\wheel-dashboard" 5174 "Legacy"
exit /b %errorlevel%

:mode_3
call :prepare
if errorlevel 1 exit /b %errorlevel%
call :start_backend "%R2_ROOT%" "R2"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%R2_ROOT%\wheel-dashboard" 5175 "R2"
exit /b %errorlevel%

:mode_4
call :prepare
if errorlevel 1 exit /b %errorlevel%
call :start_backend "%STABLE_ROOT%" "Stable shared"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%STABLE_ROOT%\wheel-dashboard" 5173 "Stable"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%LEGACY_ROOT%\wheel-dashboard" 5174 "Legacy"
exit /b %errorlevel%

:mode_5
call :prepare
if errorlevel 1 exit /b %errorlevel%
call :start_backend "%STABLE_ROOT%" "Stable shared"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%STABLE_ROOT%\wheel-dashboard" 5173 "Stable"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%R2_ROOT%\wheel-dashboard" 5175 "R2"
exit /b %errorlevel%

:mode_6
call :prepare
if errorlevel 1 exit /b %errorlevel%
call :start_backend "%STABLE_ROOT%" "Stable shared"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%LEGACY_ROOT%\wheel-dashboard" 5174 "Legacy"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%R2_ROOT%\wheel-dashboard" 5175 "R2"
exit /b %errorlevel%

:mode_7
call :prepare
if errorlevel 1 exit /b %errorlevel%
call :start_backend "%STABLE_ROOT%" "Stable shared"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%STABLE_ROOT%\wheel-dashboard" 5173 "Stable"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%LEGACY_ROOT%\wheel-dashboard" 5174 "Legacy"
if errorlevel 1 exit /b %errorlevel%
call :start_ui "%R2_ROOT%\wheel-dashboard" 5175 "R2"
exit /b %errorlevel%

:reset_only
call :reset_wheel
exit /b %errorlevel%

:start_backend
echo Starting %~2 backend from %~1 on port 3001...
start "Wheel Backend %~2 3001" cmd /k "cd /d %~1 && npm.cmd run dev"
call :wait_for_port 3001 40
if errorlevel 1 (
  echo BACKEND_START_FAILURE port=3001 root=%~1
  exit /b 10
)
exit /b 0

:start_ui
echo Starting %~3 UI from %~1 on port %~2...
start "Wheel UI %~3 %~2" cmd /k "cd /d %~1 && npm.cmd run dev -- --port %~2"
call :wait_for_port %~2 40
if errorlevel 1 (
  echo UI_START_FAILURE port=%~2 root=%~1
  exit /b 11
)
exit /b 0

:wait_for_port
powershell.exe -NoProfile -Command "$port=%~1; $attempts=%~2; for($i=0; $i -lt $attempts; $i++){ if(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue){ exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"
exit /b %errorlevel%

:reset_wheel
powershell.exe -NoProfile -Command "$ports=@(3001,5173,5174,5175); $roots=@('%STABLE_ROOT%','%LEGACY_ROOT%','%R2_ROOT%'); $marker='(?i)^(cmd|node|npm)(?:\.exe)?\|.*(cmd|npm|nodemon|node|server\.js|vite)'; function Get-WheelProcess([int]$processId){ try { $process=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $processId) -ErrorAction Stop; $commandLine=[string]$process.CommandLine; if($null -eq $process){ return [pscustomobject]@{ ProcessId=0; ParentProcessId=0; CommandLine='absent|' } }; if([string]::IsNullOrWhiteSpace($commandLine)){ return $null }; return [pscustomobject]@{ ProcessId=[int]$process.ProcessId; ParentProcessId=[int]$process.ParentProcessId; CommandLine=([string]$process.Name + '|' + $commandLine) } } catch { return $null } }; function Test-WheelRoot([string]$commandLine){ foreach($root in $roots){ if($commandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0){ return $true } }; return $false }; function Test-RuntimeMarker([string]$commandLine){ return $commandLine -match $marker }; function Find-WheelRuntimeRoot([int]$listenerPid){ $currentPid=$listenerPid; $candidate=$null; for($depth=0; $depth -lt 12 -and $currentPid -gt 0; $depth++){ $process=Get-WheelProcess $currentPid; if($null -eq $process){ return $null }; $commandLine=[string]$process.CommandLine; if(-not (Test-RuntimeMarker $commandLine)){ if($depth -eq 0){ return $null }; break }; if(Test-WheelRoot $commandLine){ $candidate=[pscustomobject]@{ ProcessId=[int]$process.ProcessId; ParentProcessId=[int]$process.ParentProcessId; CommandLine=$commandLine } }; $currentPid=[int]$process.ParentProcessId }; return $candidate }; function Test-RuntimeChain([int]$listenerPid,$rootRecord){ $freshRoot=Get-WheelProcess ([int]$rootRecord.ProcessId); if($null -eq $freshRoot){ return $false }; if([int]$freshRoot.ParentProcessId -ne [int]$rootRecord.ParentProcessId -or [string]$freshRoot.CommandLine -ne [string]$rootRecord.CommandLine -or -not (Test-WheelRoot ([string]$freshRoot.CommandLine)) -or -not (Test-RuntimeMarker ([string]$freshRoot.CommandLine))){ return $false }; $currentPid=$listenerPid; for($depth=0; $depth -lt 12 -and $currentPid -gt 0; $depth++){ $process=Get-WheelProcess $currentPid; if($null -eq $process -or -not (Test-RuntimeMarker ([string]$process.CommandLine))){ return $false }; if([int]$process.ProcessId -eq [int]$rootRecord.ProcessId){ return ([int]$process.ParentProcessId -eq [int]$rootRecord.ParentProcessId -and [string]$process.CommandLine -eq [string]$rootRecord.CommandLine) }; $currentPid=[int]$process.ParentProcessId }; return $false }; $freeObservations=0; for($attempt=1; $attempt -le 20; $attempt++){ $occupied=$false; $restartDiscovery=$false; try { $allListeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop) } catch { Write-Host 'PORT_QUERY_FAILURE scope=all-listeners'; exit 42 }; foreach($port in $ports){ $listenerPids=@($allListeners | Where-Object { [int]$_.LocalPort -eq [int]$port } | Select-Object -ExpandProperty OwningProcess -Unique); if($listenerPids.Count -eq 0){ continue }; $occupied=$true; foreach($listenerPidValue in $listenerPids){ $listenerPid=[int]$listenerPidValue; $rootRecord=Find-WheelRuntimeRoot $listenerPid; if($null -eq $rootRecord){ Write-Host ('PORT_OCCUPIED_BY_UNVERIFIED_PROCESS port=' + $port + ' pid=' + $listenerPid); exit 42 }; try { $freshListeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop); $currentListenerPids=@($freshListeners | Where-Object { [int]$_.LocalPort -eq [int]$port } | Select-Object -ExpandProperty OwningProcess -Unique) } catch { Write-Host ('PORT_QUERY_FAILURE port=' + $port); exit 42 }; if($currentListenerPids -notcontains $listenerPid -or -not (Test-RuntimeChain $listenerPid $rootRecord)){ $restartDiscovery=$true; break }; Write-Host ('WHEEL_RESET_TERMINATED port=' + $port + ' listenerPid=' + $listenerPid + ' rootPid=' + $rootRecord.ProcessId + ' identity=highest-known-wheel-runtime-ancestor'); taskkill.exe /PID ([int]$rootRecord.ProcessId) /T /F | Out-Null; $restartDiscovery=$true; break }; if($restartDiscovery){ break } }; if($occupied -or $restartDiscovery){ $freeObservations=0; Start-Sleep -Milliseconds 500; continue }; $freeObservations++; if($freeObservations -ge 2){ Write-Host 'WHEEL_RESET_PASS stableFreeObservations=2'; exit 0 }; Start-Sleep -Milliseconds 500 }; Write-Host 'WHEEL_RESET_TIMEOUT maxAttempts=20'; exit 42"
exit /b %errorlevel%
