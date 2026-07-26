# DMArchiver One-Liner Installer (PowerShell)

# Find Discord version folder and check for Vencord
$discordAppData = "$env:APPDATA\Discord"

# Get all Discord version folders
$versionFolders = Get-ChildItem -Path $discordAppData -Directory | Where-Object { $_.Name -match "^[0-9]+\.[0-9]+\.[0-9]+" }

if (-not $versionFolders) {
    Write-Host "No Discord version folders found!" -ForegroundColor Red
    Write-Host "Please make sure Discord is installed and run this script again."
    exit 1
}

# Find the latest version folder (highest version number)
$versionFolder = $versionFolders | Sort-Object Name -Descending | Select-Object -First 1
$latestVersion = $versionFolder.Name

Write-Host "Latest Discord version folder: $latestVersion" -ForegroundColor Cyan
Write-Host ""

# Look for Vencord in ANY version folder (not just latest)
$vencordFolder = $null
$foundVersion = $null

foreach ($folder in $versionFolders) {
    $testPath = Join-Path $discordAppData (Join-Path $folder.Name "modules\vencord")
    if (Test-Path $testPath) {
        $vencordFolder = $testPath
        $foundVersion = $folder.Name
        break
    }
}

if (-not $vencordFolder) {
    Write-Host "Vencord not found in any Discord version folder!" -ForegroundColor Red
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

Write-Host "Discord Version: $latestVersion" -ForegroundColor Green
Write-Host "Vencord found at: $vencordFolder" -ForegroundColor Green

# Create plugin folder in the LATEST version (where Discord is actually running)
$pluginDir = Join-Path $discordAppData (Join-Path $latestVersion "modules\vencord\plugins\dmArchiver")
if (-not (Test-Path $pluginDir)) {
    Write-Host "Creating plugin directory in latest version folder..." -ForegroundColor Yellow
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