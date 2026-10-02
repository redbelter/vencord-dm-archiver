# DmLedger — the permanent DM roster, browser, and archive toolkit

A [Vencord](https://github.com/Vendicated/Vencord) userplugin that remembers **every DM partner you've ever had — client-side, forever** — and gives you one window to browse, search, restore, and export them.

**2026-10: DMArchiver and GhostDms were retired into this plugin.** One install (`dmLedger/`) now ships the roster, the `/dm-ledger` browser, the archive dashboard, and every export/save/delete command. Old settings migrate themselves on first start. If you still have the old plugins installed, uninstall them and keep only this one.

## What it does

- 🧠 **Permanent ledger** — every DM you send (and every DM channel Discord's list still shows, or that your imported data package contains) is recorded to a local DataStore roster: user id, channel id, name, last-seen. It survives restarts, re-logins, and Discord dropping channels from its ~100-channel sidebar list. Names are resolved lazily and cached.
- 🔎 **Browser window** (`/dm-ledger` or the search icon in any DM's chat bar) — floating, resizable, stays open while you browse:
  - search by name / id / channel id, filter all / hidden / unnamed
  - **Restore** puts a dropped DM back in your sidebar (create-or-get, nothing new is sent), **Open** routes to it (with navigation confirm + capped retry, so it never takes two clicks), **Copy** puts user+channel ids on the clipboard, **Forget** removes a record
  - **Find anyone** — instant match against your local people cache, plus a paced deep sweep of every server roster you're in; open a DM to someone by exact snowflake id too
  - **Import your Discord data package** (`Read the data we've collected` → `users/@me/channels.json`) to backfill the roster from up to years of history — strictly read-only, zero Discord writes
  - **Sweep live** re-records your current DM list in one REST call; row order stays stable no matter what you click
- 🖼️ **Archive dashboard** (`/dm-dashboard` or the folder button in the chat bar) — searchable DM list with multi-select and live export progress, also a floating window:
  - media export (attachments, embed images/videos, image URLs in messages) downloaded via the main process with a fetch fallback
  - full text transcripts as formatted `.txt`
  - resume-safe: existing files are skipped and skipped media gets a written report
  - export map unions Discord's list **and** ledger-known DMs — partners whose channels fell out of the sidebar list still resolve by remembered channel id
- 🗑️ **Self-deletion** (optional, double-gated by `showDeleteOption`) — batch-delete **only your own** messages, rate-limited with retry; peer messages are never touched
- 🚫 Optional Quest-UI hiding

## Install

Vencord compiles plugins at build time — clone this repo into your Vencord source tree:

```bash
git clone https://github.com/redbelter/vencord-dm-archiver Vencord/src/userplugins/dmLedger
cd Vencord
pnpm install
pnpm build       # or: pnpm watch  (rebuild on save; Ctrl+R in Discord)
```

If you have a patched Discord desktop install (`pnpm build && node scripts/runInstaller.mjs`), just `Ctrl+R` after the build.

Then: **Settings → Vencord → Plugins → DmLedger** (search "dm").

## Slash commands

| Command | What |
|---|---|
| `/dm-ledger` | Open the roster browser |
| `/dm-dashboard` | Open the archive dashboard |
| `/dm-export <user> [days]` | Export DM text+media to the download folder |
| `/dm-export-all [days]` | Export every DM in the map |
| `/dm-save <user>` | Save text transcript only |
| `/dm-save-all` | Save every DM transcript |
| `/dm-audit` | List every DM partner, flag non-friends |
| `/dm-delete <user> <days>` | Delete your own messages (needs `showDeleteOption`) |
| `/dm-delete-recent <days>` | Same, across all DMs (needs `showDeleteOption`) |

## Settings (Settings → Plugins → DmLedger)

- `downloadFolder` — where exports go (e.g. `C:\Users\<you>\Pictures\DMExport`)
- `maxImages` — per-message image cap, `includeLinkImages`, `exportExternalMedia`
- `showDeleteOption` — unlocks deletion commands/buttons
- `showChatBarEntry` — the browser button, `showArchiveButton` — the dashboard button
- `captureOnStart` — sweep the live DM list at startup, `hideQuestStuff`
- Values you had under the old DMArchiver plugin move over automatically on first start.

## MsgPurge (companion plugin, `msgPurge/`)

Standalone rate-limited self-delete tool with a DM picker; it shares the same
ledger store (via its own `ledger.ts` copy — all copies use identical DataStore
keys, so every plugin reads and feeds the same roster). Clone `msgPurge/` the
same way if you want it as its own plugin; DmLedger's own deletion covers most
cases without it.

## Notes & caveats

- The ledger is **local to this machine + client** (Vencord DataStore / IndexedDB). It is not synced; import a data package on a new machine to backfill.
- `restore` cannot revive a DM where the other account deleted theirs and Discord lost the mapping — the id is kept, but the create-or-get endpoint decides.
- Data-package import reads only `Relationship`/channel files; it never uploads or writes to Discord.
- Deletion is rate-limited per Discord's own limits and always restricted to `author.id === you`.
- Old GhostDms functionality (hidden-DM finding, package import, restore) lives in the browser now; the original code stays in `git log -- ghostDms/`.

## License

GPL-3.0-or-later, same as Vencord.
