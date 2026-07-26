# DMArchiver - Full Auto-Installer (PowerShell)
# This script will:
# 1. Clone Vencord from GitHub
# 2. Copy the dmArchiver plugin
# 3. Build Vencord with pnpm
# 4. Replace Discord's Vencord with the built version

$version = "2.0.0"
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  DMArchiver v$version - FULL AUTO" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# Step 1: Check for Vencord installation
Write-Host "[1/5] Checking for Vencord..." -ForegroundColor Yellow

$discordAppData = "$env:APPDATA\Discord"
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match "^[0-9]+\.[0-9]+\." }

if (-not $versionFolders) {
    Write-Host "[ERROR] Discord not found!" -ForegroundColor Red
    exit 1
}

$latestVersion = ($versionFolders | Sort-Object Name -Descending | Select-Object -First 1).Name
$vencordFolder = Join-Path $discordAppData (Join-Path $latestVersion "modules\vencord")

if (-not (Test-Path $vencordFolder)) {
    Write-Host "[ERROR] Vencord not found!" -ForegroundColor Red
    exit 1
}

Write-Host "[OK] Found Vencord at: $vencordFolder" -ForegroundColor Green

# Step 2: Clone Vencord repo
Write-Host ""
Write-Host "[2/5] Cloning Vencord..." -ForegroundColor Yellow

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
Write-Host "[OK] Vencord cloned" -ForegroundColor Green

# Step 3: Copy plugin to Vencord source
Write-Host ""
Write-Host "[3/5] Copying plugin..." -ForegroundColor Yellow

$targetPluginDir = Join-Path $vencordSrcPath "src\plugins\dmArchiver"
if (Test-Path $targetPluginDir) {
    Remove-Item -Recurse -Force $targetPluginDir
}
Copy-Item -Recurse -Force $vencordFolder\plugins\dmArchiver $targetPluginDir
Write-Host "[OK] Plugin copied" -ForegroundColor Green

# Step 4: Build Vencord
Write-Host ""
Write-Host "[4/5] Building Vencord..." -ForegroundColor Yellow
cd $vencordSrcPath
pnpm install --frozen-lockfile
pnpm build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Build failed!" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Vencord built!" -ForegroundColor Green

# Step 5: Replace Discord's Vencord
Write-Host ""
Write-Host "[5/5] Replacing Discord's Vencord..." -ForegroundColor Yellow

$backupPath = "$vencordFolder.original"
if (-not (Test-Path $backupPath)) {
    Rename-Item $vencordFolder $backupPath
}
Copy-Item -Recurse -Force (Join-Path $vencordSrcPath "dist") $vencordFolder
Write-Host "[OK] Discord's Vencord replaced!" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  DONE! Restart Discord" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Check Settings > Vencord > Plugins for DMArchiver" -ForegroundColor White