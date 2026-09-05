Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Starting Talk to Your PDFs (FastAPI + Cloudflare Public Tunnel)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

if (-not $env:GEMINI_API_KEY) {
    Write-Host "`nWARNING: GEMINI_API_KEY is not set!" -ForegroundColor Yellow
    Write-Host "Please set your key in PowerShell: `$env:GEMINI_API_KEY='your_api_key_here'`n" -ForegroundColor Yellow
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "[1/2] Launching Python FastAPI Server on http://localhost:8000 ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$scriptDir\backend'; python -m uvicorn main:app --host 0.0.0.0 --port 8000"

Start-Sleep -Seconds 3

Write-Host "[2/2] Launching Cloudflare Tunnel for public HTTPS link ..." -ForegroundColor Green
npx cloudflared tunnel --url http://localhost:8000
