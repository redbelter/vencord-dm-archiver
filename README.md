# DMArchiver - Discord DM Media Exporter

A Vencord plugin to export and preserve DM content: media, images, and text history.

## Installation

### For Vencord Users (Pre-built Vencord)

If you're using the **pre-built Vencord** from vencord.dev, you need to build Vencord from source with this plugin included:

1. Clone the Vencord repo
2. Copy the `dmArchiver` folder to `src/plugins/dmArchiver`
3. Build Vencord with `pnpm build`
4. Install the built Vencord to Discord

### For Vencord Devs (Building from Source)

1. Clone Vencord: `git clone https://github.com/Vendicated/Vencord.git`
2. Copy the `dmArchiver` folder to `src/plugins/`
3. Run `pnpm install` then `pnpm build`
4. The plugin will be compiled into Vencord

### Commands

- `/list-dm-users` - List all DM users available for export (ID + username)
- `/export-dm-media` - Export all media from current DM conversation
- `/save-dm-text` - Save DM text history to file
- `/toggle-delete-commands` - Enable/disable delete-related commands
- `/delete-dm-messages` - Delete your own messages (requires enabling in settings)
- `/delete-all-my-messages` - Delete all your messages in current DM

### Settings

- `showDeleteOption` - Enable/disable delete commands (disabled by default)

### PII Statement

This plugin does NOT collect or store personal data. All data is downloaded to your local machine. Files are saved to your selected folder or downloaded on a per-request basis.

## About

This is a combined version of dmMediaExporter and dmMessageDeleter, focusing on export as the primary feature with optional, opt-in deletion.