# DMArchiver

Export and preserve Discord DM content: media, images, and text history. Includes optional message deletion with user consent.

## Features

- **Export DM Media** - Download all images, videos, and audio from DMs to your local disk
- **Export DM Text** - Save conversation history as readable text files
- **List DM Users** - See all your DM conversations with user IDs for targeted exports
- **Delete Messages** - Remove your own messages from DMs (opt-in feature)
- **Non-Friend Detection** - Identify who you're chatting with who isn't in your friends list

## Installation

### Prerequisites

- Vencord installed and working
- Discord desktop app (for desktop file download support)

### Manual Installation

1. Copy the entire `dmArchiver` folder to your Vencord plugins directory:
   ```
   C:\\Users\\<your-username>\\AppData\\Roaming\\Discord\\0.0.XXX\\modules\\vencord\\plugins\\
   ```
   (Replace `<your-username>` with your Windows username and `0.0.XXX` with your Discord version)

2. Reload Discord (or just reload Vencord plugins via Settings > Vencord > Reload Plugins)

3. Commands will be available immediately

### One-Line Installer (PowerShell)

```powershell
 irm "https://raw.githubusercontent.com/redbelter/vencord-dm-archiver/master/src/plugins/dmArchiver/install.ps1" -OutFile "$env:TEMP\dmArchiver-installer.ps1"; & "$env:TEMP\dmArchiver-installer.ps1"
```

This will:
- Download the installer from GitHub
- Run it automatically from your temp folder
- Detect your Discord version
- Copy files to the correct folder
- Prompt you to close Discord if needed

## Usage

### Available Commands

| Command | Description |
|---------|-------------|
| `/list-dm-users` | List all your DM users with their IDs (useful for targeting specific conversations) |
| `/export-dm-media` | Export media from current DM or specific user |
| `/save-dm-text` | Save conversation text to a file |
| `/list-non-friends` | Show users you chat with who aren't in your friends list |
| `/toggle-delete-commands` | Enable/disable delete-related commands (requires restart) |

### Deleting Messages

⚠️ **Warning**: Message deletion is opt-in and disabled by default.

To enable delete commands:
1. Run `/toggle-delete-commands`
2. Confirm the message that commands are enabled

Delete commands available when enabled:
- `/delete-dm-messages` - Delete your own messages from a specific user's DM
- `/delete-all-my-messages` - Delete all your own messages in current DM

**Important:**
- Only deletes your own messages (not others')
- Rate-limited (1.5 seconds between batches) to avoid Discord API limits
- Use responsibly - deleted messages cannot be recovered

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `downloadFolder` | Folder to save exported files (optional) | Empty (use save dialog) |
| `targetUserId` | Pre-select a user for export | Empty |
| `includeLinkImages` | Include image URLs in message text | Enabled |
| `exportExternalMedia` | Export external links (Imgur, etc) | Disabled |
| `maxImages` | Max images to download in one run (0=unlimited) | 0 |
| `hideQuestStuff` | Hide Discord Quest UI elements | Disabled |
| `showDeleteOption` | Show delete-related commands | Disabled |

## Technical Details

- **Export Format**: Images/Video/Audio saved with sanitized filenames
- **Media Detection**: Both Discord CDN uploads and external links (when enabled)
- **Error Handling**: Skipped files are logged and reported in separate text files
- **Rate Limiting**: Built-in delays to avoid Discord API rate limits

## Troubleshooting

**"No DM users found"**
- Open Discord and ensure your DM list is loaded (scroll through DMs)

**File download fails**
- Try setting `downloadFolder` in settings
- On desktop, the save dialog should appear automatically

**Deletion doesn't work**
- Make sure `showDeleteOption` setting is enabled
- Check that you're deleting your own messages (not others')

## License

GPL-3.0-or-later

## Author

[Devs.redbelter](https://github.com/redbelter)

## PII Statement

This plugin does NOT collect, store, or transmit any personally identifiable information (PII). The installer script only uses:
- `$env:USERNAME` - Your Windows username (local only)
- Discord app settings (read-only, local only)
- GitHub API to download the plugin (public repository access only)

All file paths are local to your machine and never leave your computer.