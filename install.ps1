# DMArchiver Installer
# Simple PowerShell script to install DMArchiver to Vencord

$ErrorActionPreference = "Stop"

# Configuration
$VENCORD_USER = $env:USERNAME  # Current Windows username
$PLUGIN_NAME = "dmArchiver"
$REPO_URL = "https://github.com/redbelter/vencord-dm-archiver"
$PLUGIN_DIR = "C:\Users\$VENCORD_USER\AppData\Roaming\Discord\0.0.XXX\modules\vencord\plugins\$PLUGIN_NAME"

Write-Host "=== DMArchiver Installer ===" -ForegroundColor Cyan
Write-Host ""

# Check if Discord is running
$discordProcess = Get-Process -Name "Discord*" -ErrorAction SilentlyContinue
if ($discordProcess) {
    Write-Warning "Discord is running. Please close Discord before installing plugins."
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Find Discord version
$discordPaths = @(
    "C:\Users\$VENCORD_USER\AppData\Roaming\Discord",
    "C:\Users\$VENCORD_USER\AppData\Local\Discord",
    "C:\Program Files\Discord",
    "C:\Program Files (x86)\Discord"
)

$discordVersion = $null
$discordRoot = $null

foreach ($baseDir in $discordPaths) {
    if (Test-Path $baseDir) {
        # Try to find the modules folder
        $modulesDir = Join-Path $baseDir "modules"
        if (Test-Path $modulesDir) {
            # Find the vencord plugins folder
            $vencordDir = Join-Path $modulesDir "vencord"
            if (Test-Path $vencordDir) {
                $discordVersion = "0.0.XXX"  # Will be updated
                $discordRoot = $vencordDir
                break
            }
        }
    }
}

# Find Discord version from app settings
$appSettings = "C:\Users\$VENCORD_USER\AppData\Roaming\Discord\app-settings.json"
if (Test-Path $appSettings) {
    try {
        $settings = Get-Content $appSettings -Raw | ConvertFrom-Json
        if ($settings.version) {
            $discordVersion = $settings.version
        }
    } catch {
        Write-Host "Could not read Discord version from settings, using default" -ForegroundColor Yellow
    }
}

if (-not $discordVersion) {
    $discordVersion = "0.0.XXX"
}

# Construct plugin path
$PLUGIN_DIR = "C:\Users\$VENCORD_USER\AppData\Roaming\Discord\$discordVersion\modules\vencord\plugins\$PLUGIN_NAME"

Write-Host "Discord Version: $discordVersion" -ForegroundColor Green
Write-Host "Plugin Directory: $PLUGIN_DIR" -ForegroundColor Green
Write-Host ""

# Check if Vencord plugins directory exists
if (-not (Test-Path $PLUGIN_DIR)) {
    Write-Host "Creating plugin directory..." -ForegroundColor Yellow
    try {
        New-Item -ItemType Directory -Path $PLUGIN_DIR -Force | Out-Null
    } catch {
        Write-Host "Error creating plugin directory: $_" -ForegroundColor Red
        Write-Host "Press any key to exit..."
        $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
        exit 1
    }
}

# Download the plugin from GitHub
$zipUrl = "https://github.com/redbelter/vencord-dm-archiver/archive/refs/heads/master.zip"
$zipPath = [System.IO.Path]::GetTempPath() + "dmArchiver-master.zip"

Write-Host "Downloading plugin from GitHub..." -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
} catch {
    Write-Host "Error downloading plugin: $_" -ForegroundColor Red
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Extract the plugin
Write-Host "Extracting plugin..." -ForegroundColor Cyan
$extractDir = [System.IO.Path]::GetTempPath() + "dmArchiver-extract"
if (Test-Path $extractDir) {
    Remove-Item -Path $extractDir -Recurse -Force
}
New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

try {
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
} catch {
    Write-Host "Error extracting plugin: $_" -ForegroundColor Red
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Find the plugin folder in the extracted archive
$sourceDir = Join-Path $extractDir "vencord-dm-archiver-master"
if (-not (Test-Path $sourceDir)) {
    # Try alternative folder name
    $sourceDir = Join-Path $extractDir "vencord-dm-archiver-master\src\plugins\dmArchiver"
    if (-not (Test-Path $sourceDir)) {
        $sourceDir = $extractDir
    }
}

# Copy plugin files
Write-Host "Installing plugin..." -ForegroundColor Cyan
try {
    Copy-Item -Path (Join-Path $sourceDir "index.ts") -Destination (Join-Path $PLUGIN_DIR "index.ts") -Force
    Copy-Item -Path (Join-Path $sourceDir "README.md") -Destination (Join-Path $PLUGIN_DIR "README.md") -Force
    Write-Host "Plugin installed successfully!" -ForegroundColor Green
} catch {
    Write-Host "Error installing plugin: $_" -ForegroundColor Red
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Clean up
Remove-Item -Path $zipPath -Force
Remove-Item -Path $extractDir -Recurse -Force

Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Open Discord"
Write-Host "2. Go to Settings > Vencord > Reload Plugins"
Write-Host "3. Or just restart Discord"
Write-Host ""
Write-Host "You can now use the following commands:"
Write-Host "  /list-dm-users"
Write-Host "  /export-dm-media"
Write-Host "  /save-dm-text"
Write-Host "  /toggle-delete-commands"
Write-Host ""

Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")