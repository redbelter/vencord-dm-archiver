# DMArchiver One-Liner Installer (PowerShell)

# Find Discord version folder and check for Vencord
$discordAppData = "$env:APPDATA\Discord"

# Get latest Discord version folder (matches versions like 0.0.XXX, 1.0.XXX, etc.)
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match "^[0-9]+\.[0-9]+\.[0-9]+" }
$versionFolder = $versionFolders | Sort-Object Name -Descending | Select-Object -First 1

if (-not $versionFolder) {
    Write-Host "Discord version folder not found!" -ForegroundColor Red
    Write-Host "Looking for folders matching pattern: 0.0.XXX, 1.0.XXX, etc."
    Write-Host "Available folders:"
    Get-ChildItem -Path $discordAppData -Directory | ForEach-Object { Write-Host "  - $($_.Name)" }
    Write-Host ""
    Write-Host "Please make sure Discord is installed and run this script again."
    exit 1
}

$discordVersion = $versionFolder.Name
$vencordFolder = "$discordAppData\$discordVersion\modules\vencord"

Write-Host "Discord Version: $discordVersion" -ForegroundColor Green
Write-Host "Checking for Vencord at: $vencordFolder" -ForegroundColor Cyan

if (-not (Test-Path $vencordFolder)) {
    Write-Host "Vencord not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Vencord first:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "1. Download Vencord for Windows:"
    Write-Host "   https://vencord.dev/download/#windows"
    Write-Host ""
    Write-Host "2. Run the installer"
    Write-Host "3. Restart Discord"
    Write-Host ""
    Write-Host "Then run this installer again."
    exit 1
}

Write-Host "Vencord found at: $vencordFolder" -ForegroundColor Green

# Create plugin folder
$pluginDir = "$vencordFolder\plugins\dmArchiver"
if (-not (Test-Path $pluginDir)) {
    Write-Host "Creating plugin directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
}

Write-Host "Plugin Directory: $pluginDir" -ForegroundColor Green

# Download plugin files (from repo root)
$baseUrl = "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master"
irm "$baseUrl/index.ts" -OutFile (Join-Path $pluginDir "index.ts") -ErrorVariable downloadError
irm "$baseUrl/README.md" -OutFile (Join-Path $pluginDir "README.md")

if ($downloadError) {
    Write-Host "Failed to download plugin files. Please check your internet connection." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Plugin installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Close Discord completely (Right-click taskbar icon > Quit)"
Write-Host "2. Restart Discord"
Write-Host "3. Or reload Vencord plugins: Settings > Vencord > Reload Plugins"
Write-Host ""
Write-Host "You should now see 'DMArchiver' in the plugin list" -ForegroundColor Green
Write-Host ""
Write-Host "Commands available:" -ForegroundColor Cyan
Write-Host "  /list-dm-users"
Write-Host "  /export-dm-media"
Write-Host "  /save-dm-text"
Write-Host "  /toggle-delete-commands"
Write-Host ""