/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The GuildLedger browser: a floating window over the permanent server roster —
// every server this client has ever seen, including ones recovered from a data
// package telemetry backfill (servers you left years before GuildStore forgot).
// Search, filter (member / gone / unnamed), import a guild-ledger.json backfill,
// sweep the live server list, export to clipboard, forget rows.
//
// ZERO Discord API calls: everything comes from local stores + the ledger.
// There is deliberately no "rejoin" button — rejoining needs an invite; the
// ledger's job is to hand you the NAME to search for (disboard, google).

import { Button } from "@components/Button";
import { copyToClipboard } from "@utils/clipboard";
import {
    GuildStore,
    showToast,
    Text,
    TextInput,
    useEffect,
    useState,
} from "@webpack/common";

import { closeFloating, openFloating, safeStore } from "./floating";
import {
    guildLedgerForget,
    guildLedgerImportBackfill,
    guildLedgerList,
    guildLedgerRefresh,
    guildLedgerWipe,
    type LedgerGuild,
    recordLiveGuilds,
    requestMemberCatch,
} from "./guildLedger";

// native (main-process) bridge: reads a guild-ledger.json backfill file from
// disk. Hidden on web builds (no native.ts there).
const Native = (typeof VencordNative !== "undefined" ? VencordNative : undefined)?.pluginHelpers?.DmLedger as
    | {
        readGuildLedgerFile?: (path: string) => Promise<{ ok: boolean; error?: string; rows?: unknown[] }>;
        chooseFolder?: () => Promise<{ path: string | null; } | string | null>;
    }
    | undefined;

const BACKFILL_PATH_KEY = "GuildLedgerLastImportPath";

export function closeGuildBrowser(): boolean {
    return closeFloating("GuildLedger");
}

export function openGuildBrowser(): void {
    const wasToggle = openFloating({
        storageKey: "GuildLedger",
        title: "GuildLedger — every server you've ever been in",
        render: close => <GuildPanel close={close} />,
    });
    if (!wasToggle) void guildLedgerRefresh(); // pull records other copies made this session
}

// ─── pure helpers (harness-tested) ───────────────────────────────────────────

export type GuildFilter = "all" | "member" | "gone" | "unnamed";

export function isMemberNow(g: LedgerGuild): boolean {
    try { return !!GuildStore.getGuild(g.guildId); } catch { return false; }
}

export function filterGuilds(rows: LedgerGuild[], f: GuildFilter): LedgerGuild[] {
    if (f === "member") return rows.filter(isMemberNow);
    if (f === "gone") return rows.filter(g => !isMemberNow(g));
    if (f === "unnamed") return rows.filter(g => !g.name);
    return rows;
}

export function searchGuilds(rows: LedgerGuild[], q: string): LedgerGuild[] {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(g => (g.name ?? "").toLowerCase().includes(s) || g.guildId.includes(s));
}

