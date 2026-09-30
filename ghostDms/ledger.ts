/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// DmLedger core: a client-side, permanent registry of DM partners + display
// names this client has ever observed. Storage is Vencord's DataStore
// (IndexedDB) — survives restarts and Vencord updates, unlike the in-memory
// stores which only know Discord's ~100 recent DM window.
//
// DISTRIBUTION NOTE: this file is copied into each plugin folder that uses the
// ledger (same policy as floating.tsx — every plugin folder stays drop-in
// installable). All copies read/write the SAME DataStore keys, so the roster
// is shared across plugins and restarts; call ledgerRefresh() when a panel
// opens to pull in records another copy made this session. A plugin installed
// WITHOUT the DmLedger capture plugin still works — it just contributes its
// own records and misses passive send-time capture.

import * as DataStore from "@api/DataStore";

const KEY_PREFIX = "DmLedger.v1.";

export interface LedgerDm {
    userId: string;
    channelId: string;
    username?: string;    // best-known name at record time
    isFriend?: boolean;   // known-friend at record time (drives the ghost tag later)
    firstSeen: number;    // epoch ms
    lastSeen: number;     // epoch ms
    source: string;       // "live" | "sent" | "package" | "restore" | "cache" | "lookup"
}

export interface LedgerName {
    userId: string;
    username?: string;
    globalName?: string;  // display name — what Discord's UI actually shows
    lastSeen: number;
}

// in-memory mirror: reads are synchronous (UI renders call them), writes are
// queued to IndexedDB on one shared chain so ordering stays sane.
const dmCache = new Map<string, LedgerDm>();
const nameCache = new Map<string, LedgerName>();
let writeChain: Promise<any> = Promise.resolve();
let loadInFlight: Promise<void> | null = null;
let everLoaded = false;

function enqueue(fn: () => Promise<any>): void {
    writeChain = writeChain.then(fn).catch(() => { /* storage is best-effort; the mirror already has it */ });
}

// merge, never clobber: records this copy made before/after the async read
// keep their fresher fields; disk fills gaps and extends history.
function mergeStoredDm(stored: LedgerDm): void {
    const fresh = dmCache.get(stored.userId);
    if (!fresh) { dmCache.set(stored.userId, stored); return; }
    dmCache.set(stored.userId, {
        userId: stored.userId,
        channelId: fresh.channelId || stored.channelId,
        username: fresh.username ?? stored.username,
        isFriend: fresh.isFriend ?? stored.isFriend,
        firstSeen: Math.min(fresh.firstSeen, stored.firstSeen),
        lastSeen: Math.max(fresh.lastSeen, stored.lastSeen),
        source: fresh.source,
    });
}

async function readOnce(): Promise<void> {
    try {
        const entries = await DataStore.entries<string, LedgerDm | LedgerName>();
        for (const [k, v] of entries) {
            if (!k.startsWith(KEY_PREFIX) || !v || typeof v !== "object") continue;
            if (k.startsWith(KEY_PREFIX + "name.")) {
                const stored = v as LedgerName;
                const fresh = nameCache.get(stored.userId);
                if (!fresh || (fresh.username === stored.username && fresh.globalName === stored.globalName)) {
                    if (!fresh) nameCache.set(stored.userId, stored);
                } else {
                    nameCache.set(stored.userId, {
                        userId: stored.userId,
                        username: fresh.username ?? stored.username,
                        globalName: fresh.globalName ?? stored.globalName,
                        lastSeen: Math.max(fresh.lastSeen, stored.lastSeen),
                    });
                }
            } else if (k.startsWith(KEY_PREFIX + "dm.")) {
                mergeStoredDm(v as LedgerDm);
            }
        }
    } catch { /* empty/blocked IDB — mirror just stays as-is */ }
    everLoaded = true;
}

function load(): Promise<void> {
    if (loadInFlight) return loadInFlight;
    const p = readOnce().finally(() => { if (loadInFlight === p) loadInFlight = null; });
    loadInFlight = p;
    return p;
}

// Eager hydrate at module load; sync readers tolerate a blank mirror for the
// few ms the first IDB read takes (real UIs re-render, harnesses await).
void load();

