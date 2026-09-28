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

---

# MsgPurge (also in this repo: `msgPurge/`)

A **separate Vencord plugin** for rate-limited deletion of **your own** messages — designed to run for hours without babysitting. Copy the `msgPurge/` folder into `Vencord/src/userplugins/msgPurge/` and build the same way.

## Features

- 🧮 **Built-in rate control** — configurable msgs/minute (1–30), fixed rolling window + jitter so you never burst like a bot
- 🎚️ **Scope: All messages or Only media** — pick between deleting everything you sent or just messages that contain attachments
- ⏸️ **Pause / resume / stop anytime** — a Stop mid-run saves the exact queue of remaining message IDs
- 💾 **Resumable across restarts** — the unfinished queue persists to plugin settings; after a Discord restart you get offered "Resume queue" or "Discard"
- 🚦 **Live status panel** — deleted / failed / scanned counts, msgs/min estimate, queued remainder, target, elapsed time
- 🛡️ **Own messages only** — the engine filters by your user ID at scan time; peer messages are never queued, let alone deleted
- 👥 **DM sweep options** — current channel, every DM, and "skip friends" filter
- ⚡ **429-aware** — on rate-limit responses it cools down (60s+backoff) and retries instead of hammering

## Usage

- **`/msgpurge`** — opens the control panel (option: `scope: all | media`)
- **`/msgpurge-here`** — immediately starts deleting your messages in the current channel at the configured rate
- 🗑️ chat-bar button — same control panel, right in the channel
- Enable it first: **Settings → Vencord → Plugins → MsgPurge** (the "Master switch"), and tune **rate (msgs/min)** and **max retries** there.

> ⚠️ Deletion is permanent and irreversible — this deletes through Discord's own API as your account. Start with one channel and a low rate.

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

# GhostDms (also in this repo: `ghostDms/`)

A **third, read-only plugin**: a chat-bar button (and `/ghost-dms`) that lists **every DM you have ever had** — including conversations Discord hides from your sidebar (people who unfriended you, accounts you can no longer open) — and jumps straight to any of them with one click. Nothing is sent or deleted; it just navigates.

Copy the `ghostDms/` folder into `Vencord/src/userplugins/ghostDms/` and build the same way as above.

- 👻 Discord's sidebar hides DMs with non-friends; the `/users/@me/channels` API returns **all** of them — this plugin shows the full list
- 🏷️ Ghost accounts (unfriended/deactivated, missing from the user cache) are still named — the name comes from the recipient embedded in the channel payload
- ➡️ **Open** routes you into the hidden DM (`ChannelRouter.transitionToChannel`); close it by clicking any other conversation
- Search by name, "only show hidden (non-friend) DMs" filter, friend/not-friends tags
- 🔦 **Name search beyond the DM list** — typing a name also searches everyone Discord has ever shown *you* (local user cache + member lists of every server you've joined). Old friends whose DM channel vanished from the list show up in a "recognized from servers / cache" panel with their account's creation date — click **Open DM** and Discord's create-or-get endpoint restores your ORIGINAL channel with history (an empty DM if you never actually DM'd them)
- 🔍 **Deep search: every server member list** — for people not in your local cache *at all*, GhostDms asks every server you're in to search its full roster server-side (`GET /guilds/{id}/members/search`), sequentially and paced so you never trip Discord's rate limits; stop button available, rate-limit stops are reported honestly. Matches come with "in &lt;server name&gt;" and a one-click **Open DM**
- 📦 **Import from your Discord data package** — in Discord, *Settings → Privacy & Safety → Request all my Data*, unzip the result, then point the import at the extracted folder. It reads `Messages/<id>/channel.json` and enumerates **every DM you have ever had** — the full history, including DM channels the live API no longer returns. Names resolve from the package itself (relationships → channel index → member dumps); friend tags merge live + export-time relationships; group DMs are counted and skipped (they're not openable by recipient id). One-click **Open** on a package-only row restores the channel via create-or-get. Read-only — it never writes to the package.
- **Open by user ID** fallback (behind a link) if you already know the snowflake
- Union source: REST DM list **+** the local ChannelStore cache (sometimes holds channels REST omits) **+** your imported data package

---

## Notes & caveats

- **Deletion is real and irreversible.** Own messages only — enforced by author-ID filter on every delete. Fully offline-tested, but test on a throwaway account first.
- Exported files are named `username_messageId_originalname.ext`.
- `dmarchiver_skipped_*.txt` explains every skipped URL (dead link, blocked type, limit hit…).
- Using client mods technically violates Discord ToS (universally tolerated in practice, but you know your account).
- This is a **userplugin** — it lives in `src/userplugins/`, which is gitignored by Vencord itself, so it survives `git pull` on your Vencord clone.

## License

GPL-3.0-or-later
