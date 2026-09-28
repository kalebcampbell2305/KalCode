@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect-installed-identity.ps1" -ExpectedVersion 0.1.5
exit /b %ERRORLEVEL%
