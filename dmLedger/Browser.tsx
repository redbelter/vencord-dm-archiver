/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The DmLedger browser: a floating window over the permanent DM roster —
// everyone this client has ever DM'd, even after Discord's ~100-channel window
// evicted the conversation. Search, filter (hidden / unnamed), open (routing
// or restoring via create-or-get), batch restore + name resolve (paced),
// export the whole roster as JSON to clipboard, forget rows.
//
// Read-only toward Discord except the create-or-get call behind Restore
// (returns the ORIGINAL channel — same sanctioned call GhostDms uses).

import { commands as commandRegistry } from "@api/Commands";
import { SettingsStore } from "@api/Settings";
import { Button } from "@components/Button";
import { copyToClipboard } from "@utils/clipboard";
import {
    ChannelRouter,
    ChannelStore,
    Checkbox,
    RestAPI,
    SelectedChannelStore,
    showToast,
    Text,
    TextInput,
    useEffect,
    UserStore,
    useState,
} from "@webpack/common";

import { saveFile } from "./archiveCore";
import { type RosterPerson, searchGuildRosters, searchPeopleCache } from "./findPeople";
import { closeFloating, openFloating, safeStore } from "./floating";
import { ledgerBackupPayload, type LedgerDm, ledgerDmCount, ledgerDms, ledgerForget, ledgerImportBackup, ledgerNameCount, ledgerRefresh, recordDm, recordName } from "./ledger";
import type { PackageScan } from "./native";

// native (main-process) bridge: reads a Discord data-package folder — the ONE
// source that lists every DM you ever had, even ones never opened since
// (Settings → Privacy & Safety → Request all my Data, then unzip).
// Hidden on web builds (no native.ts there).
const Native = (typeof VencordNative !== "undefined" ? VencordNative : undefined)?.pluginHelpers?.DmLedger as
    | {
        scanPackage(path: string): Promise<PackageScan>;
        chooseFolder(): Promise<{ path: string | null; } | string | null>;
        pickFile?(): Promise<{ path: string | null; } | string | null>;
        readBackupFile?(path: string): Promise<{ ok: boolean; error?: string; data?: unknown }>;
    }
    | undefined;

const PKG_PATH_KEY = "DmLedgerLastPkgPath";

// pacing knobs (defaults match Discord's real budgets; the harness zeroes them
// so tests don't sleep through hundreds of seconds)
export function namePaceMs(): number {
    const v = parseInt(safeStore.getItem("DmLedgerNamePace") ?? "", 10);
    return Number.isFinite(v) && v >= 0 && v <= 1100 ? v : 1100;
}
export function restorePaceMs(): number {
    const v = parseInt(safeStore.getItem("DmLedgerRestorePace") ?? "", 10);
    return Number.isFinite(v) && v >= 0 && v <= 750 ? v : 750;
}
export function rosterPaceMs(): number {
    const v = parseInt(safeStore.getItem("DmLedgerRosterPace") ?? "", 10);
    return Number.isFinite(v) && v >= 0 && v <= 150 ? v : 150;
}

/**
 * Discord's router can no-op when handed a channel id its stores only just
 * learned about (the create-or-get response hasn't propagated to the view
 * layer yet). Route, then confirm via SelectedChannelStore; retry a couple of
 * times. Without this the FIRST click on a never-opened ledger DM feels dead
 * and the second click is what actually navigates.
 * A shared token makes stale chains abort: if you open A then quickly B, A's
 * pending retries give up instead of yanking you back from B.
 */
let routeTarget = "";
export function routeUntil(channelId: string): void {
    routeTarget = channelId;
    ChannelRouter.transitionToChannel(channelId);
    let tries = 0;
    const check = () => {
        tries++;
        if (routeTarget !== channelId) return; // user moved on — stale chain aborts
        let selected = "";
        try { selected = String(SelectedChannelStore.getChannelId?.() ?? ""); } catch { selected = "?"; }
        if (selected === channelId || selected === "?" || tries >= 3) return;
        ChannelRouter.transitionToChannel(channelId);
        setTimeout(check, 250);
    };
    setTimeout(check, 150);
}

export interface ImportSummary {
    imported: number;
    newPartners: number;
    groupDms: number;
    named: number;
}

/**
 * Fold a package scan into the ledger. Read-only on the package; every DM
 * partner becomes a permanent record (channel id included — it survives even
 * when Discord stops listing the channel). Returns honest counts.
 */
