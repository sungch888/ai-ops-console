@echo off
rem AI Operations Management Platform - demo launcher (Windows)
rem Uses Python when available, otherwise falls back to PowerShell (no install needed).
setlocal
cd /d "%~dp0"
set PY=
for %%P in (python3 python py) do (
  where %%P >nul 2>nul && if not defined PY (
    %%P -c "import http.server" >nul 2>nul && set PY=%%P
  )
)
if defined PY (
  "%PY%" serve.py
  exit /b 0
)
echo Python was not found on this PC. Starting with PowerShell instead...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
