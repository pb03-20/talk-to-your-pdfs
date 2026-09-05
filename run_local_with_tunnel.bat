@echo off
echo ======================================================================
echo Starting Talk to Your PDFs (FastAPI + Cloudflare Public Tunnel)
echo ======================================================================

IF "%GEMINI_API_KEY%"=="" (
    echo.
    echo WARNING: GEMINI_API_KEY environment variable is not set!
    echo Please set your key first: set GEMINI_API_KEY=your_key_here
    echo.
)

cd /d "%~dp0"

echo [1/2] Launching Python FastAPI Backend on http://localhost:8000 ...
start "FastAPI Server" cmd /k "cd backend && python -m uvicorn main:app --host 0.0.0.0 --port 8000"

timeout /t 3 >nul

echo [2/2] Launching Cloudflare Public Tunnel ...
npx cloudflared tunnel --url http://localhost:8000