export function mergeScanIntoLedger(scan: PackageScan): ImportSummary {
    const friendSet = new Set(scan.friends ?? []);
    let newPartners = 0, named = 0;
    for (const dm of scan.dms ?? []) {
        const known = ledgerDms().some(d => d.userId === dm.recipientId);
        if (!known) newPartners++;
        const name = dm.name ?? scan.names?.[dm.recipientId];
        if (name) named++;
        recordDm({
            userId: dm.recipientId,
            channelId: dm.channelId,
            username: name,
            isFriend: friendSet.has(dm.recipientId),
            source: "package",
        });
        if (name) recordName({ userId: dm.recipientId, username: name });
    }
    return {
        imported: scan.dms?.length ?? 0,
        newPartners,
        groupDms: scan.groupDms ?? 0,
        named,
    };
}

// ─── pure helpers (harness-tested) ───────────────────────────────────────────

export const SNOWFLAKE_RE = /^\d{15,20}$/;

/** Account creation date from a snowflake id (Discord epoch 2015-01-01). */
export function snowflakeDate(id: string): string | null {
    try {
        const ms = (BigInt(id) >> 22n) + 1420070400000n;
        const d = new Date(Number(ms));
        if (isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 10);
    } catch { return null; }
}

export function formatStamp(ms: number): string {
    try {
        const d = new Date(ms);
        if (isNaN(d.getTime())) return "?";
        return d.toISOString().slice(0, 10);
    } catch { return "?"; }
}

export function displayName(row: LedgerDm): string {
    return row.username ?? `user ${row.userId}`;
}

export function isUnnamed(row: LedgerDm): boolean {
    return !row.username || row.username === `user ${row.userId}` || /^user[_ ]?\d+$/i.test(row.username);
}

export type LedgerFilter = "all" | "hidden" | "unnamed";

export function matchesQuery(row: LedgerDm, q: string): boolean {
    if (!q) return true;
    const s = q.toLowerCase().trim();
    return (
        (row.username ?? "").toLowerCase().includes(s)
        || row.userId.includes(s)
        || (row.channelId ?? "").includes(s)
        || row.source.toLowerCase().includes(s)
    );
}

export function applyFilter(rows: LedgerDm[], filter: LedgerFilter): LedgerDm[] {
    if (filter === "hidden") return rows.filter(r => r.isFriend === false);
    if (filter === "unnamed") return rows.filter(isUnnamed);
    return rows;
}

// ─── Discord calls (paced + cancellable; shared shapes with GhostDms) ────────

/** create-or-GET: if the DM ever existed, returns THAT channel (history intact). */
export async function resolveDmByUserId(userId: string): Promise<{ channelId: string; recipientName?: string; }> {
    const res: any = await RestAPI.post({ url: "/users/@me/channels", body: { recipient_id: userId } });
    const ch = res?.id ? res : res?.body;
    if (!ch?.id) throw new Error("Discord did not return a DM channel");
    const rec = Array.isArray(ch.recipients) ? ch.recipients[0] : undefined;
    return { channelId: String(ch.id), recipientName: rec?.global_name ?? rec?.username };
}

/** popcard endpoint works for non-friends; bare endpoint as fallback; null on 4xx */
export async function fetchUserLite(userId: string): Promise<any | null> {
    const unwrap = (res: any) => (res?.user?.id ? res.user : res?.body?.user?.id ? res.body.user : res?.username ? res : res?.body?.id ? res.body : null);
    try {
        const u = unwrap(await RestAPI.get({ url: `/users/${userId}/profile` }));
        if (u?.id) return u;
    } catch { /* 404/403/429 — try the plain endpoint */ }
    try {
        const u = unwrap(await RestAPI.get({ url: `/users/${userId}` }));
        if (u?.id) return u;
    } catch { /* deleted/blocked — unknown, said so honestly */ }
    return null;
}

