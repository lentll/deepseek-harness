@echo off
rem Sync the local working copy into this git repo, commit, and push.
rem
rem The working copy stays at the path below; this directory only carries what
rem GitHub needs. All messages stay ASCII: a batch file with multibyte text is
rem parsed with the active OEM codepage and can break lines apart.
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Push portable sources to GitHub

set "SRC=F:\WorkBuddyData\workspace\2026-11-05-13-00-09\deepseek-harness-portable"
if not exist "%SRC%\src\main.js" goto no_src
if not exist ".git" goto no_repo

echo [1/3] syncing sources from %SRC%
robocopy "%SRC%\src" "portable\src" /E /NFL /NDL /NJH /NJS /NP >nul
if %ERRORLEVEL% GEQ 8 goto fail_copy
robocopy "%SRC%\scripts" "portable\scripts" /E /NFL /NDL /NJH /NJS /NP >nul
if %ERRORLEVEL% GEQ 8 goto fail_copy
copy /Y "%SRC%\package.json" "portable\package.json" >nul
copy /Y "%SRC%\package-lock.json" "portable\package-lock.json" >nul
copy /Y "%SRC%\README.md" "portable\README.md" >nul
copy /Y "%SRC%\一键更新.cmd" "portable\一键更新.cmd" >nul
copy /Y "%SRC%\build\icon.ico" "portable\build\icon.ico" >nul

echo [2/3] committing
git add -A
git diff --cached --quiet
if errorlevel 1 (
  git commit -q -m "chore(portable): sync sources from local working copy"
  if errorlevel 1 goto fail_git
  git --no-pager show --stat --oneline HEAD | more +0
) else (
  echo       nothing changed
)

echo [3/3] pushing protable
git push origin protable
if errorlevel 1 goto fail_git

echo.
echo [DONE] pushed. GitHub Actions rebuilds the release when it is enabled.
echo.
goto end

:no_src
echo [ERROR] working copy not found: %SRC%
goto end

:no_repo
echo [ERROR] this folder is not a git repository.
goto end

:fail_copy
echo [ERROR] copy step failed with %ERRORLEVEL%
goto end

:fail_git
echo [ERROR] git step failed. Check the output above.
goto end

:end
echo.
pause
exit /b %ERRORLEVEL%
