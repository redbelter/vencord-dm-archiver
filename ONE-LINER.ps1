# DMArchiver One-Liner Installer (PowerShell)

```powershell
# Detect Discord version
$username = $env:USERNAME
$appSettings = "C:\Users\$username\AppData\Roaming\Discord\app-settings.json"
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

$pluginDir = "C:\Users\$username\AppData\Roaming\Discord\$discordVersion\modules\vencord\plugins\dmArchiver"

# Create plugin folder if needed
if (-not (Test-Path $pluginDir)) {
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null
}

Write-Host "Discord Version: $discordVersion" -ForegroundColor Green
Write-Host "Plugin Directory: $pluginDir" -ForegroundColor Green

# Download plugin files
$baseUrl = "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/src/plugins/dmArchiver"
irm "$baseUrl/index.ts" -OutFile (Join-Path $pluginDir "index.ts")
irm "$baseUrl/README.md" -OutFile (Join-Path $pluginDir "README.md")

Write-Host "Plugin installed successfully!" -ForegroundColor Green
Write-Host "Reload Discord or Vencord plugins to use the commands" -ForegroundColor Cyan
```