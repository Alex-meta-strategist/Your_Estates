@echo off
rem Lance Your Estates puis ouvre le navigateur. Fermez cette fenetre pour arreter l'application.
setlocal
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py %*
) else (
  py -3 server.py %*
)
if errorlevel 1 pause
