@echo off
rem AI Ops Console demo v2.2 - one-click start (Windows)
rem Starts the data service (Python + SQLite) and serves the built UI.
cd /d "%~dp0"
set PORT=8090
set PY=python
where python >nul 2>nul || set PY=py
where %PY% >nul 2>nul
if errorlevel 1 (
  echo Python 3 not found. Install Python 3.9+ from python.org, then run again.
  pause
  exit /b 1
)
echo Starting data service: http://127.0.0.1:%PORT%
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:%PORT%"
%PY% server\server.py --port %PORT% --dist dist --db server\data\aiops.db
