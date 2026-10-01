# DMArchiver

A [Vencord](https://github.com/Vendicated/Vencord) userplugin that exports and preserves DM content — media files and full text history — lets you audit everyone you've ever DM'd (including closed/hidden DMs and non-friends), and optionally delete **only your own** messages.

Now with a full **archive dashboard**: searchable DM list, multi-select, live export progress — right inside Discord. The dashboard is a **floating, resizable window** (same UX family as GhostDms/msgPurge): it stays open while you click through the DMs it lists, sizes persist per plugin, hide with – mid-export and it keeps going.

## Features

- 🖼️ **Media export** — attachments, embed images/videos/thumbnails, and image URLs typed into messages; downloaded via the main process (bypasses CORS), with a fetch fallback
- 📄 **Text transcripts** — full DM history saved as formatted `.txt`
- 🔎 **Audit** — list every DM user, flag the ones you're *not* friends with
- 🗑️ **Self-deletion** — batch-delete *your own* messages (rate-limited, retry, peer messages never touched); double-gated behind a setting
- 🧠 **Export map includes ledger-known DMs** — DM partners remembered by [DmLedger](#dmledger-also-in-this-repo-dmledger-plus-a-ledgerts-copy-inside-each-plugin) whose channels fell out of Discord's ~100-channel list are still resolved to their channel id and exported (the id outlives the list)
- 🎛️ **Dashboard UI** — open with `/dm-dashboard` or the folder button in the DM chat bar; **floating window** (drag/resize/persist, – hides mid-export without killing it)
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
- 🧠 **Sees beyond Discord's ~100-DM window** — if [DmLedger](#dmledger-also-in-this-repo-dmledger-plus-a-ledgerts-copy-inside-each-plugin) (or a previous GhostDms session) remembers a DM the live list dropped, the picker lists it and explicit channel-id targets resolve through the ledger — deleting only needs the channel id
- 🪟 **Floating window, not a modal** — the control panel is the same draggable/resizable mini-window family as GhostDms: navigate your chats while it watches, hide with – and the purge keeps running in the background, **Open** in the DM picker navigates without closing the panel

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

- 🪟 **All three plugins share one floating-window UX**: drag it, resize it (⋮⋮ / ⋯ grips, sizes persist per plugin), hide with – while work keeps running in the background; ✕ / double-click / Esc close
- 👻 Discord's sidebar hides DMs with non-friends; the `/users/@me/channels` API returns **all** of them — this plugin shows the full list
- 🏷️ Ghost accounts (unfriended/deactivated, missing from the user cache) are still named — the name comes from the recipient embedded in the channel payload
- ➡️ **Open** routes you into the hidden DM (`ChannelRouter.transitionToChannel`); close it by clicking any other conversation
- Search by name, "only show hidden (non-friend) DMs" filter, friend/not-friends tags
- 🔦 **Name search beyond the DM list** — typing a name also searches everyone Discord has ever shown *you* (local user cache + member lists of every server you've joined). Old friends whose DM channel vanished from the list show up in a "recognized from servers / cache" panel with their account's creation date — click **Open DM** and Discord's create-or-get endpoint restores your ORIGINAL channel with history (an empty DM if you never actually DM'd them)
- 🔍 **Deep search: every server member list** — for people not in your local cache *at all*, GhostDms asks every server you're in to search its full roster server-side (`GET /guilds/{id}/members/search`), sequentially and paced so you never trip Discord's rate limits; stop button available, rate-limit stops are reported honestly. Matches come with "in &lt;server name&gt;" and a one-click **Open DM**
- 🪟 **Floating panel, not a modal** — opens compact (~half your screen) with **no maximum**: drag the ⋮⋮ pill on the right edge for **width**, the ⋯ pill on the bottom edge for **height** (grow it to full-screen if you want); both persist across restarts and stay clamped inside your screen — the finder opens as an always-on-top, draggable mini-window: click **Open** on a DM and it navigates *while the panel stays open*, so you can hop through a dozen restored conversations without reopening anything. Re-clicking the bar button hides/restores it (never stacks). Closing is impossible to get stuck on: a solid **✕** in the titlebar, **double-click the titlebar**, or **Esc** all close it; **hide (–)** keeps your list/selection warm — bring it back with the bar button or `/ghost-dms`; dragging can never push the titlebar off-screen (clamped live, and a window resize re-pulls it into view)
- ✅ **Multi-select + bulk restore** — tick any rows (or one-click "Select all", "Select all non-friends" / "Select package-only"), hit **Restore N selected DMs**: it create-or-gets every channel paced at ~0.75s so Discord doesn't rate-limit you, shows progress, has a Stop button, refuses nothing silently (deleted/blocked counted) and stops honestly on 429 — select the rest and run again. A hundred DMs in ~90 seconds instead of a hundred clicks
- 🧤 **Auto-resolves “user ‹id›” placeholder names** — Discord's export contains user IDs but no profiles, so imported rows can read "user1424152…". After an import GhostDms automatically asks Discord (live, paced ~1.1s so you never trip the profile rate limit) for each unnamed account's CURRENT name — display name first, so even handle-only accounts like `user_142415` light up with their real display name. Deleted/blocked accounts stay unknown and are counted honestly; a Resolve button re-runs the sweep, Stop halts it. Open a row and the create-or-get response's embedded profile fixes the name instantly anyway
- 📦 **Import from your Discord data package** — in Discord, *Settings → Privacy & Safety → Request all my Data*, unzip the result, then point the import at the extracted folder. It reads `Messages/<id>/channel.json` and enumerates **every DM you have ever had** — the full history, including DM channels the live API no longer returns. Names resolve from the package itself (relationships → channel index → member dumps); friend tags merge live + export-time relationships; group DMs are counted and skipped (they're not openable by recipient id). One-click **Open** on a package-only row restores the channel via create-or-get. Read-only — it never writes to the package.
- **Open by user ID** fallback (behind a link) if you already know the snowflake
- Union source: REST DM list **+** the local ChannelStore cache (sometimes holds channels REST omits) **+** your imported data package
- 🧠 Rows remembered by [DmLedger](#dmledger-also-in-this-repo-dmledger-plus-a-ledgerts-copy-inside-each-plugin) show tagged "· remembered" — Restore recreates those channels via create-or-get exactly like package-only rows

---

# DmLedger (also in this repo: `dmLedger/`, plus a `ledger.ts` copy inside each plugin)

The memory these three plugins were missing — and now its own browser. Discord's live DM list caps at roughly 100 channels, and it's *sticky* — the conversations you chat in most never page out, so restored/hidden DMs only surface a few at a time. DmLedger fixes the client side of that: it **permanently records every DM partner (user id + channel id + display name) this client ever sees**, in Vencord's own IndexedDB (DataStore). Nothing leaves your machine, and it never *sends* anything.
The `/dm-ledger` browser window **can** restore/open channels or forget rows — only when you click it.
It also absorbs GhostDms's package import: point it at your unzipped Discord data export (the
folder picker remembers the path), and every DM conversation the package contains becomes a
permanent roster row (read-only on the package; group DMs are reported and skipped).

Copy the `dmLedger/` folder into `Vencord/src/userplugins/dmLedger/` and build like the others. The other three plugins each carry their own copy of `ledger.ts` (same shared storage), so **they work with or without DmLedger installed** — install DmLedger to also capture every DM you *send in*, passively, at send time.

- 🧠 **Survives restarts and the eviction window** — partners whose channel Discord no longer lists anywhere stay in the roster forever (first-seen/last-seen, friendship-at-record-time, which plugin saw them)
- ✍️ **Passive capture** — every DM message you send records its recipient instantly; a startup sweep records the current live DM list; package imports, restores, and lookups in the other plugins all contribute records too
- 🔗 **All three consumers read it**: **GhostDms** lists remembered partners tagged "remembered" (Restore recreates the channel), **DMArchiver**'s export map includes ledger-only DMs (so "export everything" isn't capped by Discord's ~100 list anymore), **MsgPurge**'s picker and explicit channel-id targets resolve through it
- 🪟 **Browse it directly** — `/dm-ledger` or the 🔍 button in the DM chat bar opens the same floating window: search everyone by name/id/channel-id, filters (All / Hidden / Unnamed), per-row **Open** (routes instantly for known channels, create-or-get for the ones Discord no longer lists), **Restore**, **Copy** ids, **Forget**; batch **Select all → Restore / Resolve names / Forget** with paced requests, progress and Stop; **Sweep live** to record the current DM list in one shot; **Export JSON** copies the entire roster (ids, names, friendship, first/last seen) to your clipboard for your own records. Once you've imported + restored everything once, this window alone finds and opens any past DM — the GhostDms package import stays available for that first-time backfill (and deep server-roster search to find never-DM'd people).
- 🧹 Forget one partner or wipe the whole roster via `ledgerForget(id)` / `ledgerWipe()` in the console (or the Forget button); clearing your Discord app data also clears it

---

### The browser (`/dm-ledger`, or the search icon in any DM's chat bar)

A floating, resizable window over the roster. Every button has a hover tooltip;
short version:

- **Open** — jumps to the DM; if Discord dropped the channel from your list it first re-opens it (same channel, history intact)
- **Restore** — asks Discord to put the DM back in your sidebar (create-or-get; creates nothing new, sends nothing)
- **Copy** — this partner's user id + channel id as JSON on your clipboard
- **Forget** — deletes only the ledger row; nothing on Discord is touched
- **Sweep live** — one API call that records Discord's current DM list into the roster
- **Import package** — reads your unzipped "Request all my Data" export and remembers *every* DM it contains, including ones hidden from the live list (the same scanner GhostDms uses; runs here too)
- Filters **All / Hidden / Unnamed**, search over name, user id, channel id, or source; batch restore (~1/s paced, Stop works) and name resolve (~1.1 s paced); **Export JSON** copies the whole roster

- **Find someone you've NEVER DM'd** — a second search box: local-cache matches show instantly (zero API), **Search all servers** sweeps every server's full member roster server-side (paced, Stop + rate-limit honest), **Open by ID** opens a DM straight from an exact snowflake. Whatever you open gets remembered in the ledger

Once your package is imported, the browser covers essentially everything GhostDms
did — including its deep server-roster search (ported here as `findPeople.ts`).

## Notes & caveats

- **Deletion is real and irreversible.** Own messages only — enforced by author-ID filter on every delete. Fully offline-tested, but test on a throwaway account first.
- Exported files are named `username_messageId_originalname.ext`.
- `dmarchiver_skipped_*.txt` explains every skipped URL (dead link, blocked type, limit hit…).
- Using client mods technically violates Discord ToS (universally tolerated in practice, but you know your account).
- This is a **userplugin** — it lives in `src/userplugins/`, which is gitignored by Vencord itself, so it survives `git pull` on your Vencord clone.

## License

GPL-3.0-or-later
