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

import { Button } from "@components/Button";
import { copyToClipboard } from "@utils/clipboard";
import {
    ChannelRouter,
    ChannelStore,
    Checkbox,
    RestAPI,
    Text,
    TextInput,
    Toasts,
    useEffect,
    UserStore,
    useState,
} from "@webpack/common";

import { closeFloating, openFloating } from "./floating";
import { type LedgerDm, ledgerDmCount, ledgerDms, ledgerForget, ledgerNameCount, ledgerRefresh, recordDm, recordName } from "./ledger";

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
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<LedgerFilter>("all");
    const [sel, setSel] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState<Busy | null>(null);

    // pull sibling copies' records shortly after mount (IDB read is async)
    useEffect(() => {
        void ledgerRefresh().then(() => setRows(ledgerDms())).catch(() => undefined);
    }, []);

    const refresh = () => setRows(ledgerDms());
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

    const toast = (message: string, failure = false) =>
        Toasts.show({ message, id: Toasts.genId(), type: failure ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS });

    const doOpen = async (row: LedgerDm) => {
        try {
            // channels the local client knows route instantly; ledger-only ones
            // need create-or-get first (it returns the ORIGINAL channel)
            let { channelId } = row;
            if (!channelId || !ChannelStore.getChannel?.(channelId)) {
                const r = await resolveDmByUserId(row.userId);
                channelId = r.channelId;
                recordDm({ userId: row.userId, channelId, username: r.recipientName, source: "restore" });
                refresh();
            }
            ChannelRouter.transitionToChannel(channelId);
        } catch (e: any) {
            toast(`Couldn't open ${displayName(row)} — Discord refused (deleted/blocked?)`, true);
        }
    };

    const doRestoreOne = async (row: LedgerDm) => {
        try {
            const r = await resolveDmByUserId(row.userId);
            recordDm({ userId: row.userId, channelId: r.channelId, username: r.recipientName, source: "restore" });
            refresh();
            toast(`Restored ${row.username ?? "DM"}`);
        } catch {
            toast(`Restore refused for ${displayName(row)}`, true);
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
            if (i < ids.length - 1) await new Promise(r => setTimeout(r, 750)); // Discord's POST budget is ~1/s
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
            if (i < ids.length - 1) await new Promise(r => setTimeout(r, 1100)); // profile endpoint ~10/10s
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

    const btn = "margin-left:6px;padding:3px 10px;font-size:12px";
    const filterBtn = (key: LedgerFilter, label: string) => (
        <Button
            key={key}
            variant={filter === key ? "primary" : "secondary"}
            disabled={Boolean(busy)}
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

            <div style={{ marginTop: 8, display: "flex", gap: "6px", alignItems: "center" }}>
                <div style={{ flex: 1 }}>
                    <TextInput
                        value={query}
                        placeholder="Search name, user id, channel id…"
                        onChange={(v: string) => setQuery(v)}
                    />
                </div>
            </div>

            <div style={{ marginTop: 8 }}>
                {filterBtn("all", `All (${rows.length})`)}
                {filterBtn("hidden", `Hidden (${hiddenCount})`)}
                {filterBtn("unnamed", `Unnamed (${unnamedCount})`)}
                <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void sweepNow()}>
                    Sweep live
                </Button>
                <Button variant="secondary" disabled={Boolean(busy)} onClick={doExport}>
                    Export JSON
                </Button>
            </div>

            {busy && (
                <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: "8px" }}>
                    <Text variant="text-sm/normal">{`${busy.kind === "resolve" ? "resolving" : busy.kind === "sweep" ? "sweeping" : "restoring"} ${busy.done}/${busy.total}…`}</Text>
                    <Button variant="dangerPrimary" onClick={() => (stopFlag.stop = true)}>
                        Stop
                    </Button>
                </div>
            )}

            {rowIds.length > 0 && (
                <div style={{ marginTop: 8 }}>
                    <Button variant="secondary" disabled={Boolean(busy)} onClick={() => selectMany(rowIds, true)}>
                        Select all ({rowIds.length})
                    </Button>
                    <Button variant="secondary" disabled={Boolean(busy)} onClick={() => setSel(new Set())}>
                        Clear
                    </Button>
                    {sel.size > 0 && [
                            <Text key="c" variant="text-xs/normal">{`${sel.size} selected`}</Text>,
                            <Button key="r" variant="primary" disabled={Boolean(busy)} onClick={() => void restoreSelected()}>
                                Restore {sel.size}
                            </Button>,
                            <Button key="n" variant="secondary" disabled={Boolean(busy)} onClick={() => void resolveNames([...sel])}>
                                Resolve names {sel.size}
                            </Button>,
                            <Button
                                key="f"
                                variant="dangerPrimary"
                                disabled={Boolean(busy)}
                                onClick={() => { for (const id of [...sel]) ledgerForget(id); setSel(new Set()); refresh(); }}
                            >
                                Forget {sel.size}
                            </Button>,
                    ]}
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
                        <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void doOpen(row)}>
                            Open
                        </Button>
                        <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void doRestoreOne(row)}>
                            Restore
                        </Button>
                        <Button variant="secondary" disabled={Boolean(busy)} onClick={() => doCopy(row)}>
                            Copy
                        </Button>
                        <Button variant="secondary" disabled={Boolean(busy)} onClick={() => doForget(row)}>
                            Forget
                        </Button>
                    </div>
                ))}
                {!visible.length && (
                    <Text variant="text-sm/normal">
                        {rows.length ? "No rows match the current search/filter." : "The ledger is empty so far — DM someone, run 'Sweep live', or use GhostDms/msgPurge and records will accumulate."}
                    </Text>
                )}
            </div>

            <div style={{ marginTop: 10 }}>
                <Text variant="text-xs/normal">
                    {"Stored on THIS device only (Vencord IndexedDB). Restoring uses Discord's create-or-get — it returns your original channel. Forget/Delete here only forgets the ledger row, never Discord data."}
                </Text>
            </div>
            <div style={{ marginTop: 6 }}>
                <Button variant="secondary" onClick={close}>
                    Close
                </Button>
            </div>
        </div>
    );
}
