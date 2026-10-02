@echo off
setlocal
title Sundown Run II - Update
cd /d "%~dp0"

echo.
echo   SUNDOWN RUN II - UPDATE
echo   ====================================
echo.
echo   This makes this folder an exact copy of the latest version.
echo   Any changes you made to the game's files here are thrown away
echo   (that is the point - it is the do-over button).
echo.
echo   Tracks you drew in the game's editor live in your browser, so
echo   they are safe. Track files you dropped into the tracks folder
echo   yourself will be removed - export or copy them somewhere else first.
echo.
echo   Press any key to update, or close this window to cancel.
pause >nul

rem ---- git must exist ----
where git >nul 2>&1
if errorlevel 1 goto :noGit

echo.
echo   Downloading the latest version...
echo.
git fetch origin
if errorlevel 1 goto :fetchFail

rem ---- force-match this folder to the latest version ----
git reset --hard origin/main
if errorlevel 1 goto :resetFail

rem ---- sweep out NEW files that are not part of the game ----
rem reset --hard only restores files git knows about; this removes extras so the
rem folder is a perfect fresh copy. Ignored stuff (node_modules) is left alone.
git clean -fd

rem ---- refresh dependencies in case the update added any ----
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
if not defined RUNNER goto :done
echo.
echo   Updating dependencies...
call %RUNNER% install >nul 2>&1

:done
echo.
echo   ====================================
echo   All up to date! Start the game with "Sundown Run II.bat".
echo.
pause
exit /b 0


:noGit
echo   Could not find git on this computer.
echo.
echo   Install it from https://git-scm.com (all the default options are fine),
echo   then run this file again.
echo.
pause
exit /b 1

:fetchFail
echo.
echo   Could not reach the internet (or the server is being slow).
echo   Check the connection, then run this file again.
echo.
pause
exit /b 1

:resetFail
echo.
echo   The download worked but applying it failed. Ask Dad.
echo.
pause
exit /b 1
