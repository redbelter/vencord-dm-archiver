# DMArchiver - Full Auto-Installer (PowerShell)
# This script will:
# 1. Clone Vencord from GitHub
# 2. Copy the dmArchiver plugin
# 3. Build Vencord
# 4. Prompt to install to Discord

$version = "1.6.0"
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  DMArchiver v$version - FULL AUTO" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# Step 1: Check for prerequisites
Write-Host "[1/5] Checking prerequisites..." -ForegroundColor Yellow

$hasGit = Get-Command git -ErrorAction SilentlyContinue
if (-not $hasGit) {
    Write-Host "[ERROR] Git not found!" -ForegroundColor Red
    Write-Host "Install Git from: https://git-scm.com/download"
    exit 1
}
Write-Host "[OK] Git found" -ForegroundColor Green

$hasNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $hasNode) {
    Write-Host "[ERROR] Node.js not found!" -ForegroundColor Red
    Write-Host "Install Node.js from: https://nodejs.org/"
    exit 1
}
Write-Host "[OK] Node.js found" -ForegroundColor Green

# Step 2: Find Vencord folder
Write-Host ""
Write-Host "[2/5] Finding Vencord..." -ForegroundColor Yellow

$discordAppData = "$env:APPDATA\Discord"
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match "^[0-9]+\.[0-9]+\." }

if (-not $versionFolders) {
    Write-Host "[ERROR] Vencord not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Vencord first from: https://vencord.dev/download/"
    exit 1
}

$latestVersion = ($versionFolders | Sort-Object Name -Descending | Select-Object -First 1).Name
$vencordFolder = Join-Path $discordAppData (Join-Path $latestVersion "modules\vencord")

Write-Host "[OK] Vencord found at: $vencordFolder" -ForegroundColor Green

# Step 3: Clone Vencord repo
Write-Host ""
Write-Host "[3/5] Cloning Vencord repo..." -ForegroundColor Yellow

$vencordSrcPath = "$env:TEMP\Vencord"

if (Test-Path $vencordSrcPath) {
    Write-Host "  Removing existing Vencord folder..." -ForegroundColor Yellow
    # Change directory first to avoid issues
    Set-Location -Path $env:TEMP
    Remove-Item -Recurse -Force $vencordSrcPath -ErrorAction SilentlyContinue
}

try {
    git clone --depth 1 https://github.com/Vendicated/Vencord.git $vencordSrcPath
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Failed to clone Vencord!" -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Vencord cloned successfully" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Failed to clone Vencord: $_" -ForegroundColor Red
    exit 1
}

# Step 4: Copy plugin to Vencord
Write-Host ""
Write-Host "[4/5] Copying dmArchiver plugin..." -ForegroundColor Yellow

# Find the source plugin folder (user's Vencord repo or the one we just cloned)
$pluginSource = Join-Path $vencordFolder "plugins\dmArchiver"

if (Test-Path $pluginSource) {
    $targetPluginDir = Join-Path $vencordSrcPath "src\plugins\dmArchiver"
    if (Test-Path $targetPluginDir) {
        Remove-Item -Recurse -Force $targetPluginDir
    }
    Copy-Item -Recurse -Force $pluginSource $targetPluginDir
    Write-Host "[OK] Plugin copied to Vencord" -ForegroundColor Green
} else {
    Write-Host "[WARNING] Plugin not found at expected location" -ForegroundColor Yellow
    Write-Host "  Running the one-liner first may help" -ForegroundColor Yellow
}

# Step 5: Build Vencord
Write-Host ""
Write-Host "[5/5] Building Vencord..." -ForegroundColor Yellow
Write-Host "  This may take a few minutes..." -ForegroundColor Yellow

cd $vencordSrcPath

# Install dependencies if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing dependencies..." -ForegroundColor Yellow
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Failed to install dependencies!" -ForegroundColor Red
        exit 1
    }
}

# Build Vencord
Write-Host "  Building Vencord..." -ForegroundColor Yellow
pnpm build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Build failed!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Try running manually:" -ForegroundColor Yellow
    Write-Host "  cd $vencordSrcPath" -ForegroundColor Gray
    Write-Host "  pnpm build" -ForegroundColor Gray
    exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  BUILD COMPLETE!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# Prompt to install to Discord
Write-Host ""
Write-Host "[5/5] Installing to Discord..." -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Close Discord completely (right-click taskbar icon > Quit)" -ForegroundColor White
Write-Host "2. Run the Vencord installer in: $vencordSrcPath\dist" -ForegroundColor White
Write-Host "3. Restart Discord" -ForegroundColor White
Write-Host "4. Check Settings > Vencord > Plugins for DMArchiver" -ForegroundColor White
Write-Host ""
Write-Host "When ready, press Enter to open the dist folder..."
Read-Host
Start-Process explorer.exe $vencordSrcPath\dist
Write-Host ""
Write-Host "Done!" -ForegroundColor Green
Write-Host ""