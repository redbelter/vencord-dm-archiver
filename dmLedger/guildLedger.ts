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
import { GuildStore, UserStore } from "@webpack/common";

const KEY_PREFIX = "GuildLedger.v1.";

export interface LedgerGuild {
    guildId: string;
    name?: string; // best-known name at record time
    memberCount?: number | null;
    owner?: boolean; // you owned it at some capture point
    firstSeen: number; // epoch ms
    lastSeen: number;
    source: string; // "live" | "left" | "backfill"
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
        firstSeen: Math.min(fresh.firstSeen, stored.firstSeen),
        lastSeen: Math.max(fresh.lastSeen, stored.lastSeen),
        // "live"/"left" beat "backfill" — a real capture is stronger evidence
        source: fresh.source === "backfill" ? stored.source : fresh.source,
        firstSeenDate: stored.firstSeenDate ?? fresh.firstSeenDate,
        lastSeenDate: fresh.lastSeenDate ?? stored.lastSeenDate,
        strongEvents: Math.max(fresh.strongEvents ?? 0, stored.strongEvents ?? 0) || undefined,
    });
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
export function guildLedgerRecord(g: Partial<LedgerGuild> & { guildId: string, source?: string }): void {
    const now = Date.now();
    const prev = guildCache.get(g.guildId);
    const backfillStart = Date.parse(g.firstSeenDate ?? "") || Infinity;
    const rec: LedgerGuild = {
        guildId: g.guildId,
        name: g.name ?? prev?.name,
        memberCount: g.memberCount ?? prev?.memberCount,
        owner: (g.owner || prev?.owner) || undefined,
        firstSeen: Math.min(prev?.firstSeen ?? now, g.firstSeen ?? now, backfillStart),
        lastSeen: Math.max(prev?.lastSeen ?? 0, g.lastSeen ?? now),
        source: g.source ?? prev?.source ?? "live",
        firstSeenDate: g.firstSeenDate ?? prev?.firstSeenDate,
        lastSeenDate: g.lastSeenDate ?? prev?.lastSeenDate,
        strongEvents: Math.max(prev?.strongEvents ?? 0, g.strongEvents ?? 0) || undefined,
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
                source: "live",
            });
            n++;
        }
    } catch { /* store not ready yet */ }
    return n;
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
