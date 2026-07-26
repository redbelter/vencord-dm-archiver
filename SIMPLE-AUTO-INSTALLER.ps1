# DMArchiver - Simple Auto-Installer (PowerShell)
# This script will:
# 1. Download and run VencordInstaller.exe
# 2. Install Vencord to Discord
# 3. Copy the dmArchiver plugin

$version = "1.7.0"
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  DMArchiver v$version - SIMPLE AUTO" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# Step 1: Download and run VencordInstaller
Write-Host "[1/3] Installing Vencord..." -ForegroundColor Yellow

$installerUrl = "https://github.com/Vencord/Installer/releases/latest/download/VencordInstaller.exe"
$installerPath = "$env:TEMP\VencordInstaller.exe"

Write-Host "  Downloading VencordInstaller.exe..." -ForegroundColor Yellow
irm $installerUrl -OutFile $installerPath

Write-Host "  Running VencordInstaller.exe..." -ForegroundColor Yellow
Write-Host "  Follow the prompts and select your Discord installation" -ForegroundColor Cyan
Write-Host ""
Start-Process $installerPath -Wait

Write-Host ""
Write-Host "[OK] Vencord installed!" -ForegroundColor Green

# Step 2: Find the Discord version folder
Write-Host ""
Write-Host "[2/3] Finding Discord version..." -ForegroundColor Yellow

$discordAppData = "$env:APPDATA\Discord"
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match "^[0-9]+\.[0-9]+\." }

if (-not $versionFolders) {
    Write-Host "[ERROR] Discord not found!" -ForegroundColor Red
    exit 1
}

$latestVersion = ($versionFolders | Sort-Object Name -Descending | Select-Object -First 1).Name
$vencordFolder = Join-Path $discordAppData (Join-Path $latestVersion "modules\vencord")

Write-Host "[OK] Found Discord $latestVersion" -ForegroundColor Green
Write-Host "  Vencord at: $vencordFolder" -ForegroundColor Green

# Step 3: Copy plugin
Write-Host ""
Write-Host "[3/3] Installing DMArchiver plugin..." -ForegroundColor Yellow

$pluginSource = Join-Path $vencordFolder "plugins\dmArchiver"

if (Test-Path $pluginSource) {
    Write-Host "  Plugin folder found!" -ForegroundColor Green
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  DONE! Plugin already installed" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "1. Close Discord completely" -ForegroundColor White
    Write-Host "2. Restart Discord" -ForegroundColor White
    Write-Host "3. Check Settings > Vencord > Plugins for DMArchiver" -ForegroundColor White
    Write-Host ""
    exit 0
} else {
    Write-Host "[WARNING] Plugin not found" -ForegroundColor Yellow
    Write-Host "  Please run the one-liner first to download the plugin" -ForegroundColor Yellow
    Write-Host ""
    Write-Host " irm https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/ONE-LINER.ps1 -OutFile `$env:TEMP\dmArchiver.ps1; & `$env:TEMP\dmArchiver.ps1" -ForegroundColor Cyan
    Write-Host ""
    exit 1
}