/** ensure the first hydrate finished (start() hooks, tests) */
export function ledgerReady(): Promise<void> {
    return load();
}

/**
 * Re-read DataStore and merge into the mirror — picks up records another
 * plugin's copy made this session. Call when a panel opens.
 */
export async function ledgerRefresh(): Promise<void> {
    await load();
    await readOnce();
}

/**
 * Record a DM partner (and their channel id). Idempotent + merge-friendly:
 * never downgrades an existing username/channel, always bumps lastSeen.
 * Steady-state traffic (same facts) writes nothing to disk.
 */
export function recordDm(entry: {
    userId: string; channelId?: string; username?: string; isFriend?: boolean; source: string;
}): void {
    const userId = String(entry.userId ?? "");
    if (!/^[0-9]{15,25}$/.test(userId)) return; // real snowflakes only — no junk keys
    const now = Date.now();
    const existing = dmCache.get(userId);
    const merged: LedgerDm = {
        userId,
        channelId: entry.channelId || existing?.channelId || "",
        username: entry.username ?? existing?.username,
        isFriend: entry.isFriend ?? existing?.isFriend,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now,
        source: existing && !existing.source.split("+").includes(entry.source)
            ? existing.source + "+" + entry.source
            : existing?.source ?? entry.source,
    };
    const unchanged = existing
        && existing.channelId === merged.channelId
        && existing.username === merged.username
        && existing.isFriend === merged.isFriend
        && existing.source === merged.source;
    dmCache.set(userId, merged);
    if (!unchanged) enqueue(() => DataStore.set(KEY_PREFIX + "dm." + userId, merged));
}

/** Remember a display name for a user id (display name preferred, handle kept too). */
export function recordName(entry: { userId: string; username?: string; globalName?: string; }): void {
    const userId = String(entry.userId ?? "");
    if (!/^[0-9]{15,25}$/.test(userId)) return;
    if (!entry.username && !entry.globalName) return;
    const existing = nameCache.get(userId);
    const merged: LedgerName = {
        userId,
        username: entry.username ?? existing?.username,
        globalName: entry.globalName ?? existing?.globalName,
        lastSeen: Date.now(),
    };
    const unchanged = existing
        && existing.username === merged.username
        && existing.globalName === merged.globalName;
    nameCache.set(userId, merged);
    if (!unchanged) enqueue(() => DataStore.set(KEY_PREFIX + "name." + userId, merged));
}

// ─── synchronous reads (usable straight from render) ────────────────────────

/** best-known display name for a user (display name first, like Discord's UI) */
export function ledgerNameFor(userId: string): string | undefined {
    const n = nameCache.get(userId);
    return n?.globalName ?? n?.username;
}

export function ledgerDmCount(): number {
    return dmCache.size;
}

export function ledgerNameCount(): number {
    return nameCache.size;
}

/** every partner ever seen, newest activity first */
export function ledgerDms(): LedgerDm[] {
    return [...dmCache.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/** ghost = not-friend partners the ledger remembers (may not exist in any live list) */
export function ledgerGhostDms(): LedgerDm[] {
    return ledgerDms().filter(d => d.isFriend === false && d.channelId);
}

export function ledgerDmFor(userId: string): LedgerDm | undefined {
    return dmCache.get(userId);
}

// ─── maintenance ────────────────────────────────────────────────────────────

/** forget one partner (their DM row + remembered name) */
export function ledgerForget(userId: string): void {
    dmCache.delete(userId);
    nameCache.delete(userId);
    enqueue(() => DataStore.del(KEY_PREFIX + "dm." + userId));
    enqueue(() => DataStore.del(KEY_PREFIX + "name." + userId));
}

/** wipe the whole ledger (keys are prefixed — other plugins' DataStore rows are untouched) */
export function ledgerWipe(): void {
    dmCache.clear();
    nameCache.clear();
    everLoaded = false;
    enqueue(async () => {
        const keys = await DataStore.keys<string>();
        await DataStore.delMany(keys.filter(k => typeof k === "string" && k.startsWith(KEY_PREFIX)));
    });
}

/** flush pending writes (tests / tidy shutdown) */
export function ledgerFlush(): Promise<void> {
    return writeChain;
}
