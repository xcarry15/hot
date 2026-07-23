@echo off
setlocal EnableExtensions
title Hot2 Local Initialization

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0local-init.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Initialization failed. Review the error above.
  pause
)

exit /b %EXIT_CODE%
