/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// GuildLedger core: a client-side, permanent registry of servers this client
// has ever observed — the guild twin of DmLedger's roster. Storage is
// Vencord's DataStore (IndexedDB): Discord's GuildStore only knows servers
// you're currently in, and forgets them the moment you leave.
//
// Sources, weakest to strongest:
//   "live"       GUILD_CREATE / startup snapshot while actually a member
//   "left"       GUILD_DELETE: captured final metadata the instant it vanishes
//   "backfill"   imported from a data-package telemetry export (ids+names+dates)
// A record's status is derived, never stored stale: inGuild() says whether
// GuildStore still has it RIGHT NOW.

import * as DataStore from "@api/DataStore";
import { FluxDispatcher, GuildMemberStore, GuildStore, UserStore } from "@webpack/common";

const KEY_PREFIX = "GuildLedger.v1.";

// hard cap on a captured roster, per server. Discord's chunk request itself
// caps at 1000, so this only bounds passive drift (members joining over time).
export const MEMBER_CAP = 1000;

export interface LedgerGuild {
    guildId: string;
    name?: string; // best-known name at record time
    memberCount?: number | null;
    owner?: boolean; // you owned it at some capture point
    firstSeen: number; // epoch ms
    lastSeen: number;
    source: string; // "live" | "left" | "backfill"
    icon?: string; // icon hash while we could see it — renders forever via CDN while the server exists
    description?: string;
    // "who was there": [id, displayName] pairs captured while we were a member.
    // Historical rosters of ALREADY-left servers cannot be recovered (Discord
    // never sends them), so the ledger grabs them before you leave.
    memberSnapshot?: Array<[string, string]>;
    snapshotAt?: number; // epoch ms of the last snapshot growth
    // backfill extras (coarser than live captures)
    firstSeenDate?: string; // "2018-01-01" from telemetry
    lastSeenDate?: string;
    strongEvents?: number; // voice/message/view events in telemetry = proof of real presence
}

const guildCache = new Map<string, LedgerGuild>();
let writeChain: Promise<any> = Promise.resolve();
let loadInFlight: Promise<void> | null = null;

function enqueue(fn: () => Promise<any>): void {
    writeChain = writeChain.then(fn).catch(() => { /* best-effort; mirror already has it */ });
}

function mergeStored(stored: LedgerGuild): void {
    const fresh = guildCache.get(stored.guildId);
    if (!fresh) { guildCache.set(stored.guildId, stored); return; }
    guildCache.set(stored.guildId, {
        guildId: stored.guildId,
        name: fresh.name ?? stored.name,
        memberCount: fresh.memberCount ?? stored.memberCount,
        owner: fresh.owner || stored.owner,
        icon: fresh.icon ?? stored.icon,
        description: fresh.description ?? stored.description,
        firstSeen: Math.min(fresh.firstSeen, stored.firstSeen),
        lastSeen: Math.max(fresh.lastSeen, stored.lastSeen),
        // "live"/"left" beat "backfill" — a real capture is stronger evidence
        source: fresh.source === "backfill" ? stored.source : fresh.source,
        firstSeenDate: stored.firstSeenDate ?? fresh.firstSeenDate,
        lastSeenDate: fresh.lastSeenDate ?? stored.lastSeenDate,
        strongEvents: Math.max(fresh.strongEvents ?? 0, stored.strongEvents ?? 0) || undefined,
        memberSnapshot: mergeSnapshots(fresh.memberSnapshot, stored.memberSnapshot),
        snapshotAt: Math.max(fresh.snapshotAt ?? 0, stored.snapshotAt ?? 0) || undefined,
    });
}

/** union two [id, name] snapshots — FIRST arg's names win for shared ids,
 *  second arg only contributes NEW ids. Sorted by id so roster row order is
 *  deterministic across refreshes/restarts (hydrate order otherwise drifts).
 *  Callers pass newer-wins material first: (memory, disk) when hydrating,
 *  (existing, fresh chunk) when recording. Capped at MEMBER_CAP. */
export function mergeSnapshots(a?: Array<[string, string]>, b?: Array<[string, string]>): Array<[string, string]> | undefined {
    if (!a?.length) return b?.length ? [...b].sort((x, y) => x[0] < y[0] ? -1 : 1).slice(0, MEMBER_CAP) : undefined;
    if (!b?.length) return [...a].sort((x, y) => x[0] < y[0] ? -1 : 1).slice(0, MEMBER_CAP);
    const seen = new Map<string, string>();
    for (const [id, nm] of a) seen.set(id, nm); // first arg wins
    for (const [id, nm] of b) if (!seen.has(id)) seen.set(id, nm); // new appended
    return [...seen].sort((x, y) => x[0] < y[0] ? -1 : 1).slice(0, MEMBER_CAP);
}

