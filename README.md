# DMArchiver

A [Vencord](https://github.com/Vendicated/Vencord) userplugin that exports and preserves DM content — media files and full text history — lets you audit everyone you've ever DM'd (including closed DMs and blocked users), and (opt-in) deletes **only your own** messages.

> ⚠️ Client mods violate Discord's ToS — generally tolerated, but use at your own risk. The deletion commands issue real API calls through your account and are double-gated by a setting. Use responsibly.

## Features

| Command | What it does |
|---|---|
| `/list-dm-users` | Every user you've ever DM'd (REST + local store merge — catches closed DMs and blocked users) |
| `/list-non-friends` | DM contacts you are **not** friends with |
| `/export-dm-media [userId]` | Downloads all media (attachments, embeds, inline image links) to disk. Cross-message URL dedupe, content-type validation, resumable (existing files skipped), `maxImages` circuit-breaker, and a `dmarchiver_skipped_*.txt` report explaining every skip |
| `/save-dm-text [userId]` | Conversation transcript(s) as readable `.txt` (timestamps, authors, attachment URLs) |
| `/toggle-delete-commands` | Unlock/lock the deletion commands |
| `/delete-dm-messages [userId]` | Delete **your own** messages in a DM (batched, retry×3, rate-limited) |
| `/delete-all-my-messages` | Same, scoped to the currently open DM |

Settings (Vencord → Plugins → DMArchiver ⚙️):

- `downloadFolder` — absolute path for automatic saves (empty = save dialog per file)
- `includeLinkImages` / `exportExternalMedia` — what counts as "media"
- `maxImages` — per-run cap (0 = unlimited)
- `hideQuestStuff` — hides Discord Quest UI via managed CSS
- `showDeleteOption` — master gate for the two delete commands

Downloads go through a native (`native.ts`) helper that bypasses browser sandboxing, with `fetch` fallback; writes are path-traversal-safe.

## Install

Requires a **Vencord development install** (Vencord compiles plugins at build time — see [custom plugin docs](https://docs.vencord.dev/installing/custom-plugins/)).

```bash
cd Vencord/src/userplugins
git clone https://github.com/redbelter/vencord-dm-archiver dmArchiver
cd ../..
pnpm build          # or `pnpm watch` for live rebuilds
pnpm inject         # only needed once
```

> The **folder name must be `dmArchiver`** (clone target `dmArchiver` as shown). The *plugin name* is `DMArchiver`.

Restart / reload Discord (Ctrl+R) → Settings → Vencord → Plugins → enable **DMArchiver**.

## Update

```bash
cd Vencord/src/userplugins/dmArchiver && git pull
cd ../.. && pnpm build
```

## Smoke test order (safest first)

1. `/list-dm-users` — read-only
2. `/export-dm-media userId:<id>` — scoped export
3. `/list-non-friends` — read-only
4. Deletion commands only after flipping `showDeleteOption`

## Development

The plugin is fully unit-testable against mocked Discord APIs (35 assertions: URL harvesting/dedupe, export gating, skip reports, resume behavior, transcript formatting, own-messages-only deletion). A harness lives in the author's dev tree; the pure helpers are isolated in `utils.ts` for easy testing.

## License

GPL-3.0-or-later
