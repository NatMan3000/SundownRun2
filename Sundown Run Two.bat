@echo off
setlocal
title Sundown Run Two
cd /d "%~dp0"

echo.
echo   SUNDOWN RUN TWO
echo   ====================================
echo.

rem ---- find a runtime: prefer Bun, fall back to Node/npm ----
rem We call bun.exe / npm.cmd from this cmd window on purpose: PowerShell's
rem execution policy blocks their .ps1 shims, cmd does not care.
set "RUNNER="
where bun >nul 2>&1
if not errorlevel 1 set "RUNNER=bun"
if defined RUNNER goto :haveRunner
if exist "%USERPROFILE%\.bun\bin\bun.exe" (
  set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
  set "RUNNER=bun"
  goto :haveRunner
)
where npm >nul 2>&1
if not errorlevel 1 set "RUNNER=npm"
:haveRunner
if not defined RUNNER goto :noRuntime

echo   Bun / Node.js...               found %RUNNER%

rem ---- install dependencies on first run ----
if exist "node_modules\vite" goto :haveDeps
echo   Installing dependencies...     first run only, this takes a minute
echo.
call %RUNNER% install
if errorlevel 1 goto :installFail
echo.
goto :ready
:haveDeps
echo   Dependencies...                ready
:ready

echo.
echo   Starting the game. It opens in your browser at http://localhost:5201
echo.
echo   Edit  src\core\config.ts  and save - the game changes straight away.
echo   Game running slowly? Windows may be giving your browser the weak
echo   graphics chip. Fix: Settings, System, Display, Graphics, pick your
echo   browser, Options, High performance. (The README shows how to check.)
echo.
echo   Close this window to stop playing.
echo.

call %RUNNER% run start

echo.
echo   Sundown Run Two has stopped.
pause
exit /b 0


:noRuntime
echo   Could not find Bun or Node.js on this computer.
echo.
echo   Install ONE of these, then run this file again:
echo.
echo     Bun      - recommended, faster    https://bun.sh
echo     Node.js  - pick the LTS version   https://nodejs.org
echo.
pause
exit /b 1


:installFail
echo.
echo   Something went wrong installing the dependencies.
echo   Check your internet connection, then run this file again.
echo.
pause
exit /b 1