/** Record every live DM (and their names) into the ledger. One REST call. */
export async function sweepLive(): Promise<number> {
    let channels: any[] = [];
    try {
        const res: any = await RestAPI.get({ url: "/users/@me/channels" });
        channels = Array.isArray(res?.body) ? res.body : [];
    } catch { /* offline / rate limited — next sweep will catch up */ }

    let friends = new Set<string>();
    try {
        const rel: any = await RestAPI.get({ url: "/users/@me/relationships" });
        friends = new Set<string>((Array.isArray(rel?.body) ? rel.body : []).filter((r: any) => r.type === 1).map((r: any) => String(r.id)));
    } catch { /* relationship unknown — record as undefined, not false */ }

    let n = 0;
    for (const ch of channels) {
        if (ch?.type !== 1) continue;
        const uid = String(ch.recipient_ids?.[0] ?? ch.recipients?.[0]?.id ?? "");
        if (!uid) continue;
        const rec = ch.recipients?.[0] ?? UserStore.getUser(uid);
        recordDm({
            userId: uid,
            channelId: String(ch.id),
            username: rec?.global_name ?? rec?.username,
            isFriend: friends.has(uid),
            source: "live",
        });
        if (rec?.id) recordName({ userId: String(rec.id), username: rec.username, globalName: rec.global_name });
        n++;
    }
    try {
        for (const uid of ChannelStore.getDMUserIds() ?? []) {
            const u: any = UserStore.getUser(String(uid));
            if (u?.id) recordName({ userId: String(u.id), username: u.username, globalName: u.globalName ?? u.global_name });
        }
    } catch { /* cache unavailable */ }
    return n;
}

// ─── floating window singleton (module-level; only one panel can exist) ──────

let stopFlag = { stop: false };

export function closeLedgerBrowser(): boolean {
    return closeFloating();
}

export function openLedgerBrowser(): void {
    const wasToggle = openFloating({
        storageKey: "DmLedger",
        title: "DmLedger — everyone you've ever DM'd",
        render: close => <LedgerBrowser close={close} />,
    });
    if (!wasToggle) void ledgerRefresh(); // pull in records sibling plugin copies made
}

// ─── the panel ───────────────────────────────────────────────────────────────

interface Busy { kind: "restore" | "resolve" | "sweep"; done: number; total: number; }

