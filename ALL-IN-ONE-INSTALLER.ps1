# DMArchiver - All-In-One Installer (PowerShell)

This script will:
1. Check if you have Vencord installed
2. Install ScattrdBlade's pluginRepo (if not already installed)
3. Install DMArchiver via the plugin repo

## Prerequisites

- Discord with Vencord installed
- Git installed
- Node.js 18+ and pnpm (`npm install -g pnpm`)

## Installation Steps

Run this in PowerShell:

```powershell
irm "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/ALL-IN-ONE-INSTALLER.ps1" -OutFile "$env:TEMP\dmArchiver-install.ps1"; & "$env:TEMP\dmArchiver-install.ps1"
```

## Manual Installation

If the one-liner doesn't work, follow these steps:

### Step 1: Install ScattrdBlade's pluginRepo (one-time setup)

```powershell
# Find Vencord src folder
$venPath = "$env:APPDATA\Discord\0.0.XXX\modules\vencord"
$srcPath = Split-Path $venPath
$pluginsPath = Join-Path $srcPath "userplugins"

# Create userplugins folder if needed
if (-not (Test-Path $pluginsPath)) {
    mkdir $pluginsPath -Force | Out-Null
}

# Clone pluginRepo
cd $pluginsPath
git clone https://github.com/ScattrdBlade/pluginRepo

# Rebuild Vencord
cd $srcPath
pnpm build
```

### Step 2: Restart Discord and Install DMArchiver

1. Close Discord completely
2. Restart Discord
3. Go to Settings > Vencord > Plugins
4. Find "Plugin Repo" in the plugin list
5. Click the repo tab
6. Search for "DMArchiver" and click Install

## Commands Available

- `/list-dm-users` - List all DM users
- `/export-dm-media` - Export media from current DM
- `/save-dm-text` - Save DM text
- `/toggle-delete-commands` - Enable/disable delete commands
- `/delete-dm-messages` - Delete own messages
- `/delete-all-my-messages` - Delete all own messages

## Troubleshooting

**"Vencord not found":** Make sure Vencord is installed via vencord.dev/download
**"pnpm not found":** Install pnpm: `npm install -g pnpm`
**"Git not found":** Install Git: https://git-scm.com/download