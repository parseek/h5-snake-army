@echo off
REM One-click publish: probe -> commit -> push (origin + github) -> build Tauri.
REM
REM All the logic -- and all the Chinese output -- lives in scripts\publish.mjs.
REM Reason: cmd.exe reads a .bat file in the *console* codepage, so UTF-8 text
REM inside a batch file gets mangled and can even break its parsing.
REM Keep this file pure ASCII.
REM
REM   publish.bat -m "message"        probe + commit + push + build
REM   publish.bat -m "..." --skip-probe   skip the browser probe gate
REM   publish.bat -m "..." --no-build      commit and push only
REM   publish.bat --dry-run            print the plan, change nothing
REM   publish.bat --kill               close a running snake-army.exe without asking
REM   publish.bat                      no args: asks for a message, then waits for a key
cd /d "%~dp0"
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo [publish] Node.js not found in PATH.
  if "%~1"=="" pause
  exit /b 1
)
node "%~dp0scripts\publish.mjs" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" echo [publish] exited with code %RC%
REM double-clicked (no args) keeps the window open so the summary is readable
if "%~1"=="" pause
exit /b %RC%