async function readOnce(): Promise<void> {
    try {
        const entries = await DataStore.entries<string, LedgerGuild>();
        for (const [k, v] of entries) {
            if (!k.startsWith(KEY_PREFIX) || !v || typeof v !== "object" || !v.guildId) continue;
            mergeStored(v);
        }
    } catch { /* empty/blocked IDB — mirror stays as-is */ }
}

function load(): Promise<void> {
    if (loadInFlight) return loadInFlight;
    const p = readOnce().finally(() => { if (loadInFlight === p) loadInFlight = null; });
    loadInFlight = p;
    return p;
}
void load();

export function guildLedgerReady(): Promise<void> {
    return load();
}

/** re-read DataStore (other plugin copies / fresh backfill) */
export async function guildLedgerRefresh(): Promise<void> {
    await load();
    await readOnce();
}

/** upsert one sighting; merge semantics keep history honest */
export function guildLedgerRecord(g: Partial<LedgerGuild> & { guildId: string, source?: string, firstSeenMs?: number, snapshotAtMs?: number }): void {
    const now = Date.now();
    const prev = guildCache.get(g.guildId);
    const backfillStart = Date.parse(g.firstSeenDate ?? "") || Infinity;
    // backup restore passes firstSeenMs directly (epoch numbers, not telemetry date-strings)
    const seenStart = g.firstSeenMs ?? Math.min(g.firstSeen ?? Infinity, backfillStart);
    const snapshot = g.memberSnapshot !== undefined ? mergeSnapshots(prev?.memberSnapshot, g.memberSnapshot) : prev?.memberSnapshot;
    const rec: LedgerGuild = {
        guildId: g.guildId,
        name: g.name ?? prev?.name,
        memberCount: g.memberCount ?? prev?.memberCount,
        owner: (g.owner || prev?.owner) || undefined,
        firstSeen: Math.min(prev?.firstSeen ?? Infinity, seenStart === Infinity ? now : seenStart),
        lastSeen: Math.max(prev?.lastSeen ?? 0, g.lastSeen ?? now),
        source: g.source ?? prev?.source ?? "live",
        icon: g.icon ?? prev?.icon,
        description: g.description ?? prev?.description,
        firstSeenDate: g.firstSeenDate ?? prev?.firstSeenDate,
        lastSeenDate: g.lastSeenDate ?? prev?.lastSeenDate,
        strongEvents: Math.max(prev?.strongEvents ?? 0, g.strongEvents ?? 0) || undefined,
        memberSnapshot: snapshot,
        // only stamp when THIS call actually contributed roster material
        snapshotAt: g.memberSnapshot?.length ? (g.snapshotAtMs ?? now) : (prev?.snapshotAt ?? g.snapshotAtMs),
    };
    guildCache.set(g.guildId, rec);
    enqueue(() => DataStore.set(KEY_PREFIX + g.guildId, rec));
}

export function guildLedgerList(filter?: "gone" | "member" | null, inGuild?: (id: string) => boolean): LedgerGuild[] {
    let list = [...guildCache.values()];
    if (filter && inGuild) {
        list = filter === "gone" ? list.filter(g => !inGuild(g.guildId)) : list.filter(g => inGuild(g.guildId));
    }
    return list.sort((a, b) => a.firstSeen - b.firstSeen);
}

export function guildLedgerGet(id: string): LedgerGuild | undefined {
    return guildCache.get(id);
}

export function guildLedgerCount(): number {
    return guildCache.size;
}

export function guildLedgerForget(id: string): boolean {
    const had = guildCache.delete(id);
    if (had) enqueue(() => DataStore.del(KEY_PREFIX + id));
    return had;
}

/**
 * Sweep every server currently in the client's GuildStore into the ledger.
 * Local stores only — zero API calls. Returns how many were recorded.
 */
export function recordLiveGuilds(): number {
    let n = 0;
    try {
        for (const id of GuildStore.getGuildIds?.() ?? []) {
            const g = GuildStore.getGuild(id);
            if (!g) continue;
            guildLedgerRecord({
                guildId: id, name: g.name, memberCount: (g as any).member_count ?? (g as any).memberCount,
                owner: g.ownerId === UserStore.getCurrentUser()?.id ? true : undefined,
                icon: (g as any).icon ?? undefined,
                description: (g as any).description ?? undefined,
                source: "live",
            });
            harvestGuildMembers(id);
            n++;
        }
    } catch { /* store not ready yet */ }
    return n;
}

