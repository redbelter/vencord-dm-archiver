# DMArchiver - Full Auto-Installer (PowerShell)
# This script will:
# 1. Run VencordInstaller.exe
# 2. Copy the dmArchiver plugin
# 3. Restart Discord

$version = "1.8.0"
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  DMArchiver v$version - FULL AUTO" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# Step 1: Run VencordInstaller
Write-Host "[1/3] Installing Vencord..." -ForegroundColor Yellow

$installerUrl = "https://github.com/Vencord/Installer/releases/latest/download/VencordInstaller.exe"
$installerPath = "$env:TEMP\VencordInstaller.exe"

irm $installerUrl -OutFile $installerPath
Write-Host "  Running VencordInstaller.exe..." -ForegroundColor Yellow
Write-Host "  Click 'Install' on your Discord when prompted" -ForegroundColor Cyan
Start-Process $installerPath -Wait

Write-Host ""
Write-Host "[OK] Vencord installed!" -ForegroundColor Green

# Step 2: Find Discord version and copy plugin
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

# Step 3: Copy plugin
Write-Host ""
Write-Host "[3/3] Installing DMArchiver plugin..." -ForegroundColor Yellow

$pluginSource = Join-Path $vencordFolder "plugins\dmArchiver"

if (Test-Path $pluginSource) {
    Write-Host "[OK] Plugin folder found!" -ForegroundColor Green
} else {
    Write-Host "[WARNING] Plugin not found" -ForegroundColor Yellow
    Write-Host "  Running one-liner to download plugin..." -ForegroundColor Yellow
    irm "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/ONE-LINER.ps1" -OutFile "$env:TEMP\dmArchiver.ps1"; & "$env:TEMP\dmArchiver.ps1"
    Write-Host ""
    Write-Host "Plugin downloaded. Running installer again..." -ForegroundColor Green
    $pluginSource = Join-Path $vencordFolder "plugins\dmArchiver"
    
    if (-not (Test-Path $pluginSource)) {
        Write-Host "[ERROR] Plugin still not found!" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  DONE! All set!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "1. Close Discord completely" -ForegroundColor White
Write-Host "2. Restart Discord" -ForegroundColor White
Write-Host "3. Check Settings > Vencord > Plugins for DMArchiver" -ForegroundColor White
Write-Host ""

Read-Host "Press Enter to open Discord settings..."
Start-Process "explorer.exe" "shell:appsFolder\4693710e-302d-4bec-8bcd-c6e1699a4326!Discord"
Write-Host ""
Write-Host "Done!" -ForegroundColor Green