@echo off
echo ======================================================================
echo Starting Talk to Your PDFs (FastAPI + Cloudflare Public Tunnel)
echo ======================================================================

cd /d "%~dp0"

IF EXIST "%~dp0.env" (
    FOR /F "tokens=1,2 delims==" %%A IN ('type "%~dp0.env" ^| findstr /v "^#"') DO (
        IF "%%A"=="GEMINI_API_KEY" SET GEMINI_API_KEY=%%B
    )
)

IF "%GEMINI_API_KEY%"=="" (
    echo.
    echo WARNING: GEMINI_API_KEY environment variable is not set!
    echo Please set your key in .env or environment: set GEMINI_API_KEY=your_key_here
    echo.
) ELSE (
    echo [INFO] GEMINI_API_KEY loaded automatically from .env
)

SET PY_CMD=C:\Users\PB\AppData\Local\Programs\Python\Python311\python.exe
IF NOT EXIST "%PY_CMD%" (
    SET PY_CMD=python
)

echo [1/2] Launching Python FastAPI Backend on http://localhost:8000 ...
start "FastAPI Server" cmd /k "set GEMINI_API_KEY=%GEMINI_API_KEY% && cd backend && "%PY_CMD%" -m uvicorn main:app --host 0.0.0.0 --port 8000"

timeout /t 3 >nul

echo [2/2] Launching Cloudflare Public Tunnel ...
npx -y cloudflared tunnel --url http://localhost:8000
