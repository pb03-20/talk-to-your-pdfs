Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Starting Talk to Your PDFs (FastAPI + Cloudflare Public Tunnel)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# Load .env file automatically if present
$envFile = Join-Path $scriptDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)\s*=\s*(.*)\s*$') {
            $k = $matches[1].Trim()
            $v = $matches[2].Trim().Trim('"').Trim("'")
            [Environment]::SetEnvironmentVariable($k, $v, "Process")
            Set-Item -Path "env:$k" -Value $v
        }
    }
}

if ($env:GEMINI_API_KEY) {
    Write-Host "✓ GEMINI_API_KEY loaded automatically from .env" -ForegroundColor Green
} else {
    Write-Host "`nWARNING: GEMINI_API_KEY is not set in environment or .env!" -ForegroundColor Yellow
    Write-Host "Please set your key in .env or PowerShell: `$env:GEMINI_API_KEY='your_api_key'`n" -ForegroundColor Yellow
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
$apiKey = $env:GEMINI_API_KEY
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:GEMINI_API_KEY='$apiKey'; cd '$scriptDir\backend'; & '$pythonCmd' -m uvicorn main:app --host 0.0.0.0 --port 8000"

Start-Sleep -Seconds 3

Write-Host "[2/2] Launching Cloudflare Tunnel for public HTTPS link ..." -ForegroundColor Green
npx cloudflared tunnel --url http://localhost:8000