function LedgerBrowser({ close }: { close: () => void; }) {
    const [rows, setRows] = useState<LedgerDm[]>(ledgerDms());
    const [pkgPath, setPkgPath] = useState(() => safeStore.getItem(PKG_PATH_KEY) ?? "");
    const [pkgBusy, setPkgBusy] = useState(false);
    const [pkgMsg, setPkgMsg] = useState("");
    const [personQuery, setPersonQuery] = useState("");
    const [rosterMatches, setRosterMatches] = useState<RosterPerson[]>([]);
    const [rosterText, setRosterText] = useState("");
    const [rosterBusy, setRosterBusy] = useState(false);
    const [openId, setOpenId] = useState("");
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<LedgerFilter>("all");
    const [sel, setSel] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState<Busy | null>(null);

    // pull sibling copies' records shortly after mount (IDB read is async)
    useEffect(() => {
        void ledgerRefresh().then(refresh).catch(() => undefined);
    }, []);

    // Order-preserving refresh: re-sorting by lastSeen on every action makes
    // the row you just clicked (Open/Restore bumps lastSeen) jump from wherever
    // you scrolled to, to the TOP — which reads as "the window scrolled back
    // up". Existing rows keep their slot; only genuinely new records (sweep,
    // import, sibling plugins) append at the bottom, newest first.
    const refresh = () => setRows(prev => {
        const next = ledgerDms();
        if (!prev?.length) return next;
        const slot = new Map(prev.map((r, i) => [r.userId, i] as const));
        const kept = next.filter(r => slot.has(r.userId))
            .sort((a, b) => (slot.get(a.userId) ?? 0) - (slot.get(b.userId) ?? 0));
        const fresh = next.filter(r => !slot.has(r.userId));
        return kept.concat(fresh);
    });
    const visible = applyFilter(rows.filter(r => matchesQuery(r, query)), filter);
    const hiddenCount = rows.filter(r => r.isFriend === false).length;
    const unnamedCount = rows.filter(isUnnamed).length;

    const toggleSel = (userId: string) => {
        const next = new Set(sel);
        if (next.has(userId)) next.delete(userId); else next.add(userId);
        setSel(next);
    };
    const selectMany = (ids: string[], on: boolean) => {
        const next = new Set(sel);
        for (const id of ids) on ? next.add(id) : next.delete(id);
        setSel(next);
    };

    const toast = (message: string, failure = false) => showToast(message, failure ? "failure" : "success");

    const doOpen = async (row: LedgerDm) => {
        try {
            // channels the local client knows route instantly; ledger-only ones
            // need create-or-get first (it returns the ORIGINAL channel)
            let { channelId } = row;
            const known = Boolean(channelId) && Boolean(ChannelStore.getChannel?.(channelId));
            if (!known) {
                const r = await resolveDmByUserId(row.userId);
                channelId = r.channelId;
                recordDm({ userId: row.userId, channelId, username: r.recipientName, source: "restore" });
            }
            // Routing to a channel id the stores learned about ~100ms ago (from
            // the create-or-get response) can silently no-op — the view doesn't
            // exist yet, so the FIRST click feels dead and the second works.
            // Route, wait a beat, and if the selection didn't take, route again.
            routeUntil(channelId);
            refresh();
        } catch (e: any) {
            toast(`Couldn't open ${displayName(row)} — Discord refused (deleted/blocked?)`, true);
        }
    };

    /**
     * Open the archive dashboard with THIS row pre-selected: dispatch our own
     * /dm-dashboard command with the row's channel as context — the exact path
     * the chat-bar button uses. Ghost rows (channel evicted from the sidebar)
     * get create-or-get first, same as doOpen.
     */
    const doArchiveRow = async (row: LedgerDm) => {
        let { channelId } = row;
        if (!channelId || !ChannelStore.getChannel?.(channelId)) {
            try {
                const r = await resolveDmByUserId(row.userId);
                channelId = r.channelId;
                recordDm({ userId: row.userId, channelId, username: r.recipientName, source: "restore" });
                refresh();
            } catch {
                toast(`Couldn't reopen ${displayName(row)}'s DM — the dashboard will list it unselected`, true);
            }
        }
        // commandRegistry is untyped (Record<string, any>) — ctx carries only
        // what /dm-dashboard reads (channel.id); the cast is our call contract
        const cmd = commandRegistry?.["dm-dashboard"];
        if (!cmd) return toast("DmLedger's dashboard command is unavailable (Ctrl+R this client)", true);
        try {
            await cmd.execute([], { channel: { id: channelId } } as any);
        } catch {
            toast("Opening the archive dashboard failed", true);
        }
    };

    /**
     * Open MsgPurge's control panel. msgPurge is a SEPARATE plugin, so this
     * goes through the shared command registry (never a cross-plugin import —
     * the bundle must stay self-contained); honest toast if it's not installed.
     * Purge targets the DM on screen, so route there first when needed.
     */
    const doPurgeRow = async (row: LedgerDm) => {
        const cmd = commandRegistry?.msgpurge;
        if (!cmd) return toast("MsgPurge isn't installed/loaded — its panel can't open from here", true);
        if (!row.channelId || !ChannelStore.getChannel?.(row.channelId)) {
            // panel targets the on-screen DM → make this row's DM the selection
            await doOpen(row);
        }
        try {
            await cmd.execute([], {} as any);
        } catch {
            toast("Opening the msgPurge panel failed", true);
        }
    };

    const doForget = (row: LedgerDm) => {
        ledgerForget(row.userId);
        selectMany([row.userId], false);
        refresh();
    };

    const doCopy = (row: LedgerDm) => {
        copyToClipboard(JSON.stringify({ userId: row.userId, channelId: row.channelId, username: row.username }));
        toast("Copied ids to clipboard");
    };

    const restoreSelected = async () => {
        const ids = [...sel];
        if (!ids.length || busy) return;
        stopFlag = { stop: false };
        setBusy({ kind: "restore", done: 0, total: ids.length });
        let opened = 0, failed = 0, rateLimited = false;
        for (let i = 0; i < ids.length; i++) {
            if (stopFlag.stop) break;
            try {
                const r = await resolveDmByUserId(ids[i]);
                recordDm({ userId: ids[i], channelId: r.channelId, username: r.recipientName, source: "restore" });
                opened++;
            } catch (e: any) {
                if (e?.status === 429) { rateLimited = true; break; }
                failed++;
            }
            setBusy({ kind: "restore", done: i + 1, total: ids.length });
            if (i < ids.length - 1 && restorePaceMs()) await new Promise(r => setTimeout(r, restorePaceMs())); // Discord's POST budget is ~1/s
        }
        setBusy(null);
        refresh();
        toast(
            (stopFlag.stop ? "Stopped — " : "") + `restored ${opened}` + (failed ? `, refused ${failed}` : "")
            + (rateLimited ? ", stopped early on rate limit — select the rest and run again" : ""),
            failed > 0 || rateLimited,
        );
    };

    const resolveNames = async (targetIds: string[]) => {
        const ids = targetIds.filter(Boolean);
        if (!ids.length || busy) return;
        stopFlag = { stop: false };
        setBusy({ kind: "resolve", done: 0, total: ids.length });
        let found = 0, unknown = 0;
        for (let i = 0; i < ids.length; i++) {
            if (stopFlag.stop) break;
            const id = ids[i];
            let name: string | undefined;
            try {
                const cu: any = UserStore.getUser(id);
                name = cu?.globalName ?? cu?.global_name ?? cu?.username;
            } catch { /* cache unavailable */ }
            if (!name) {
                const u = await fetchUserLite(id);
                name = u?.global_name ?? u?.username;
                if (u?.id) recordName({ userId: id, username: u.username, globalName: u.global_name });
            }
            if (name) { found++; recordDm({ userId: id, username: name, source: "lookup" }); }
            else unknown++;
            setBusy({ kind: "resolve", done: i + 1, total: ids.length });
            if (i < ids.length - 1 && namePaceMs()) await new Promise(r => setTimeout(r, namePaceMs())); // profile endpoint ~10/10s
        }
        setBusy(null);
        refresh();
        toast(`resolved ${found}` + (unknown ? `, ${unknown} still unknown (deleted/blocked)` : ""));
    };

    const sweepNow = async () => {
        if (busy) return;
        stopFlag = { stop: false };
        setBusy({ kind: "sweep", done: 0, total: 1 });
        const n = await sweepLive();
        await ledgerRefresh();
        setBusy(null);
        refresh();
        toast(`Swept live DM list — ${n} recorded`);
    };

    const importPackage = async (usePicker = false) => {
        if (!Native || busy || pkgBusy) return;
        setPkgBusy(true);
        setPkgMsg("");
        try {
            let path = pkgPath.trim();
            if (usePicker) {
                const picked: any = await Native.chooseFolder();
                const chosen = typeof picked === "string" ? picked : picked?.path;
                if (!chosen) { setPkgBusy(false); return; }
                setPkgPath(chosen);
                safeStore.setItem(PKG_PATH_KEY, chosen);
                path = chosen;
            }
            const scan = await Native.scanPackage(path);
            if (!scan.ok) {
                setPkgMsg(`❌ ${scan.error}`);
                return;
            }
            const sum = mergeScanIntoLedger(scan);
            safeStore.setItem(PKG_PATH_KEY, path);
            refresh();
            setPkgMsg(
                `imported ${sum.imported} DM conversation(s) — ${sum.newPartners} new partner(s) now remembered permanently`
                + (sum.groupDms ? ` · ${sum.groupDms} group DM(s) skipped (not openable by id alone)` : "")
                + ` · ${sum.named} named from the package`,
            );
            // package omits profiles: any rows still named "user <id>" get a
            // paced live lookup, exactly like GhostDms does after import
            const unnamed = ledgerDms().filter(isUnnamed).map(d => d.userId);
            if (unnamed.length) void resolveNames(unnamed);
        } catch (e: any) {
            setPkgMsg(`❌ ${String(e?.message ?? e)}`);
        } finally {
            setPkgBusy(false);
        }
    };

    // local-cache search as you type (zero API calls); excludes ledger partners
    const localMatches = searchPeopleCache(personQuery, new Set(rows.map(r => r.userId)));

    const deepSearchRosters = async () => {
        if (personQuery.trim().length < 2) {
            setRosterText("Type at least 2 letters of their name above first.");
            return;
        }
        setRosterBusy(true);
        setRosterMatches([]);
        setRosterText("searching every server you're in…");
        stopFlag = { stop: false };
        try {
            const res = await searchGuildRosters(personQuery, {
                exclude: new Set(rows.map(r => r.userId)),
                stop: stopFlag,
                paceMs: rosterPaceMs(),
                onProgress: (done, total) => setRosterText(`searching servers ${done}/${total}…`),
            });
            setRosterMatches(res.persons);
            setRosterText(res.rateLimited
                ? `stopped early at Discord's rate limit — ${res.persons.length} match(es) from ${res.searched} server(s)`
                : `${res.persons.length} match(es) from ${res.searched} server(s)`);
        } catch (error: any) {
            setRosterText(`search failed: ${String(error?.message ?? error)}`);
        } finally {
            setRosterBusy(false);
        }
    };

    // Open a DM with ANY user id, even one the ledger has never seen:
    // create-or-get returns the EXISTING channel (history intact) if a DM ever
    // existed; only a never-DM'd user yields a fresh empty channel.
    const openPersonById = async (rawId: string) => {
        const id = rawId.trim();
        if (!/^\d{15,20}$/.test(id)) {
            setRosterText("That doesn't look like a Discord user ID (15-20 digits).");
            return;
        }
        setOpenId(id);
        try {
            const { channelId, recipientName } = await resolveDmByUserId(id);
            recordDm({ userId: id, channelId, username: recipientName, source: "restore" });
            routeUntil(channelId);
            refresh();
        } catch {
            setRosterText(`Couldn't open user ${id} — Discord refused (deleted/blocked?)`);
        } finally {
            setOpenId("");
        }
    };

    const doExport = () => {
        const payload = {
            exportedAt: new Date().toISOString(),
            partners: ledgerDms().map(r => ({
                userId: r.userId, channelId: r.channelId, username: r.username,
                isFriend: r.isFriend, firstSeen: new Date(r.firstSeen).toISOString(),
                lastSeen: new Date(r.lastSeen).toISOString(), source: r.source,
            })),
        };
        copyToClipboard(JSON.stringify(payload, null, 2));
        toast(`Ledger exported — ${payload.partners.length} partner(s) copied to clipboard as JSON`);
    };

    // The ledger's value is surviving wipes, which means surviving THIS client's
    // IndexedDB dying. Save writes the full roster (incl. the name cache) to a
    // real file: the configured Download folder, else a save dialog.
    const doSaveBackup = async () => {
        const payload = ledgerBackupPayload();
        const name = `dm-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
        try {
            const folder = (SettingsStore.plain?.plugins?.DmLedger?.downloadFolder ?? "").trim();
            await saveFile(new TextEncoder().encode(JSON.stringify(payload, null, 2)), name, folder);
            toast(`Backup saved — ${payload.partners.length} partner(s) + ${payload.names.length} name(s) → ${folder || "save dialog"}`);
        } catch (e) {
            toast(`Backup failed: ${String(e).slice(0, 100)}`, true);
        }
    };

    const doRestoreBackup = async () => {
        if (!Native?.pickFile || !Native?.readBackupFile) {
            toast("Restore needs the desktop app (file picker)", true);
            return;
        }
        const picked: any = await Native.pickFile();
        const path = typeof picked === "string" ? picked : picked?.path;
        if (!path) return;
        const res = await Native.readBackupFile(path);
        if (!res?.ok) {
            toast(`Backup unreadable: ${res?.error ?? "unknown"}`, true);
            return;
        }
        const out = ledgerImportBackup(res.data);
        if (!out.ok) {
            toast(`Not a DmLedger backup: ${out.error}`, true);
            return;
        }
        refresh();
        toast(`Backup restored — ${out.imported} new, ${out.merged} merged, ${out.skipped} skipped`);
    };

    const btn = "margin-left:6px;padding:3px 10px;font-size:12px";
    const filterBtn = (key: LedgerFilter, label: string) => (
        <Button
            key={key}
            size="xs"
            variant={filter === key ? "primary" : "secondary"}
            disabled={Boolean(busy)}
            title={
                key === "all" ? "Show everyone in the ledger"
                    : key === "hidden" ? "Only DM partners Discord won't show you normally (non-friends / channels it dropped from your list)"
                        : "Rows with no known display name yet — use Resolve names to look them up"
            }
            onClick={() => setFilter(key)}
        >
            {label}
        </Button>
    );
    const rowIds = visible.map(r => r.userId);

    return (
        <div style={{ fontSize: 13 }}>
            <Text variant="text-sm/normal">
                {`${ledgerDmCount()} partner(s) remembered · ${hiddenCount} hidden · ${unnamedCount} unnamed · ${ledgerNameCount()} names`}
            </Text>

            {Native && (
                <div style={{ marginTop: 4 }}>
                    <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                        <div style={{ flex: 1 }}>
                            <TextInput
                                value={pkgPath}
                                placeholder="C:\\Users\\you\\Downloads\\discord-package (unzipped Request-Data folder)"
                                onChange={(v: string) => setPkgPath(v)}
                            />
                        </div>
                        <Button
                            size="xs"
                            variant="secondary"
                            disabled={pkgBusy || Boolean(busy)}
                            title="Picks the extracted data-package folder with a folder browser"
                            onClick={() => void importPackage(true)}
                        >
                            Browse…
                        </Button>
                        <Button
                            size="xs"
                            variant="primary"
                            disabled={pkgBusy || Boolean(busy) || !pkgPath.trim()}
                            title="Reads your Discord data export (Settings → Privacy & Safety → Request all my Data, then UNZIP it) and permanently remembers every DM conversation it contains — including ones Discord has hidden from you. Read-only: never writes to the package, never sends anything"
                            onClick={() => void importPackage(false)}
                        >
                            Import package
                        </Button>
                    </div>
                    {pkgMsg && (
                        <Text variant="text-xs/normal">{pkgMsg}</Text>
                    )}
                </div>
            )}

            <div style={{ marginTop: 8, display: "flex", gap: "6px", alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                    <TextInput
                        value={query}
                        placeholder="Search name, user id, channel id…"
                        onChange={(v: string) => setQuery(v)}
                    />
                </div>
            </div>

            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                {filterBtn("all", `All (${rows.length})`)}
                {filterBtn("hidden", `Hidden (${hiddenCount})`)}
                {filterBtn("unnamed", `Unnamed (${unnamedCount})`)}
                <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Records every DM currently on Discord's live list into the ledger (one API call) — keeps the roster fresh"
                    onClick={() => void sweepNow()}
                >
                    Sweep live
                </Button>
                <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Copy the entire roster (ids, names, friendship, seen-dates) as JSON to your clipboard — your data, no upload"
                    onClick={doExport}
                >
                    Export JSON
                </Button>
                <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Write the FULL ledger (partners + name cache) to a JSON file in your Download folder (or pick one) — survives reinstalls, wiped caches, new machines"
                    onClick={() => void doSaveBackup()}
                >
                    Save file
                </Button>
                {Native && (
                    <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Merge a backup file you saved earlier back into this ledger (dates keep their history; nothing is erased)"
                        onClick={() => void doRestoreBackup()}
                    >
                        Restore backup
                    </Button>
                )}
            </div>

            {busy && (
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: "8px" }}>
                    <Text variant="text-sm/normal">{`${busy.kind === "resolve" ? "resolving" : busy.kind === "sweep" ? "sweeping" : "restoring"} ${busy.done}/${busy.total}…`}</Text>
                    <Button size="xs" variant="dangerPrimary" title="Halt the current batch (already-completed items stay done)" onClick={() => (stopFlag.stop = true)}>
                        Stop
                    </Button>
                </div>
            )}

            {rowIds.length > 0 && (
                <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
                    <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Select every row visible right now (after your search/filter)" onClick={() => selectMany(rowIds, true)}>
                        Select all ({rowIds.length})
                    </Button>
                    <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Clear the selection" onClick={() => setSel(new Set())}>
                        Clear
                    </Button>
                    {sel.size > 0 && [
                            <Text key="c" variant="text-xs/normal">{`${sel.size} selected`}</Text>,
                            <Button key="r" size="xs" variant="primary" disabled={Boolean(busy)} title="Ask Discord to reopen ALL selected DMs (paced ~1/sec so you don't get rate-limited; Stop works mid-run)" onClick={() => void restoreSelected()}>
                                Restore {sel.size}
                            </Button>,
                            <Button key="n" size="xs" variant="secondary" disabled={Boolean(busy)} title="Look up real display names for selected rows via Discord (paced ~1.1s apart; rows that stay 'user <id>' are deleted/blocked accounts)" onClick={() => void resolveNames([...sel])}>
                                Resolve names {sel.size}
                            </Button>,
                            <Button
                                key="f"
                                size="xs"
                                variant="dangerPrimary"
                                disabled={Boolean(busy)}
                                title="Delete these rows from the remembered roster ONLY — nothing on Discord is touched"
                                onClick={() => { for (const id of [...sel]) ledgerForget(id); setSel(new Set()); refresh(); }}
                            >
                                Forget {sel.size}
                            </Button>,
                    ]}
                </div>
            )}

            <div style={{ marginTop: 8, display: "flex", gap: "6px", alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                    <TextInput
                        value={personQuery}
                        placeholder="Find someone you've NEVER DM'd — name or past shared server…"
                        onChange={(v: string) => { setPersonQuery(v); setRosterMatches([]); if (!rosterBusy) setRosterText(""); }}
                    />
                </div>
                {personQuery.trim().length >= 2 && (
                    rosterBusy ? (
                        <Button size="xs" variant="dangerPrimary" title="Halt the server-roster sweep (matches found so far stay listed)" onClick={() => (stopFlag.stop = true)}>
                            Stop
                        </Button>
                    ) : (
                        <Button size="xs" variant="primary" disabled={Boolean(busy)} title="Asks every server you're in to search its FULL member list server-side — finds people not in your local cache at all (paced, stops on rate limit)" onClick={() => void deepSearchRosters()}>
                            Search all servers
                        </Button>
                    )
                )}
                <Button size="xs" variant="secondary" title="Opens a DM with an exact user ID — create-or-get returns the original channel if one ever existed (history intact), otherwise starts a fresh DM" onClick={() => void openPersonById(personQuery)}>
                    Open by ID
                </Button>
            </div>

            {personQuery.trim().length >= 2 && (
                <div style={{ marginTop: 4 }}>
                    {rosterText && <Text variant="text-xs/normal">{rosterText}</Text>}
                    {localMatches.length > 0 && (
                        <>
                            <Text variant="text-xs/normal">{"From local cache (instant, no API):"}</Text>
                            {localMatches.slice(0, 10).map(p => (
                                <div key={p.userId} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "2px 0" }}>
                                    <span style={{ flex: 1 }}>{p.username}</span>
                                    <Text variant="text-xs/normal">{`id ${p.userId}`}</Text>
                                    <Button size="xs" variant="secondary" disabled={Boolean(openId)} title="Opens the original conversation if a DM ever existed, else a fresh DM. The ledger remembers them afterwards." onClick={() => void openPersonById(p.userId)}>
                                        {openId === p.userId ? "opening…" : "Open DM"}
                                    </Button>
                                </div>
                            ))}
                        </>
                    )}
                    {rosterMatches.length > 0 && (
                        <>
                            <Text variant="text-xs/normal">{"From server rosters:"}</Text>
                            {rosterMatches.slice(0, 25).map(p => (
                                <div key={p.userId} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "2px 0" }}>
                                    <span style={{ flex: 1 }}>{p.username}</span>
                                    <Text variant="text-xs/normal">{`in ${p.inGuild}`}</Text>
                                    <Button size="xs" variant="secondary" disabled={Boolean(openId)} title="Opens the original conversation if a DM ever existed, else a fresh DM. The ledger remembers them afterwards." onClick={() => void openPersonById(p.userId)}>
                                        {openId === p.userId ? "opening…" : "Open DM"}
                                    </Button>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            )}

            <div style={{ marginTop: 8 }}>
                {visible.map(row => (
                    <div
                        key={row.userId}
                        style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 0", borderTop: "1px solid var(--border-subtle,#2b2d31)" }}
                    >
                        <Checkbox
                            value={sel.has(row.userId)}
                            disabled={Boolean(busy)}
                            onChange={() => toggleSel(row.userId)}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
                                {displayName(row)}
                                {row.isFriend === false ? " · hidden" : row.isFriend === true ? " · friend" : ""}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--text-muted,#949ba4)" }}>
                                {`src ${row.source} · seen ${formatStamp(row.lastSeen)}`
                                    + (isUnnamed(row) && snowflakeDate(row.userId) ? ` · acct ${snowflakeDate(row.userId)}` : "")}
                            </div>
                        </div>
                        <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Opens this DM — if your list no longer has the channel, it first asks Discord to reopen it (same channel, history intact)" onClick={() => void doOpen(row)}>
                            Open
                        </Button>
                        <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Open the archive dashboard with THIS DM pre-selected (export its media + transcript to your download folder)" onClick={() => void doArchiveRow(row)}>
                            Archive
                        </Button>
                        <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Open the msgPurge panel (deletes ONLY your own messages, rate-limited; needs the separate MsgPurge plugin)" onClick={() => void doPurgeRow(row)}>
                            Purge
                        </Button>
                        <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Copies this partner's user id + channel id as JSON to your clipboard (paste it into other tools/plugins)" onClick={() => doCopy(row)}>
                            Copy
                        </Button>
                        <Button size="xs" variant="secondary" disabled={Boolean(busy)} title="Deletes ONLY this row from the remembered roster — never deletes anything on Discord" onClick={() => doForget(row)}>
                            Forget
                        </Button>
                    </div>
                ))}
                {!visible.length && (
                    <Text variant="text-sm/normal">
                        {rows.length ? "No rows match the current search/filter." : "The ledger is empty so far — DM someone, hit 'Sweep live', import your Discord data package above, or just use MsgPurge / the archive dashboard and records will accumulate here automatically."}
                    </Text>
                )}
            </div>

            <div style={{ marginTop: 10 }}>
                <Text variant="text-xs/normal">
                    {"Stored on THIS device only (Vencord IndexedDB). Restoring uses Discord's create-or-get — it returns your original channel. Forget/Delete here only forgets the ledger row, never Discord data."}
                </Text>
            </div>
            <div style={{ marginTop: 6 }}>
                <Button size="xs" variant="secondary" title="Close this window (the ledger keeps recording in the background)" onClick={close}>
                    Close
                </Button>
            </div>
        </div>
    );
}