// ─── "who was there": member snapshots ──────────────────────────────────────
//
// Discord NEVER sends the roster of a server you're not in — so the only
// moment to save "who was there" is while you still are. Three capture paths,
// all cheap:
//   harvestGuildMembers()  — read what GuildMemberStore already has (zero API)
//   onMemberChunks()       — ride chunks Discord fetches for member lists (zero API)
//   requestMemberCatch()   — actively ask for a 1000-member chunk (ONE gateway
//                            op; the same mechanism implicitRelationships uses)

function displayName(m: any): string {
    const u = m?.user ?? m;
    return String(u?.global_name ?? u?.username ?? u?.id ?? "") || String(u?.id ?? "");
}

/** Merge [id, name] pairs into a guild's snapshot; returns how many were NEW. */
export function addSnapshotMembers(guildId: string, members: any[]): number {
    const prev = guildLedgerGet(guildId);
    if (!members?.length) return 0;
    const known = new Set((prev?.memberSnapshot ?? []).map(([id]) => id));
    const fresh: Array<[string, string]> = [];
    for (const m of members) {
        const id = String(m?.user?.id ?? m?.id ?? "");
        if (!/^\d{17,20}$/.test(id) || known.has(id)) continue;
        known.add(id);
        fresh.push([id, displayName(m)]);
    }
    if (!fresh.length) return 0;
    guildLedgerRecord({ guildId, memberSnapshot: fresh });
    return fresh.length;
}

/** Save everything GuildMemberStore currently caches for a guild. Zero API. */
export function harvestGuildMembers(guildId: string): number {
    try {
        const members = GuildMemberStore.getMembers?.(guildId) ?? [];
        return addSnapshotMembers(guildId, members);
    } catch { return 0; }
}

/**
 * Flux handler for GUILD_MEMBERS_CHUNK_BATCH (payload: { chunks: [{guild_id,
 * members, nonce}] }). Passive: whenever Discord loads a member list for ANY
 * reason, those members land in the ledger of a server we're a member of.
 * Chunks for servers we don't belong to are ignored (can't be authoritative
 * "who was there" for a server GuildStore doesn't list anyway).
 */
export function onMemberChunks(e: any): void {
    try {
        for (const c of e?.chunks ?? []) {
            const gid = c?.guild_id ?? c?.guildId;
            if (!gid || !GuildStore.getGuild?.(gid)) continue;
            addSnapshotMembers(String(gid), c?.members ?? []);
        }
    } catch { /* malformed chunk — nothing safe to save */ }
}

/**
 * Ask the gateway for up to `count` members of a guild we're in (OP 8 — one
 * request, Discord's own member-search machinery; NOT REST paging, which would
 * be a call per 1000 members and rate-limit hostile). Chunks arrive via
 * GUILD_MEMBERS_CHUNK_BATCH and onMemberChunks() saves them.
 * Returns true if the request was dispatched.
 */
export function requestMemberCatch(guildId: string, count = 1000): boolean {
    if (!GuildStore.getGuild?.(guildId)) return false;
    try {
        FluxDispatcher.dispatch({
            type: "GUILD_MEMBERS_REQUEST",
            guildIds: [guildId],
            userIds: [], // fields proven on live Discord by implicitRelationships:
            presences: true, // without them the gateway may never answer the chunk
            query: "",
            limit: Math.min(count, 1000),
            nonce: `GuildLedger-${guildId}`,
        });
        return true;
    } catch { return false; }
}

export async function guildLedgerWipe(): Promise<void> {
    guildCache.clear();
    await enqueue(async () => {
        const entries = await DataStore.keys();
        for (const k of entries) if (typeof k === "string" && k.startsWith(KEY_PREFIX)) await DataStore.del(k);
    });
}

/**
 * Import a guild-ledger.json (data-package telemetry backfill). Only records
 * that are NEWER information win: telemetry names/dates merge into existing
 * live records (firstSeenDate can pull firstSeen further back); live records
 * are never downgraded to backfill. Returns {added, merged}.
 */