export function fmtDay(msOrIso: number | string): string {
    if (typeof msOrIso === "string") return msOrIso.slice(0, 10);
    const d = new Date(msOrIso);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function guildLine(g: LedgerGuild): string {
    const when = `${fmtDay(g.firstSeenDate ?? g.firstSeen)} → ${isMemberNow(g) ? "here now" : fmtDay(g.lastSeenDate ?? g.lastSeen)}`;
    const bits = [when];
    if (g.memberCount != null) bits.push(`~${g.memberCount} members`);
    if (g.memberSnapshot?.length) bits.push(`${g.memberSnapshot.length} name(s) saved`);
    if (g.strongEvents) bits.push(`${g.strongEvents} activity events`);
    if (g.source === "backfill") bits.push("backfilled");
    if (g.owner) bits.push("you owned it");
    return bits.join(" · ");
}

/** icon hash -> CDN url (works after you leave, until the server deletes its icon) */
export function guildIconUrl(g: LedgerGuild): string | null {
    if (!g.icon) return null;
    const anim = g.icon.startsWith("a_");
    return `https://cdn.discordapp.com/icons/${g.guildId}/${g.icon}.${anim ? "gif" : "png"}`;
}

// ─── the panel ───────────────────────────────────────────────────────────────

function GuildPanel({ close }: { close: () => void; }) {
    const [rows, setRows] = useState<LedgerGuild[]>(() => guildLedgerList());
    const [filter, setFilter] = useState<GuildFilter>("all");
    const [search, setSearch] = useState("");
    const [importPath, setImportPath] = useState<string>(() => safeStore.getItem(BACKFILL_PATH_KEY) ?? "");
    const [importMsg, setImportMsg] = useState<string | null>(null);

    const toast = (message: string, failure = false) => showToast(message, failure ? "failure" : "success");

    const refresh = () => setRows(guildLedgerList()); // stable oldest-first order

    useEffect(() => { void guildLedgerRefresh().then(refresh); }, []);

    const visible = searchGuilds(filterGuilds(rows, filter), search);
    const memberCount = filterGuilds(rows, "member").length;
    const unnamedCount = filterGuilds(rows, "unnamed").length;

    const doImportFile = async (path: string) => {
        if (!Native?.readGuildLedgerFile) {
            toast("Native file import isn't available on this build (web?)", true);
            return;
        }
        const res = await Native.readGuildLedgerFile(path.trim());
        if (!res?.ok) {
            setImportMsg(`Import failed: ${res?.error ?? "unknown"}`);
            toast("Backfill import failed — see message", true);
            return;
        }
        const out = guildLedgerImportBackfill(res.rows as any);
        safeStore.setItem(BACKFILL_PATH_KEY, path.trim());
        setImportMsg(`backfill merged: ${out.added} new, ${out.merged} extended, ${out.skipped} skipped`);
        toast(`Backfill: +${out.added} servers`);
        refresh();
    };

    const browseImport = async () => {
        if (Native?.chooseFolder) {
            const picked = await Native.chooseFolder();
            const path = typeof picked === "string" ? picked : picked?.path;
            if (path) { setImportPath(path); await doImportFile(path); return; }
        }
        if (importPath.trim()) await doImportFile(importPath);
    };

    const sweepLive = () => {
        const n = recordLiveGuilds();
        toast(`Swept live server list — ${n} recorded`);
        refresh();
    };
    const exportAll = () => {
        copyToClipboard(JSON.stringify(rows, null, 2));
        toast(`Guild roster exported — ${rows.length} server(s) copied as JSON`);
    };

    const filterBtn = (key: GuildFilter, label: string, tip: string) => (
        <Button key={key} size="xs" variant={filter === key ? "primary" : "secondary"}
            title={tip} onClick={() => setFilter(key)}>
            {label}
        </Button>
    );

    return (
        <div style={{ fontSize: 13 }}>
            <Text variant="text-sm/normal">
                {`${rows.length} server(s) remembered · ${memberCount} current · ${rows.length - memberCount} gone · ${unnamedCount} unnamed`}
            </Text>

            {Native && (
                <div style={{ marginTop: 4 }}>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <div style={{ flex: 1 }}>
                            <TextInput
                                value={importPath}
                                placeholder="path to guild-ledger.json (telemetry backfill from your data package)"
                                onChange={(v: string) => setImportPath(v)}
                            />
                        </div>
                        <Button size="xs" variant="primary" disabled={!importPath.trim()}
                            title="Imports a guild-ledger.json backfill file (ids+names+dates recovered from your Discord data package telemetry). Merges gently: live captures stay authoritative, backfill adds records and can only extend history backwards."
                            onClick={() => void doImportFile(importPath)}
                        >
                            Import backfill
                        </Button>
                        <Button size="xs" variant="secondary"
                            title="Picks the guild-ledger.json with a file dialog"
                            onClick={() => void browseImport()}
                        >
                            Browse…
                        </Button>
                    </div>
                    {importMsg && <Text variant="text-xs/normal">{importMsg}</Text>}
                </div>
            )}

            <div style={{ marginTop: 8, display: "flex", gap: "6px", alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                    <TextInput value={search} placeholder="Search by name or server id…"
                        onChange={(v: string) => setSearch(v)} />
                </div>
            </div>

            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                {filterBtn("all", `All (${rows.length})`, "Every server this ledger has ever seen")}
                {filterBtn("member", `In (${memberCount})`, "Servers you are currently a member of")}
                {filterBtn("gone", `Gone (${rows.length - memberCount})`, "Servers Discord no longer lists for you — left or deleted")}
                {filterBtn("unnamed", `Unnamed (${unnamedCount})`, "Ids recovered from telemetry whose name never resolved (deleted/private since)")}
                <span style={{ flex: 1 }} />
                <Button size="xs" variant="secondary"
                    title="Records every server in your current server list into the ledger (local stores only, zero API calls)"
                    onClick={sweepLive}>
                    Sweep live
                </Button>
                <Button size="xs" variant="secondary"
                    title="Copy the whole roster (ids, names, dates, evidence) as JSON to your clipboard"
                    onClick={exportAll}>
                    Export JSON
                </Button>
                <Button size="xs" variant="dangerSecondary"
                    title="Deletes the ENTIRE guild ledger from this client. Servers you're still in get re-recorded on next launch; gone-servers are gone from the ledger until you re-import."
                    onClick={() => { void guildLedgerWipe().then(() => { refresh(); toast("Guild ledger cleared"); }); }}>
                    Clear all
                </Button>
            </div>

            <div style={{ marginTop: 8 }}>
                {visible.length === 0 && (
                    <Text variant="text-xs/normal">
                        {rows.length === 0
                            ? "Nothing remembered yet. Servers you join are recorded automatically; for history, import a guild-ledger.json backfill (recovered from your Discord data package — ask your ledger plugin's author)."
                            : "Nothing matches this filter/search."}
                    </Text>
                )}
                {visible.map(g => (
                    <div key={g.guildId} style={{ display: "flex", alignItems: "center", gap: "6px", padding: "4px 6px", marginTop: "4px", background: "var(--bg-overlay-2, rgba(128,128,128,.08))", borderRadius: "6px" }}>
                        {guildIconUrl(g)
                            ? <img src={guildIconUrl(g)!} alt="" title={g.description ? g.description.slice(0, 140) : g.name ?? g.guildId}
                                style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, objectFit: "cover" }} />
                            : <div style={{ width: 24, height: 24, borderRadius: "50%", flexShrink: 0, background: "var(--bg-overlay-4, rgba(128,128,128,.2))" }} />}
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <Text variant="text-sm/medium">{g.name ?? "Unknown server"}</Text>
                            <div><Text variant="text-xs/normal">{guildLine(g)}</Text></div>
                        </div>
                        {isMemberNow(g) && (
                            <Button size="xs" variant="primary"
                                title="Ask Discord for this server's member list right now (one gateway request, up to 1000 members) and save the names permanently — before you ever leave. Names already saved are never duplicated."
                                onClick={() => {
                                    const sent = requestMemberCatch(g.guildId);
                                    toast(sent
                                        ? "Roster request sent — chunks save automatically as they land (check back in a few seconds)"
                                        : "Couldn't request (server not in your list?)", !sent);
                                }}>
                                Catch roster
                            </Button>
                        )}
                        {!!g.memberSnapshot?.length && (
                            <Button size="xs" variant="secondary"
                                title="Copy the saved member names (id + name JSON) — this is the 'who was there' you caught while you were a member"
                                onClick={() => {
                                    copyToClipboard(JSON.stringify(g.memberSnapshot?.map(([id, name]) => ({ id, name })), null, 2));
                                    toast(`Copied ${g.memberSnapshot?.length} member(s)`);
                                }}>
                                Roster Copy
                            </Button>
                        )}
                        <Button size="xs" variant="secondary"
                            title="Copy id + name JSON — then paste into disboard/discords.com search to look for an invite"
                            onClick={() => { copyToClipboard(JSON.stringify({ id: g.guildId, name: g.name ?? null }, null, 2)); toast("Copied — now search the name for an invite"); }}>
                            Copy
                        </Button>
                        <Button size="xs" variant="secondary"
                            title="Deletes just this row from the ledger (doesn't touch Discord). Servers you're still in get re-recorded automatically."
                            onClick={() => { guildLedgerForget(g.guildId); refresh(); }}>
                            Forget
                        </Button>
                    </div>
                ))}
            </div>

            <div style={{ marginTop: 8, textAlign: "right" }}>
                <Button size="xs" variant="secondary" onClick={close}>Close</Button>
            </div>
        </div>
    );
}
