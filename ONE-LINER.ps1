# DMArchiver One-Liner Installer (PowerShell)
# Run: irm "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/ONE-LINER.ps1" | iex

$ErrorActionPreference = "Stop"

Write-Host "=== DMArchiver Quick Install ===" -ForegroundColor Cyan

# Check if Vencord source exists
$vencordSrc = "$env:USERPROFILE\Vencord"
if (-not (Test-Path "$vencordSrc\package.json")) {
    Write-Host "Cloning Vencord..." -ForegroundColor Yellow
    git clone --depth 1 https://github.com/Vendicated/Vencord.git "$vencordSrc"
}

# Copy plugin
$pluginSrc = "$vencordSrc\src\plugins\dmArchiver"
if (-not (Test-Path $pluginSrc)) { New-Item -ItemType Directory -Path $pluginSrc | Out-Null }
irm "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/index.ts" -OutFile "$pluginSrc\index.ts"
Write-Host "Plugin copied to $pluginSrc" -ForegroundColor Green

# Build
Write-Host "Building Vencord..." -ForegroundColor Yellow
cd $vencordSrc
pnpm install --frozen-lockfile
pnpm build

# Find Discord Vencord folder
$discordAppData = "$env:APPDATA\Discord"
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.' }
if (-not $versionFolders) {
    Write-Host "Discord not found in $discordAppData" -ForegroundColor Red
    exit 1
}
$latestVersion = ($versionFolders | Sort-Object Name -Descending | Select-Object -First 1).Name
$vencordDist = "$discordAppData\$latestVersion\modules\vencord\dist"
if (-not (Test-Path $vencordDist)) {
    Write-Host "Vencord dist folder not found at $vencordDist" -ForegroundColor Red
    Write-Host "Run Vencord installer first: https://vencord.dev/download" -ForegroundColor Yellow
    exit 1
}

# Copy built files
Write-Host "Installing to Discord..." -ForegroundColor Yellow
Copy-Item -Path "$vencordSrc\dist\*" -Destination $vencordDist -Force -Recurse

# Clear caches
Remove-Item -Path "$env:APPDATA\Discord\Cache", "$env:APPDATA\Discord\Code Cache", "$env:APPDATA\Discord\GPUCache" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "`n=== Done! Restart Discord ===" -ForegroundColor Green
Write-Host "Commands: /list-dm-users, /export-dm-media, /save-dm-text, /toggle-delete-commands" -ForegroundColor Cyan