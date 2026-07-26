# DMArchiver - One-Command Installer (PowerShell)

$version = "1.4.0"
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  DMArchiver v$version - ONE COMMAND" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# Step 1: Check Vencord
$discordAppData = "$env:APPDATA\Discord"
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match "^[0-9]+\.[0-9]+\." }

if (-not $versionFolders) {
    Write-Host "[ERROR] Vencord not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "1. Install Vencord: https://vencord.dev/download/" -ForegroundColor Yellow
    exit 1
}

$vencordFolder = Join-Path $discordAppData (Join-Path ($versionFolders | Sort-Object Name -Descending | Select-Object -First 1).Name "modules\vencord")
if (-not (Test-Path $vencordFolder)) {
    Write-Host "[ERROR] Vencord not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "1. Install Vencord: https://vencord.dev/download/" -ForegroundColor Yellow
    exit 1
}

Write-Host "[1/3] Vencord found: $vencordFolder" -ForegroundColor Green

# Step 2: Create plugin folder
$pluginDir = Join-Path $vencordFolder "src\\plugins\\dmArchiver"
if (-not (Test-Path $pluginDir)) {
    Write-Host "[2/3] Creating plugin folder..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
} else {
    Write-Host "[2/3] Plugin folder exists" -ForegroundColor Green
}

# Step 3: Download plugin files
Write-Host "[3/3] Downloading plugin..." -ForegroundColor Yellow
$baseUrl = "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master"
try {
    irm "$baseUrl/index.ts" -OutFile (Join-Path $pluginDir "index.ts")
    irm "$baseUrl/README.md" -OutFile (Join-Path $pluginDir "README.md")
} catch {
    Write-Host "[ERROR] Failed to download plugin!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Check your internet connection and try again." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  PLUGIN DOWNLOADED SUCCESSFULLY!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "NEXT: Build Vencord with this plugin:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  git clone https://github.com/Vendicated/Vencord.git" -ForegroundColor Gray
Write-Host "  cd Vencord" -ForegroundColor Gray
Write-Host "  pnpm build" -ForegroundColor Gray
Write-Host ""
Write-Host "Then install to Discord and restart!" -ForegroundColor Green
Write-Host ""