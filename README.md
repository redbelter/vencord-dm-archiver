# DmLedger — the permanent DM roster, browser, and archive toolkit

A [Vencord](https://github.com/Vendicated/Vencord) userplugin that remembers **every DM partner you've ever had — client-side, forever** — and gives you one window to browse, search, restore, and export them.

**2026-10: DMArchiver and GhostDms were retired into this plugin.** One install (`dmLedger/`) now ships the roster, the `/dm-ledger` browser, the archive dashboard, and every export/save/delete command. Old settings migrate themselves on first start. If you still have the old plugins installed, uninstall them and keep only this one.

## What it does

- 🧠 **Permanent ledger** — every DM you send (and every DM channel Discord's list still shows, or that your imported data package contains) is recorded to a local DataStore roster: user id, channel id, name, last-seen. It survives restarts, re-logins, and Discord dropping channels from its ~100-channel sidebar list. Names are resolved lazily and cached.
- 🔎 **Browser window** (`/dm-ledger` or the search icon in any DM's chat bar) — floating, resizable, stays open while you browse:
  - search by name / id / channel id, filter all / hidden / unnamed
  - per-row actions: **Open** routes to the DM (with navigation confirm + capped retry, so it never takes two clicks), **Archive** opens the export dashboard with that DM pre-selected, **Purge** opens the msgPurge panel for that conversation (if the MsgPurge plugin is installed), **Copy** puts user+channel ids on the clipboard, **Forget** removes a record
  - batch actions for selections: Restore N (reopen via create-or-get), Resolve names, Forget N
  - **Find anyone** — instant match against your local people cache, plus a paced deep sweep of every server roster you're in; open a DM to someone by exact snowflake id too
  - **Import your Discord data package** (`Read the data we've collected` → `users/@me/channels.json`) to backfill the roster from up to years of history — strictly read-only, zero Discord writes
  - **Sweep live** re-records your current DM list in one REST call; row order stays stable no matter what you click
- 🖼️ **Archive dashboard** (`/dm-dashboard` or the folder button in the chat bar) — searchable DM list with multi-select and live export progress, also a floating window:
  - media export (attachments, embed images/videos, image URLs in messages) downloaded via the main process with a fetch fallback
  - full text transcripts as formatted `.txt`
  - resume-safe: existing files are skipped and skipped media gets a written report
  - export map unions Discord's list **and** ledger-known DMs — partners whose channels fell out of the sidebar list still resolve by remembered channel id
- 🏛️ **GuildLedger** (`/guild-ledger`, or the **`ledger` button above your server rail**) — Discord *deletes* servers from your client the moment you leave; the guild ledger is the twin roster that never forgets. Every server visible at startup, every `GUILD_CREATE`/`GUILD_UPDATE`, and the last moment of every `GUILD_DELETE` is recorded locally (zero API calls): name, member count, **icon** (hash → CDN thumbnail, still renders after you leave), owner flag, dates, evidence strength. The floating window lists current vs gone, filters (In / Gone / Unnamed), search, export, Forget/Clear.
  - **"Who was there" — member snapshots**: Discord never sends the roster of a server you aren't in, so the ledger captures it *before* you leave. It silently rides along with member lists Discord already fetches (zero API), sweeps warm member caches at startup/leave, and each current-server row has a **Catch roster** button that requests up to 1000 members with a single gateway op (the same OP-8 mechanism Vencord's own implicitRelationships uses). Names dedup by id, cap at 1000/server. Each row with saved names gets a **Roster** button that expands an inline "who was there" name list right in the window (first 50 shown; **Roster Copy** hands all of them to you as `{id, name}` JSON). Left servers keep whatever was caught while you were a member — gone servers can't be backfilled retroactively.
  - **Backfill from your data package**: Discord's `Activity/` telemetry embeds `guild_id` (and often `guild_name` + `guild_size`) on hundreds of thousands of events — `dmLedger/guild_backfill.py` mines them into a `guild-ledger.json` (ids, names, first/last dates, strong-presence counts like voice/message events). Import it in the window. This is a *floor* on your history, not a census — telemetry only covers recorded time windows, and Discord resolves no names for servers you left.
- 🗑️ **Self-deletion** (optional, double-gated by `showDeleteOption`) — batch-delete **only your own** messages, rate-limited with retry; peer messages are never touched
- 🚫 Optional Quest-UI hiding

## Install

Vencord compiles plugins at build time. Clone this repo anywhere, then copy **both** plugin folders (flat — the plugin name is its folder name) into your Vencord source tree:

```bash
git clone https://github.com/redbelter/vencord-dm-archiver
cd vencord-dm-archiver
cp -r dmLedger msgPurge /path/to/Vencord/src/userplugins/
cd /path/to/Vencord
pnpm install
pnpm build       # or: pnpm watch  (rebuild on save; Ctrl+R in Discord)
```

> ⚠️ Don't clone *into* `src/userplugins/dmLedger` — that nests the code one level too deep
> (`dmLedger/dmLedger/`) and breaks `pnpm build` for the whole tree. The plugin's `index.tsx`
> must sit directly at `src/userplugins/<PluginFolder>/index.tsx`.

If you have a patched Discord desktop install (`pnpm build && node scripts/runInstaller.mjs`), just `Ctrl+R` after the build.

Then: **Settings → Vencord → Plugins → DmLedger** (search "dm").

## Slash commands

| Command | What |
|---|---|
| `/dm-ledger` | Open the roster browser |
| `/guild-ledger` | Open the guild ledger (every server you've ever been in) |
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
- `showGuildLedgerButton` — the `ledger` button above the server rail (opens GuildLedger)
- `captureOnStart` — sweep the live DM list at startup, `hideQuestStuff`
- `hideActiveNow` — hide the entire "Active Now" column on the Friends page
- `hideUpsellPrompts` — hides "Gift Nitro" buttons, the "try Nitro" ad card, and "connect your accounts" nudges (Nitro/Connections settings pages stay reachable). Also snipes campaign popups by copy — orbs promos (the Riot-link "Get 200 Discord Orbs" popup, monthly Orbs drops, redemption nags), Xbox Game Pass upsell modals, gift-claim modals, feature-unlock nags — via a MutationObserver that only ever hides modal/popout containers, never chat content (campaign class names are build-hashed, the marketing copy isn't; the pattern list was scraped from Discord's own i18n tables). User-started flows stay visible: TV-device pairing, payment receipts, inline "Unlock with Nitro" labels
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
