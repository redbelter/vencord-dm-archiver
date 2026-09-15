# DMArchiver - Full Auto-Installer (PowerShell)
# This script will:
# 1. Auto-close Discord
# 2. Clone Vencord from GitHub
# 3. Copy the dmArchiver plugin from source repo
# 4. Build Vencord with pnpm
# 5. Replace Discord's Vencord with the built version

$version = "2.15.1"
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  DMArchiver v$version - FULL AUTO" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# Check if Discord is using app.asar (stable) - Vencord modules won't work
$discordAppData = "$env:APPDATA\Discord"
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match "^[0-9]+\.[0-9]+\." }

if ($versionFolders) {
    $latestVersion = ($versionFolders | Sort-Object Name -Descending | Select-Object -First 1).Name
    $discordExe = "$env:LOCALAPPDATA\Discord\app-$latestVersion\Discord.exe"
    
    if (Test-Path $discordExe) {
        # Check if Discord is using asar (stable) or modules folder (canary/dev)
        $asarPath = "$env:LOCALAPPDATA\Discord\app-$latestVersion\resources\app.asar"
        if (Test-Path $asarPath) {
            Write-Host "[WARNING] Discord uses app.asar - Vencord modules won't load!" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "Discord stable loads Vencord from app.asar, not modules/vencord/" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "To use Vencord with modules:" -ForegroundColor Cyan
            Write-Host "1. Download Discord Canary or Dev from https://discord.com/download" -ForegroundColor White
            Write-Host "2. Install Vencord to Discord Canary/Dev" -ForegroundColor White
            Write-Host "3. Run this installer again" -ForegroundColor White
            Write-Host ""
            Write-Host "Or install Vencord to current Discord (will be overwritten on update)" -ForegroundColor Yellow
            Write-Host ""
            
            $installAnyway = Read-Host "Install to stable Discord anyway? (Y/N)"
            if ($installAnyway -ne "Y") {
                Write-Host "[INFO] Installation cancelled" -ForegroundColor Yellow
                exit 0
            }
        }
    }
}

Write-Host ""

# Find the latest version folder
$latestVersion = ($versionFolders | Sort-Object Name -Descending | Select-Object -First 1).Name
$vencordFolder = Join-Path $discordAppData (Join-Path $latestVersion "modules\vencord")

if (-not (Test-Path $vencordFolder)) {
    Write-Host "[ERROR] Vencord not found!" -ForegroundColor Red
    Write-Host "Vencord is installed at: $vencordFolder" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Please install Vencord from: https://vencord.dev/download" -ForegroundColor Yellow
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