export function guildLedgerImportBackfill(rows: Array<{
    id: string; name?: string | null; firstSeen?: string | null; lastSeen?: string | null;
    strongEvents?: number | null; guildSize?: number | null; status?: string;
}>): { added: number, merged: number, skipped: number } {
    let added = 0, merged = 0, skipped = 0;
    const now = Date.now();
    for (const r of rows) {
        if (!r?.id || !/^\d{17,20}$/.test(r.id)) { skipped++; continue; }
        const prev = guildCache.get(r.id);
        const fs = Date.parse(r.firstSeen ?? "");
        if (prev && prev.source !== "backfill") {
            // live/left record already beats telemetry evidence — but dates can extend history
            if (!isNaN(fs) && fs < prev.firstSeen) {
                guildLedgerRecord({ guildId: r.id, firstSeen: fs, firstSeenDate: undefined, lastSeen: prev.lastSeen, strongEvents: r.strongEvents ?? undefined });
                merged++;
            } else skipped++;
            continue;
        }
        guildLedgerRecord({
            guildId: r.id,
            name: r.name ?? undefined,
            memberCount: r.guildSize ?? undefined,
            source: "backfill",
            firstSeen: isNaN(fs) ? now : fs,
            firstSeenDate: r.firstSeen ?? undefined,
            lastSeenDate: r.lastSeen ?? undefined,
            strongEvents: r.strongEvents ?? undefined,
        });
        if (prev) merged++; else added++;
    }
    return { added, merged, skipped };
}

// ─── backup / restore ────────────────────────────────────────────────────────
// Same contract as the DM ledger: export is a plain file YOU own; restoring
// merges without ever shrinking history (firstSeen min, lastSeen max, roster
// snapshots union-merged).

/** full-fidelity snapshot including icon hashes and caught rosters */
export function guildBackupPayload(): { kind: "GuildLedger.v1"; exportedAt: string; servers: LedgerGuild[] } {
    return {
        kind: "GuildLedger.v1",
        exportedAt: new Date().toISOString(),
        servers: guildLedgerList(),
    };
}

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Restore a GuildLedger backup file (exported by this plugin). Unlike the
 * telemetry backfill reader, this one trusts richer rows: firstSeen/lastSeen
 * as epoch ms, icon hashes, descriptions, and member snapshots. Junk is
 * skipped row-by-row, never trusted wholesale.
 */
export function guildLedgerImportBackup(data: unknown): { ok: boolean; error?: string; added: number; merged: number; skipped: number } {
    const payload = Array.isArray(data) ? { servers: data } : data as any;
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.servers))
        return { ok: false, error: "not a GuildLedger backup (expecting {servers:[...]})", added: 0, merged: 0, skipped: 0 };
    let added = 0, merged = 0, skipped = 0;
    for (const s of payload.servers) {
        const gid = String(s?.guildId ?? "");
        if (!SNOWFLAKE.test(gid)) { skipped++; continue; }
        const prev = guildCache.get(gid);
        const incoming = typeof s.source === "string" ? s.source : "backup";
        // a real live/left capture outranks backup evidence — never downgrade
        const strong = (src?: string) => src === "live" || src === "left";
        // when the live client already saw this server, THIS session's stores
        // are fresher than any file: identity fields come from memory, the
        // backup may only fill gaps (icon/roster/dates below still merge).
        const stale = strong(prev?.source) && !strong(incoming);
        guildLedgerRecord({
            guildId: gid,
            name: stale ? undefined : (typeof s.name === "string" ? s.name : undefined),
            memberCount: typeof s.memberCount === "number" ? s.memberCount : undefined,
            owner: s.owner === true ? true : undefined,
            source: stale ? prev!.source : incoming,
            firstSeenMs: typeof s.firstSeen === "number" && s.firstSeen > 0 ? s.firstSeen : undefined,
            lastSeen: typeof s.lastSeen === "number" && s.lastSeen > 0 ? s.lastSeen : undefined,
            icon: stale ? undefined : (typeof s.icon === "string" ? s.icon : undefined),
            description: stale ? undefined : (typeof s.description === "string" ? s.description : undefined),
            firstSeenDate: typeof s.firstSeenDate === "string" ? s.firstSeenDate : undefined,
            lastSeenDate: typeof s.lastSeenDate === "string" ? s.lastSeenDate : undefined,
            strongEvents: typeof s.strongEvents === "number" ? s.strongEvents : undefined,
            // honor the roster's ORIGINAL catch timestamp — restoring isn't "caught today"
            snapshotAtMs: typeof s.snapshotAt === "number" && s.snapshotAt > 0 ? s.snapshotAt : undefined,
            memberSnapshot: Array.isArray(s.memberSnapshot)
                ? s.memberSnapshot.filter((m: any) => Array.isArray(m) && SNOWFLAKE.test(String(m[0])))
                : undefined,
        });
        if (prev) merged++; else added++;
    }
    return { ok: true, added, merged, skipped };
}
