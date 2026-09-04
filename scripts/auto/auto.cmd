@echo off
REM OwnCord auto-loop launcher. Double-click to start; close the window to stop.
REM   auto.cmd            run it
REM   auto.cmd --dry-run  classify and print, launch nothing
REM   auto.cmd --once     a single tick, then exit
setlocal

set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not exist "%BASH%" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not exist "%BASH%" (
  echo Could not find Git Bash. Install Git for Windows, or edit the BASH path
  echo at the top of this file.
  pause
  exit /b 1
)

title OwnCord auto-loop
echo Starting the OwnCord auto-loop.
echo Stop it with Ctrl+C, or by closing this window.
echo.

"%BASH%" -lc "cd '%~dp0' && bash ./loop.sh %*"

echo.
echo The auto-loop has stopped.
pause
