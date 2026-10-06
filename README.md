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
  - **Save file / Restore backup** — write the FULL ledger (partners + name cache) to a JSON file in your Download folder, and merge such a file back on any machine. Restore only ever grows history (`firstSeen` moves earlier, never later); wrong-kind or junk files are refused with a reason
- 🖼️ **Archive dashboard** (`/dm-dashboard` or the folder button in the chat bar) — searchable DM list with multi-select and live export progress, also a floating window:
  - media export (attachments, embed images/videos, image URLs in messages) downloaded via the main process with a fetch fallback
  - full text transcripts as formatted `.txt`
  - resume-safe: existing files are skipped and skipped media gets a written report
  - export map unions Discord's list **and** ledger-known DMs — partners whose channels fell out of the sidebar list still resolve by remembered channel id
- 🏛️ **GuildLedger** (`/guild-ledger`, or the **`ledger` button above your server rail**) — Discord *deletes* servers from your client the moment you leave; the guild ledger is the twin roster that never forgets. Every server visible at startup, every `GUILD_CREATE`/`GUILD_UPDATE`, and the last moment of every `GUILD_DELETE` is recorded locally (zero API calls): name, member count, **icon** (hash → CDN thumbnail, still renders after you leave), owner flag, dates, evidence strength. The floating window lists current vs gone, filters (In / Gone / Unnamed), search, export, Forget/Clear. **Save file** writes a full-fidelity backup (icons + every caught roster) to your Download folder; **Restore backup** merges one back — history only grows: dates merge, rosters union, and an old file can never rename a live server.
  - **"Who was there" — member snapshots**: Discord never sends the roster of a server you aren't in, so the ledger captures it *before* you leave. It silently rides along with member lists Discord already fetches (zero API), sweeps warm member caches at startup/leave, and each current-server row has a **Catch roster** button that requests up to 1000 members with a single gateway op (the same OP-8 mechanism Vencord's own implicitRelationships uses). Names dedup by id, cap at 1000/server. Each row with saved names gets a **Roster** button that expands an inline "who was there" name list right in the window (first 50 shown; **Roster Copy** hands all of them to you as `{id, name}` JSON). Left servers keep whatever was caught while you were a member — gone servers can't be backfilled retroactively.
  - **Backfill from your data package**: Discord's `Activity/` telemetry embeds `guild_id` (and often `guild_name` + `guild_size`) on hundreds of thousands of events — `dmLedger/guild_backfill.py` mines them into a `guild-ledger.json` (ids, names, first/last dates, strong-presence counts like voice/message events). Import it in the window. This is a *floor* on your history, not a census — telemetry only covers recorded time windows, and Discord resolves no names for servers you left.
- 🗑️ **Self-deletion** (optional, double-gated by `showDeleteOption`) — batch-delete **only your own** messages, rate-limited with retry; peer messages are never touched
- 🚫 Optional Quest-UI hiding
- 🕶️ **Optional hiding** — Nitro gift/upsell ads, campaign popups (copy-based sniper), the Active Now column, and the **"Playing X" activity sublines in the server member list** (names, roles, and custom statuses stay visible — roster rows never show custom statuses anyway, so there is no collateral)

**Find media from this person.** Right-click any user (friends or not) ->
"Find media from this person". A floating window sweeps every server plus
every DM you share with them that your account can actually read — Discord's
own search endpoints enforce the access model (places you can see, nothing
else); unrelated DMs are skipped because they provably can't contain that
person's messages. Lists every message with media that person authored,
newest first, with Open (jumps straight to the message) and Copy links.
Filters by channel/text, and survives Discord's aggressive search rate limits
with adaptive pacing (auto-slow, courtesy wait + retry, partial results
never discarded) plus honest accounting (unreadable vs rate-limited).

## Install

Vencord compiles plugins at build time. Clone this repo anywhere, then copy **all three** plugin folders (flat — the plugin name is its folder name) into your Vencord source tree:

```bash
git clone https://github.com/redbelter/vencord-dm-archiver
cd vencord-dm-archiver
cp -r dmLedger msgPurge gamePresence /path/to/Vencord/src/userplugins/
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
- `hideMemberActivity` — hides the "Playing X / Watching X" activity sublines (and the icon-only "+N" grouped chips) in the **server member list**. Names, roles, tags, and custom statuses are untouched — roster rows never display custom statuses anyway (proven against the live client), so this can't take anything else down with it
- `hideActivityCards` — hides the big "Playing X" Activity cards inside profile popouts and full profiles, plus the activity chip in DM headers (the header chip mixes game + custom status, so both are hidden there)
- `hideUpsellPrompts` — hides "Gift Nitro" buttons, campaign popups (orbs / account-link / Game Pass), and bottom-of-window promo banners (e.g. "New Nitro Reward! ... YouTube Premium" notices), the "try Nitro" ad card, and "connect your accounts" nudges (Nitro/Connections settings pages stay reachable). Also snipes campaign popups by copy — orbs promos (the Riot-link "Get 200 Discord Orbs" popup, monthly Orbs drops, redemption nags), Xbox Game Pass upsell modals, gift-claim modals, feature-unlock nags — via a MutationObserver that only ever hides modal/popout containers, never chat content (campaign class names are build-hashed, the marketing copy isn't; the pattern list was scraped from Discord's own i18n tables). User-started flows stay visible: TV-device pairing, payment receipts, inline "Unlock with Nitro" labels
- Values you had under the old DMArchiver plugin move over automatically on first start.

## GamePresence (companion plugin, `gamePresence/`)

Spoof **your own** activity — the `Playing <anything>` line everyone sees, with
more than one string in it:

- `/playing Some Game` sets it instantly; `verb:watching|listening|streaming|competing`
  changes the prefix verb (`Watching One Piece`, `Listening to Phonk`)
- `details:` / `state:` — the two rich-presence lines under the title (mission + map,
  the way real games show it)
- `hours:3` — fake **elapsed** head-start, so the session timer reads 3+ hours
- `party:2 / 5` — a player-count chip; `sub:clear` / `sub:off` wipe or park it
- profile **buttons** and full rich artwork come from the same payload slots —
  buttons work like upstream CustomRPC's; a custom banner image would need a
  registered Discord application (the plugin sends standard activity fields)

It **re-applies on every launch**, so your status is effectively permanent —
survives restarts and re-logins (flip `active` off in settings for a normal
presence). One thing it silently does: Discord hides ALL activities when the
*Display current activity as a status message* user setting is off, so the
plugin force-enables that one privacy toggle while it is broadcasting (the
exact trick upstream CustomRPC plays, via the same `UserSettingsAPI`).

**The absolute kill-switch.** GamePresence has a `neverShow` setting — when it's on,
the plugin pins Discord's Activity Privacy switch to OFF and broadcasts nothing, ever:
not your spoof, not a real game Discord auto-detects. Turning the spoof off restores
whatever privacy setting was in place before it turned on, so "off" means *no game is
visible to anybody* — including games you actually play. If you want your real
detected game to show, turn `neverShow` off and don't use the spoof.

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
- GamePresence only ever edits **your own** client's local presence dispatch (`LOCAL_ACTIVITY_UPDATE`, the same socket mechanism Vencord's own musicRichPresence/CustomRPC use). It touches nobody else's data; it does not use tokens, REST, or unofficial endpoints.

## License

GPL-3.0-or-later, same as Vencord.
