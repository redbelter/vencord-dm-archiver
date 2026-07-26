# DMArchiver One-Liner Installer (PowerShell)

# Check if Vencord is installed
$discordAppData = "$env:APPDATA\Discord"
$modulesFolder = "$discordAppData\modules"
$vencordFolder = "$modulesFolder\vencord"

if (-not (Test-Path $modulesFolder)) {
    Write-Host "Vencord not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Vencord first:" -ForegroundColor Yellow
    Write-Host "1. Download Vencord Installer: https://github.com/Vendicated/Vencord/releases/latest"
    Write-Host "2. Run the installer (VencordInstaller.exe)"
    Write-Host "3. Restart Discord"
    Write-Host ""
    Write-Host "Then run this installer again."
    exit 1
}

if (-not (Test-Path $vencordFolder)) {
    Write-Host "Vencord modules folder not found!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please reinstall Vencord via the installer."
    Write-Host "Download: https://github.com/Vendicated/Vencord/releases/latest"
    exit 1
}

Write-Host "Vencord found at: $vencordFolder" -ForegroundColor Green

# Detect Discord version
$username = $env:USERNAME
$appSettings = "$env:APPDATA\Discord\app-settings.json"
$discordVersion = "0.0.XXX"

if (Test-Path $appSettings) {
    try {
        $settings = Get-Content $appSettings -Raw | ConvertFrom-Json
        if ($settings.version) {
            $discordVersion = $settings.version
        }
    } catch {
        Write-Host "Could not read Discord version" -ForegroundColor Yellow
    }
}

$pluginDir = "$env:APPDATA\Discord\$discordVersion\modules\vencord\plugins\dmArchiver"

# Create plugin folder if needed
if (-not (Test-Path $pluginDir)) {
    Write-Host "Creating plugin directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
}

Write-Host "Discord Version: $discordVersion" -ForegroundColor Green
Write-Host "Plugin Directory: $pluginDir" -ForegroundColor Green

# Download plugin files (from repo root)
$baseUrl = "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master"
irm "$baseUrl/index.ts" -OutFile (Join-Path $pluginDir "index.ts") -ErrorVariable downloadError
irm "$baseUrl/README.md" -OutFile (Join-Path $pluginDir "README.md")

if ($downloadError) {
    Write-Host "Failed to download plugin files. Please check your internet connection." -ForegroundColor Red
    exit 1
}

Write-Host "Plugin installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Close Discord completely"
Write-Host "2. Restart Discord"
Write-Host "3. Or reload Vencord plugins: Settings > Vencord > Reload Plugins"
Write-Host ""
Write-Host "You can now use these commands:" -ForegroundColor Cyan
Write-Host "  /list-dm-users"
Write-Host "  /export-dm-media"
Write-Host "  /save-dm-text"
Write-Host "  /toggle-delete-commands"
Write-Host ""