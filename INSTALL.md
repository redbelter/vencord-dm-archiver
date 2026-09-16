# Vencord Build Setup for DMArchiver

This guide shows how to build Vencord with DMArchiver plugin included.

## Prerequisites

- Git
- Node.js 18+ and pnpm (`npm install -g pnpm`)

## Steps

### 1. Clone Vencord

```powershell
cd ~
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
```

### 2. Install dependencies

```powershell
pnpm install
```

### 3. Create userplugins folder

```powershell
mkdir src\userplugins
```

### 4. Copy or symlink the plugin

Option A - Copy:
```powershell
# Copy the plugin folder from your working directory
xcopy "C:\Users\red\Desktop\code\decode\dmArchiver\*" "src\plugins\dmArchiver\" /E /I /Y
```

Option B - Symlink (Windows):
```powershell
# Create a junction/symlink
cd src\plugins
mklink /J dmArchiver "C:\Users\red\Vencord\src\plugins\dmArchiver"
```

### 5. Build Vencord

```powershell
pnpm build
```

### 6. Install built Vencord to Discord

1. Close Discord completely
2. Run the Vencord installer (should be in `dist/` or follow Vencord's installation instructions)
3. Restart Discord

### 7. Verify plugin

Go to Settings > Vencord > Plugins and look for "DMArchiver"

## Commands Available

After building, restart Discord and use:
- `/list-dm-users` - List all DM users
- `/export-dm-media` - Export media from current DM
- `/save-dm-text` - Save DM text
- `/toggle-delete-commands` - Enable/disable delete commands
- `/delete-dm-messages` - Delete own messages
- `/delete-all-my-messages` - Delete all own messages