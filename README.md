# DMArchiver

A [Vencord](https://github.com/Vendicated/Vencord) userplugin that exports and preserves DM content — media files and full text history — lets you audit everyone you've ever DM'd (including closed/hidden DMs and non-friends), and optionally delete **only your own** messages.

Now with a full **archive dashboard**: searchable DM list, multi-select, live export progress — right inside Discord.

## Features

- 🖼️ **Media export** — attachments, embed images/videos/thumbnails, and image URLs typed into messages; downloaded via the main process (bypasses CORS), with a fetch fallback
- 📄 **Text transcripts** — full DM history saved as formatted `.txt`
- 🔎 **Audit** — list every DM user, flag the ones you're *not* friends with
- 🗑️ **Self-deletion** — batch-delete *your own* messages (rate-limited, retry, peer messages never touched); double-gated behind a setting
- 🎛️ **Dashboard UI** — open with `/dm-dashboard` or the folder button in the DM chat bar
- 🚫 Optional Quest-UI hiding
- ⏯️ Resume-safe: existing files are skipped, skipped media gets a written report

## Install

Vencord compiles plugins at build time — clone this repo into your Vencord source tree:

```bash
git clone https://github.com/redbelter/vencord-dm-archiver Vencord/src/userplugins/dmArchiver
cd Vencord
pnpm install
pnpm build       # or: pnpm watch  (rebuild on save; Ctrl+R in Discord)
```

If you have a patched Discord desktop install (`pnpm build && node scripts/runInstaller.mjs`), just `Ctrl+R` after the build.

Then: **Settings → Vencord → Plugins → DMArchiver** (search "dm").

## Usage

Open the dashboard with **`/dm-dashboard`**, the 📁 button in any DM's chat bar, and:

1. Set the export folder (empty = save-dialog per file)
2. Filter / **Select all shown** / **+ non-friends**
3. **Export media** and/or **Save transcripts** — watch live progress
4. *(optional)* enable `showDeleteOption` in plugin settings → per-row **delete mine** buttons appear (with a confirm step)

### Slash commands (headless / scripting)

| Command | What |
|---|---|
| `/dm-dashboard` | Open the dashboard |
| `/list-dm-users` | All DM users (username + ID) — REST + store merged, finds hidden DMs |
| `/export-dm-media userId:` | Export media for one user or all DMs |
| `/save-dm-text userId:` | Transcript of one DM, current conversation, or all |
| `/list-non-friends` | DM users you aren't friends with |
| `/toggle-delete-commands` | Flip the deletion gate |
| `/delete-dm-messages userId:` | Delete **your** messages in one DM (gated) |
| `/delete-all-my-messages` | Same, scoped to the current DM (gated) |

## Settings

| Setting | Default | Notes |
|---|---|---|
| `downloadFolder` | *empty* | Absolute path; empty = native save dialog each file |
| `targetUserId` | *empty* | Default target for commands (empty = current channel) |
| `includeLinkImages` | ✅ | Harvest image URLs from message text |
| `exportExternalMedia` | ❌ | Also save non-Discord links (they rot over time) |
| `maxImages` | `0` | Cap per run (0 = unlimited); skips are reported |
| `hideQuestStuff` | ❌ | CSS-hide Discord Quest UI |
| `showDeleteOption` | ❌ | Unlocks deletion commands + dashboard delete buttons |
| `showChatBarEntry` | ✅ | Folder button in DM chat bars |

## Notes & caveats

- **Deletion is real and irreversible.** Own messages only — enforced by author-ID filter on every delete. Fully offline-tested, but test on a throwaway account first.
- Exported files are named `username_messageId_originalname.ext`.
- `dmarchiver_skipped_*.txt` explains every skipped URL (dead link, blocked type, limit hit…).
- Using client mods technically violates Discord ToS (universally tolerated in practice, but you know your account).
- This is a **userplugin** — it lives in `src/userplugins/`, which is gitignored by Vencord itself, so it survives `git pull` on your Vencord clone.

## License

GPL-3.0-or-later
