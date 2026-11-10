@echo off
rem Update the portable package in place. All Chinese messages come from
rem scripts\update.mjs: a batch file with multibyte characters is parsed with
rem the active OEM codepage and can break lines apart, so this wrapper stays
rem pure ASCII and only switches the console to UTF-8 for Node's output.
chcp 65001 >nul
title DeepSeek Harness Portable - Update
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0scripts\update.mjs" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" goto ok
if "%CODE%"=="2" goto warn
goto bad

:nonode
echo.
echo [ERROR] Node.js not found. Install Node.js 20+ from https://nodejs.org/
echo         then double-click this file again.
goto end

:ok
echo [OK] Rebuilt and re-signed. Double-click to start:
echo      %~d0\AI\deepseek-harness-portable\DeepSeek Harness.exe
goto end

:warn
echo [WARN] Rebuilt, but the file count under data changed. Check data\logs.
goto end

:bad
echo [FAILED] Update did not finish. See the output above.
goto end

:end
echo.
pause
exit /b %CODE%
