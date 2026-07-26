# DMArchiver - Full Auto-Installer (PowerShell)
# This script will:
# 1. Auto-close Discord
# 2. Clone Vencord from GitHub
# 3. Copy the dmArchiver plugin from source repo
# 4. Build Vencord with pnpm
# 5. Replace Discord's Vencord with the built version

$version = "2.15.0"
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  DMArchiver v$version - FULL AUTO" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# Step 1: Check for Vencord installation
Write-Host "[1/9] Checking for Vencord..." -ForegroundColor Yellow

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

# Step 2: Auto-close Discord
Write-Host ""
Write-Host "[2/9] Closing Discord..." -ForegroundColor Yellow

$discordProcesses = Get-Process -Name discord, discordcanary, discordptb -ErrorAction SilentlyContinue
if ($discordProcesses) {
    Write-Host "  Found Discord processes:" -ForegroundColor Yellow
    $discordProcesses | ForEach-Object { Write-Host "    $($_.ProcessName) ($($_.Id))" -ForegroundColor Cyan }
    Write-Host "  Closing Discord..." -ForegroundColor Yellow
    $discordProcesses | Stop-Process -Force
    Start-Sleep -Seconds 3
    Write-Host "[OK] Discord closed" -ForegroundColor Green
} else {
    Write-Host "[OK] Discord not running" -ForegroundColor Green
}

# Step 3: Clone Vencord repo
Write-Host ""
Write-Host "[3/9] Cloning Vencord..." -ForegroundColor Yellow

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

# Step 4: Copy plugin from source repo to Vencord source
Write-Host ""
Write-Host "[4/9] Copying plugin from source repo..." -ForegroundColor Yellow

# Use the plugin from the source repo (not Discord's outdated version)
$sourcePluginPath = "C:\Users\red\Vencord\src\plugins\dmArchiver"
$targetPluginDir = Join-Path $vencordSrcPath "src\plugins\dmArchiver"

if (-not (Test-Path $sourcePluginPath)) {
    Write-Host "[ERROR] Plugin source not found at: $sourcePluginPath" -ForegroundColor Red
    exit 1
}

if (Test-Path $targetPluginDir) {
    Remove-Item -Recurse -Force $targetPluginDir
}

Copy-Item -Recurse -Force $sourcePluginPath $targetPluginDir
Write-Host "[OK] Plugin copied from source repo" -ForegroundColor Green

# Step 5: Build Vencord
Write-Host ""
Write-Host "[5/9] Building Vencord..." -ForegroundColor Yellow
cd $vencordSrcPath
pnpm install --frozen-lockfile
pnpm build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Build failed!" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Vencord built!" -ForegroundColor Green

# Step 6: Replace Discord's Vencord
Write-Host ""
Write-Host "[6/9] Replacing Discord's Vencord..." -ForegroundColor Yellow

$backupPath = "$vencordFolder.original"
if (-not (Test-Path $backupPath)) {
    Rename-Item $vencordFolder $backupPath
}

# Copy src/plugins (so Vencord can find plugins at runtime)
Copy-Item -Recurse -Force (Join-Path $vencordSrcPath "src\plugins\*") (Join-Path $vencordFolder "src\plugins")
# Copy dist (compiled files)
$distSrc = Join-Path $vencordSrcPath "dist"
$distDest = $vencordFolder
Get-ChildItem $distSrc -File | Copy-Item -Destination $distDest -Force

Write-Host "[OK] Discord's Vencord replaced!" -ForegroundColor Green

# Step 7: Wait for file system to sync
Write-Host ""
Write-Host "[7/9] Waiting for file sync..." -ForegroundColor Yellow
Start-Sleep -Seconds 3
Write-Host "[OK] Files synced" -ForegroundColor Green

# Step 8: Verify plugin is in built Vencord
Write-Host ""
Write-Host "[8/9] Verifying build..." -ForegroundColor Yellow

$rendererFile = Join-Path $vencordFolder "vencordDesktopRenderer.js"
if (Test-Path $rendererFile) {
    $hasPlugin = Get-Content $rendererFile | Select-String -Pattern "DMArchiver" -Quiet
    if ($hasPlugin) {
        Write-Host "[OK] Plugin found in built Vencord!" -ForegroundColor Green
    } else {
        Write-Host "[WARNING] Plugin not found in built Vencord" -ForegroundColor Yellow
    }
} else {
    Write-Host "[WARNING] Could not verify plugin in built Vencord" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  DONE! Restart Discord" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Check Settings > Vencord > Plugins for DMArchiver" -ForegroundColor White
Write-Host ""

# Step 9: Open Discord
Write-Host ""
Read-Host "Press Enter to open Discord..."
$discordPath = "$env:LOCALAPPDATA\Discord\app-1.0.9249\Discord.exe"
if (Test-Path $discordPath) {
    Start-Process $discordPath
} else {
    Start-Process "explorer.exe" "shell:appsFolder\4693710e-302d-4bec-8bcd-c6e1699a4326!Discord"
}

# Step 10: Wait for Discord to start and check logs
$scriptLogPath = "$env:TEMP\dmArchiver-install.log"
Write-Host ""
Write-Host "Checking Discord logs for plugin..." -ForegroundColor Yellow
Start-Sleep -Seconds 10

$logPath = "$env:APPDATA\Discord\logs\renderer_js.log"
if (Test-Path $logPath) {
    $pluginLines = Get-Content $logPath | Select-String "Starting plugin DMArchiver"
    if ($pluginLines) {
        Write-Host "[OK] Plugin found in Discord logs!" -ForegroundColor Green
        Write-Host "  Plugin loaded successfully!" -ForegroundColor Green
        $pluginLines | Out-File -FilePath $scriptLogPath -Append
    } else {
        Write-Host "[INFO] Plugin not found in logs yet" -ForegroundColor Yellow
        Write-Host "  Check Settings > Vencord > Plugins to see if it's listed" -ForegroundColor Cyan
        "[INFO] Plugin not found in Discord logs at $(Get-Date)" | Out-File -FilePath $scriptLogPath -Append
    }
} else {
    Write-Host "[INFO] Could not find Discord logs" -ForegroundColor Yellow
    "[INFO] Could not find Discord logs at $(Get-Date)" | Out-File -FilePath $scriptLogPath -Append
}

Write-Host ""
Write-Host "Log saved to: $scriptLogPath" -ForegroundColor Cyan
Write-Host ""