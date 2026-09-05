Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Starting Talk to Your PDFs (FastAPI + Cloudflare Public Tunnel)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Check .env file
$envFile = Join-Path $scriptDir ".env"
if (Test-Path $envFile) {
    Write-Host "✓ .env file detected (API key will be loaded automatically by FastAPI)" -ForegroundColor Green
} else {
    Write-Host "`nWARNING: .env file not found in project root!" -ForegroundColor Yellow
}

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

$backendPath = Join-Path $scriptDir "backend"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$backendPath'; & '$pythonCmd' -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

Start-Sleep -Seconds 3

Write-Host "[2/2] Launching Cloudflare Tunnel for public HTTPS link ..." -ForegroundColor Green
npx -y cloudflared tunnel --url http://localhost:8000
