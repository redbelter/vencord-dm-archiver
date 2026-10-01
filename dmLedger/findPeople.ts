/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// findPeople — drop-in copy of the two search engines from GhostDms's Finder
// (kept in sync by hand, same pattern as the ledger.ts / native.ts copies):
// everything here is READ-ONLY (local caches + guild member search). The
// DmLedger browser uses it for the "people you have never DM'd" gap the
// ledger itself can't cover.

import { GuildMemberStore, GuildStore, RestAPI, UserStore } from "@webpack/common";

export interface CachePerson {
    userId: string;
    username: string;
}

/**
 * Search everything the client has ever *seen* — the local user cache and the
 * member caches of every server joined — for a name. This is how you find an
 * old friend who isn't in the DM list: you don't need their snowflake, just a
 * few letters of their username and a shared server from the past.
 * Local-only: zero API calls. Returns up to `cap` matches (DM partners are
 * excluded — the ledger list already shows those).
 */
export function searchPeopleCache(query: string, excludeUserIds: Set<string>, cap = 50): CachePerson[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const found = new Map<string, { userId: string; username: string; exact: boolean; }>();

    const consider = (uid: unknown, name: unknown) => {
        const id = uid == null ? "" : String(uid);
        const nm = typeof name === "string" ? name : "";
        if (!id || !nm || excludeUserIds.has(id)) return;
        const low = nm.toLowerCase();
        if (!low.includes(q)) return;
        const exact = low === q || low.startsWith(q);
        const prev = found.get(id);
        if (!prev || (!prev.exact && exact)) found.set(id, { userId: id, username: nm, exact });
    };

    try {
        const all = UserStore.getUsers?.();
        if (all) for (const [id, user] of Object.entries(all)) consider(id, (user as any)?.username);
    } catch { /* cache unavailable */ }

    // every cached guild member across every guild the client knows
    try {
        for (const guildId of GuildStore.getGuildIds?.() ?? []) {
            for (const uid of GuildMemberStore.getMemberIds?.(guildId) ?? [])
                consider(uid, UserStore.getUser(String(uid))?.username);
        }
    } catch { /* store unavailable */ }

    return [...found.values()]
        .sort((a, b) => Number(b.exact) - Number(a.exact) || a.username.localeCompare(b.username))
        .slice(0, cap)
        .map(({ userId, username }) => ({ userId, username }));
}

export interface RosterPerson extends CachePerson {
    /** name of one guild the search endpoint matched them in */
    inGuild: string;
}

export interface RosterSearchResult {
    persons: RosterPerson[];
    searched: number;
    rateLimited: boolean;
    error: string;
}

/**
 * Ask every server the user is in to search its FULL member roster
 * server-side (`GET /guilds/{id}/members/search`). Unlike the local cache
 * search this finds people who were never cached by this client — e.g. a
 * 2016 friend in a big server whose member slice was never loaded.
 * Sequential + paced; stops early on rate limit or when `stop.stop` flips.
 */
export async function searchGuildRosters(
    query: string,
    opts: { exclude: Set<string>; paceMs?: number; stop?: { stop: boolean; }; onProgress?: (done: number, total: number) => void; },
): Promise<RosterSearchResult> {
    const q = query.trim().toLowerCase();
    const persons: RosterPerson[] = [];
    const seen = new Set<string>();
    const stop = opts.stop ?? { stop: false };
    const paceMs = opts.paceMs ?? 150;
    let searched = 0, rateLimited = false;

    let guildIds: string[] = [];
    try { guildIds = GuildStore.getGuildIds?.() ?? []; } catch { /* no guilds */ }

    for (const guildId of guildIds) {
        if (stop.stop) break;
        let guildName = guildId;
        try { guildName = GuildStore.getGuild?.(guildId)?.name ?? guildId; } catch { /* name unavailable */ }
        try {
            const res: any = await RestAPI.get({
                url: `/guilds/${guildId}/members/search`,
                query: { query: query.trim(), limit: 10 },
            });
            const members: any[] = Array.isArray(res?.body) ? res.body : Array.isArray(res) ? res : [];
            searched++;
            for (const m of members) {
                const user = m?.user ?? m;
                const id = user?.id == null ? "" : String(user.id);
                const nm = user?.username ?? user?.global_name ?? "";
                if (!id || !nm || opts.exclude.has(id) || seen.has(id)) continue;
                if (q && !nm.toLowerCase().includes(q) && !(m?.nick && String(m.nick).toLowerCase().includes(q))) continue;
                seen.add(id);
                persons.push({ userId: id, username: nm, inGuild: guildName });
            }
        } catch (e: any) {
            if (e?.status === 429) { rateLimited = true; break; }
            // 404/400 on small guilds is normal — skip quietly
        }
        opts.onProgress?.(searched, guildIds.length);
        if (paceMs) await new Promise(r => setTimeout(r, paceMs));
    }

    return { persons, searched, rateLimited, error: "" };
}
