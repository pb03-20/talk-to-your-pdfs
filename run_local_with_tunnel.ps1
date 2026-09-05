Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Starting Talk to Your PDFs (FastAPI + Cloudflare Public Tunnel)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

if (-not $env:GEMINI_API_KEY) {
    Write-Host "`nWARNING: GEMINI_API_KEY is not set!" -ForegroundColor Yellow
    Write-Host "Please set your key in PowerShell: `$env:GEMINI_API_KEY='your_api_key_here'`n" -ForegroundColor Yellow
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Find valid Python executable with uvicorn installed
$pythonCmd = "python"
$candidates = @(
    "C:\Users\PB\AppData\Local\Programs\Python\Python311\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
    "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
    "python"
)

foreach ($cand in $candidates) {
    if (Test-Path $cand) {
        $testRes = & $cand -c "import uvicorn; print('ok')" 2>$null
        if ($testRes -eq "ok") {
            $pythonCmd = $cand
            break
        }
    }
}

Write-Host "Using Python: $pythonCmd" -ForegroundColor Gray
Write-Host "[1/2] Launching Python FastAPI Server on http://localhost:8000 ..." -ForegroundColor Green
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$scriptDir\backend'; & '$pythonCmd' -m uvicorn main:app --host 0.0.0.0 --port 8000"

Start-Sleep -Seconds 3

Write-Host "[2/2] Launching Cloudflare Tunnel for public HTTPS link ..." -ForegroundColor Green
npx cloudflared tunnel --url http://localhost:8000
