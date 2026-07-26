# DMArchiver - Discord DM Media Exporter

A Vencord plugin to export and preserve DM content: media, images, and text history.

## ⚠️ Important: Vencord Must Be Built From Source

Vencord is a compiled Electron app - it doesn't support runtime plugin loading. You **must build Vencord from source** to use this plugin.

### Quick Start (Build Vencord)

1. Clone Vencord: `git clone https://github.com/Vendicated/Vencord.git`
2. Copy `dmArchiver` folder to `src/plugins/dmArchiver`
3. Run `pnpm build` in the Vencord folder
4. Install the built Vencord to Discord

**See [INSTALL.md](./INSTALL.md) for detailed steps.**

## Installation (After Building)

Once Vencord is built with this plugin:

1. Close Discord completely
2. Install the built Vencord to Discord
3. Restart Discord
4. Go to Settings > Vencord > Plugins > DMArchiver

## Commands

| Command | Description |
|---------|-------------|
| `/list-dm-users` | List all DM users (ID + username) for export |
| `/export-dm-media` | Export all media from current DM |
| `/save-dm-text` | Save DM text history to file |
| `/toggle-delete-commands` | Enable/disable delete commands |
| `/delete-dm-messages` | Delete your own messages (opt-in) |
| `/delete-all-my-messages` | Delete all your messages in current DM |

## Settings

- `showDeleteOption` - Enable/disable delete-related commands (disabled by default)

## PII Statement

This plugin does NOT collect or store personal data. All data is downloaded to your local machine only.

## About

This combines `dmMediaExporter` and `dmMessageDeleter` into one plugin, focusing on export as the primary feature with optional, opt-in deletion.