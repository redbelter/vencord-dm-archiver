# DMArchiver One-Liner Installer (PowerShell)

$version = "1.3.1"
Write-Host "DMArchiver Installer v$version" -ForegroundColor Yellow
Write-Host ""

# Find Discord version folder and check for Vencord
$discordAppData = "$env:APPDATA\Discord"

# Get all Discord version folders
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match "^[0-9]+\.[0-9]+\." }

if (-not $versionFolders) {
    Write-Host "No Discord version folders found!" -ForegroundColor Red
    Write-Host "Please install Discord and run this script again."
    exit 1
}

# Find the latest version folder
$versionFolder = $versionFolders | Sort-Object Name -Descending | Select-Object -First 1
$latestVersion = $versionFolder.Name

Write-Host "Discord Version: $latestVersion" -ForegroundColor Cyan
Write-Host ""

# Check if Vencord exists
$vencordFolder = Join-Path $discordAppData (Join-Path $latestVersion "modules\vencord")

if (-not (Test-Path $vencordFolder)) {
    Write-Host "Vencord not found in Discord's latest version folder!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Vencord is installed at: $vencordFolder"
    Write-Host ""
    Write-Host "Please install Vencord from: https://vencord.dev/download/#windows"
    Write-Host ""
    exit 1
}

Write-Host "Vencord found at: $vencordFolder" -ForegroundColor Green

# Create plugin folder
$pluginDir = Join-Path $vencordFolder "plugins\dmArchiver"
if (-not (Test-Path $pluginDir)) {
    Write-Host "Creating plugin directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
}

Write-Host "Plugin Directory: $pluginDir" -ForegroundColor Green

# Download plugin files with cache-busting headers
$baseUrl = "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master"
$headers = @{
    "Cache-Control" = "no-cache, no-store, must-revalidate"
    "Pragma" = "no-cache"
    "Expires" = "0"
}
irm "$baseUrl/index.ts" -Headers $headers -OutFile (Join-Path $pluginDir "index.ts")
irm "$baseUrl/README.md" -Headers $headers -OutFile (Join-Path $pluginDir "README.md")

Write-Host ""
Write-Host "Plugin files downloaded successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "To use this plugin, you must build Vencord from source:" -ForegroundColor Yellow
Write-Host ""
Write-Host "1. Clone Vencord: git clone https://github.com/Vendicated/Vencord.git" -ForegroundColor White
Write-Host "2. Copy dmArchiver folder to src/plugins/" -ForegroundColor White
Write-Host "3. Run: pnpm build" -ForegroundColor White
Write-Host "4. Install to Discord" -ForegroundColor White
Write-Host ""
Write-Host "See INSTALL.md for detailed instructions" -ForegroundColor Cyan
Write-Host ""