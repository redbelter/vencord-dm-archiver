# DMArchiver - Full Auto-Installer (PowerShell)
# This script will:
# 1. Clone Vencord repo
# 2. Copy the dmArchiver plugin
# 3. Build Vencord with pnpm
# 4. Replace Discord's Vencord with the built version

$version = "1.9.0"
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  DMArchiver v$version - FULL AUTO" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# Step 1: Check for Vencord installation
Write-Host "[1/4] Checking for Vencord..." -ForegroundColor Yellow

$discordAppData = "$env:APPDATA\Discord"
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match "^[0-9]+\.[0-9]+\." }

if (-not $versionFolders) {
    Write-Host "[ERROR] Discord not found!" -ForegroundColor Red
    Write-Host "Install Discord from https://discord.com/download" -ForegroundColor Yellow
    exit 1
}

$latestVersion = ($versionFolders | Sort-Object Name -Descending | Select-Object -First 1).Name
$vencordFolder = Join-Path $discordAppData (Join-Path $latestVersion "modules\vencord")

if (-not (Test-Path $vencordFolder)) {
    Write-Host "[ERROR] Vencord not found!" -ForegroundColor Red
    Write-Host "Install Vencord from https://vencord.dev/download" -ForegroundColor Yellow
    exit 1
}

Write-Host "[OK] Found Vencord at: $vencordFolder" -ForegroundColor Green

# Step 2: Clone Vencord repo
Write-Host ""
Write-Host "[2/4] Cloning Vencord repo..." -ForegroundColor Yellow

$vencordSrcPath = "$env:TEMP\Vencord"

if (Test-Path $vencordSrcPath) {
    Write-Host "  Removing existing Vencord folder..." -ForegroundColor Yellow
    Set-Location -Path $env:TEMP
    Remove-Item -Recurse -Force $vencordSrcPath -ErrorAction SilentlyContinue
}

git clone --depth 1 https://github.com/Vendicated/Vencord.git $vencordSrcPath
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Failed to clone Vencord!" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Vencord cloned successfully" -ForegroundColor Green

# Step 3: Copy plugin to Vencord source
Write-Host ""
Write-Host "[3/4] Copying dmArchiver plugin..." -ForegroundColor Yellow

$targetPluginDir = Join-Path $vencordSrcPath "src\plugins\dmArchiver"

if (Test-Path $targetPluginDir) {
    Remove-Item -Recurse -Force $targetPluginDir
}

Copy-Item -Recurse -Force $vencordFolder\plugins\dmArchiver $targetPluginDir
Write-Host "[OK] Plugin copied to Vencord" -ForegroundColor Green

# Step 4: Build Vencord
Write-Host ""
Write-Host "[4/4] Building Vencord..." -ForegroundColor Yellow
Write-Host "  This may take a few minutes..." -ForegroundColor Yellow

cd $vencordSrcPath

if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing dependencies..." -ForegroundColor Yellow
    pnpm install
}

Write-Host "  Building Vencord..." -ForegroundColor Yellow
pnpm build

if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Build failed!" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Vencord built successfully!" -ForegroundColor Green

# Step 5: Replace Discord's Vencord with built version
Write-Host ""
Write-Host "[5/5] Replacing Discord's Vencord..." -ForegroundColor Yellow

# Backup original Vencord
$backupPath = "$vencordFolder.original"
if (-not (Test-Path $backupPath)) {
    Rename-Item $vencordFolder $backupPath
}

# Copy built Vencord to Discord
Copy-Item -Recurse -Force (Join-Path $vencordSrcPath "dist") $vencordFolder
Write-Host "[OK] Discord's Vencord replaced!" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  DONE! All set!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "1. Close Discord completely" -ForegroundColor White
Write-Host "2. Restart Discord" -ForegroundColor White
Write-Host "3. Check Settings > Vencord > Plugins for DMArchiver" -ForegroundColor White
Write-Host ""

Read-Host "Press Enter to open Discord..."
Start-Process "explorer.exe" "shell:appsFolder\4693710e-302d-4bec-8bcd-c6e1699a4326!Discord"
Write-Host ""
Write-Host "Done!" -ForegroundColor Green