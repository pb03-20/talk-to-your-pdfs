@echo off
echo ======================================================================
echo Starting Talk to Your PDFs (FastAPI + Cloudflare Public Tunnel)
echo ======================================================================

cd /d "%~dp0"

IF EXIST "%~dp0.env" (
    echo [INFO] .env file detected. FastAPI backend will load API keys automatically.
) ELSE (
    echo [WARNING] .env file not found in project root!
)

SET PY_CMD=C:\Users\PB\AppData\Local\Programs\Python\Python311\python.exe
IF NOT EXIST "%PY_CMD%" (
    SET PY_CMD=python
)

echo [1/2] Launching Python FastAPI Backend on http://localhost:8000 ...
start "FastAPI Server" cmd /k "cd backend && "%PY_CMD%" -m uvicorn main:app --host 0.0.0.0 --port 8000"

timeout /t 3 >nul

echo [2/2] Launching Cloudflare Public Tunnel ...
npx -y cloudflared tunnel --url http://localhost:8000
