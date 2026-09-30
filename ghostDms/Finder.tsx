/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The finder modal: every DM channel you've ever had, including the ones
// Discord's sidebar hides (non-friends, long-inactive, deactivated accounts).

import { Button } from "@components/Button";
import {
    ChannelRouter,
    ChannelStore,
    Checkbox,
    createRoot,
    GuildMemberStore,
    GuildStore,
    RestAPI,
    Text,
    TextInput,
    Toasts,
    useEffect,
    UserStore,
    useState,
} from "@webpack/common";
import type { CSSProperties } from "react";

import type { PackageScan } from "./native";

// native (main-process) bridge; may be unavailable on web builds — the
// package-import UI hides itself when it is.
const Native = (typeof VencordNative !== "undefined" ? VencordNative : undefined)?.pluginHelpers?.GhostDms as
    | { scanPackage(path: string): Promise<PackageScan>; chooseFolder(): Promise<{ path: string | null; } | string | null>; }
    | undefined;

async function fetchLiveFriendIds(): Promise<Set<string>> {
    try {
        const relRes: any = await RestAPI.get({ url: "/users/@me/relationships" });
        return new Set<string>(
            (Array.isArray(relRes?.body) ? relRes.body : [])
                .filter((r: any) => r.type === 1)
                .map((r: any) => String(r.id)),
        );
    } catch { return new Set<string>(); }
}

export interface GhostDmRow {
    channelId: string;
    userId: string;
    username: string;
    isFriend: boolean;
    /** true when this row only exists in an imported data package */
    fromPackage?: boolean;
}

/**
 * Merge a scanned data-package DM list into live rows. Package-only channels
 * are kept as extra rows (flagged) — those are DMs Discord's live API no
 * longer lists (old hidden conversations) — and get names resolved from the
 * package's member dumps / live UserStore. Returns the merged rows plus how
 * many rows came only from the package.
 */
export function mergePackageRows(live: GhostDmRow[], scan: PackageScan, friendIds: Set<string>): { rows: GhostDmRow[]; added: number; } {
    const rows = [...live];
    const byChannel = new Set(live.map(r => r.channelId));
    let added = 0;
    for (const dm of scan.dms ?? []) {
        if (byChannel.has(dm.channelId)) continue;
        byChannel.add(dm.channelId);
        let username = scan.names?.[dm.recipientId];
        if (!username) {
            try {
                const cu: any = UserStore.getUser(dm.recipientId);
                username = cu?.globalName ?? cu?.global_name ?? cu?.username;
            } catch { /* cache unavailable */ }
        }
        rows.push({
            channelId: dm.channelId,
            userId: dm.recipientId,
            username: username ?? `user ${dm.recipientId}`,
            isFriend: friendIds.has(dm.recipientId),
            fromPackage: true,
        });
        added++;
    }
    rows.sort((a, b) => Number(a.isFriend) - Number(b.isFriend) || a.username.localeCompare(b.username));
    return { rows, added };
}

/** Account creation date from a snowflake id (Discord epoch 2015-01-01). */
export function snowflakeDate(id: string): string | null {
    try {
        const ms = (BigInt(id) >> 22n) + 1420070400000n;
        const d = new Date(Number(ms));
        if (isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 10);
    } catch { return null; }
}

const SNOWFLAKE_RE = /^\d{15,20}$/;

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
 * excluded — the DM list already shows those).
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

/**
 * Ask Discord for the DM channel with this user. If one already exists
 * (including DMs hidden from /users/@me/channels), Discord returns THAT
 * channel with its history intact. If none exists it creates an empty one.
 * Returns { channelId, recipientName? } — recipientName is the current profile
 * Discord embedded in the response, if any.
 */
export async function resolveDmByUserId(userId: string): Promise<{ channelId: string; recipientName?: string; }> {
    const res: any = await RestAPI.post({ url: "/users/@me/channels", body: { recipient_id: userId } });
    // real RestAPI resolves with the bare channel body; some shapes nest it
    const ch = res?.id ? res : res?.body;
    if (!ch?.id) throw new Error("Discord did not return a DM channel");
    // the create-or-get response embeds the recipient's CURRENT profile —
    // handy for fixing placeholder names on package-only rows
    const rec = Array.isArray(ch.recipients) ? ch.recipients[0] : undefined;
    return { channelId: String(ch.id), recipientName: rec?.global_name ?? rec?.username };
}

export interface BatchResult {
    opened: string[]; // channel ids restored (in order)
    failed: string[]; // user ids Discord refused (deleted/blocked) or errored
    rateLimited: boolean; // stopped early on Discord's rate limit
}

/**
 * Ask Discord directly for one account's profile. The popcard endpoint
 * (GET /users/{id}/profile) is the one that works for non-friends you have/had
 * a DM with — plain GET /users/{id} 403s for non-friends — with the bare
 * endpoint as a fallback. Returns null for deleted/blocked/rate-limited.
 */
async function fetchUserLite(userId: string): Promise<any | null> {
    // real RestAPI resolves bare on 2xx and throws on 4xx; some shapes nest
    const unwrap = (res: any) => (res?.user?.id ? res.user : res?.body?.user?.id ? res.body.user : res?.username ? res : res?.body?.id ? res.body : null);
    try {
        const u = unwrap(await RestAPI.get({ url: `/users/${userId}/profile` }));
        if (u?.id) return u;
    } catch { /* 404/403/429 — try the plain endpoint */ }
    try {
        return unwrap(await RestAPI.get({ url: `/users/${userId}` }));
    } catch {
        return null; // deleted / blocked / rate limited
    }
}

/** placeholder label we render when no source knows the name */
export function isPlaceholderName(row: { username: string; userId: string; }): boolean {
    return row.username === `user ${row.userId}` || /^user[_ ]?\d+$/i.test(row.username);
}

/**
 * Resolve placeholder names ("user 123…") for ids the data package couldn't
 * name. Discord's export omits recipient profiles, so we ask the API per id —
 * paced at ~1.1s because GET /users/{id} is capped around 10/10s server-side.
 * Local UserStore answers first (free, no request). Deleted/blocked accounts
 * simply stay unresolved — the summary counts them honestly.
 */
export async function resolveNamesForIds(
    userIds: string[],
    opts: { stop?: { stop: boolean; }; paceMs?: number; onProgress?: (done: number, total: number) => void; },
): Promise<Record<string, string>> {
    const names: Record<string, string> = {};
    const stop = opts.stop ?? { stop: false };
    const paceMs = opts.paceMs ?? 1100;
    for (let i = 0; i < userIds.length; i++) {
        if (stop.stop) break;
        const id = userIds[i];
        let name: string | undefined;
        try {
            const cu: any = UserStore.getUser(id);
            name = cu?.globalName ?? cu?.global_name ?? cu?.username;
        } catch { /* cache unavailable */ }
        if (!name) {
            const u = await fetchUserLite(id);
            name = u?.global_name ?? u?.username;
        }
        if (name) names[id] = name;
        opts.onProgress?.(i + 1, userIds.length);
        if (i < userIds.length - 1 && paceMs) await new Promise(r => setTimeout(r, paceMs));
    }
    return names;
}

/**
 * Restore DM channels for many users without clicking through one by one.
 * Hits create-or-get for each (paced), collecting channel ids; a 429 stops
 * early and says so rather than hammering Discord. Paced serially because
 * POST /users/@me/channels is rate-limited hard server-side.
 */
export async function batchRestoreDms(
    userIds: string[],
    opts: { stop: { stop: boolean; }; paceMs?: number; onProgress?: (done: number, total: number) => void; },
): Promise<BatchResult> {
    const paceMs = opts.paceMs ?? 750;
    const opened: string[] = [];
    const failed: string[] = [];
    let rateLimited = false;

    for (let i = 0; i < userIds.length; i++) {
        if (opts.stop.stop) break;
        try {
            opened.push((await resolveDmByUserId(userIds[i])).channelId);
        } catch (e: any) {
            if (e?.status === 429) { rateLimited = true; break; }
            failed.push(userIds[i]);
        }
        opts.onProgress?.(i + 1, userIds.length);
        if (i < userIds.length - 1 && paceMs) await new Promise(r2 => setTimeout(r2, paceMs));
    }
    return { opened, failed, rateLimited };
}

/**
 * Every DM channel via /users/@me/channels — a superset of the sidebar —
 * unioned with whatever the local ChannelStore cache knows about.
 * Names come from the recipient object embedded in the channel payload first
 * (authoritative for unfriended / deleted accounts missing from UserStore).
 */
export async function listAllDms(): Promise<GhostDmRow[]> {
    const chRes: any = await RestAPI.get({ url: "/users/@me/channels" });
    const channels: any[] = Array.isArray(chRes?.body) ? chRes.body.filter(c => c?.type === 1) : [];

    let friendIds = new Set<string>();
    try {
        const relRes: any = await RestAPI.get({ url: "/users/@me/relationships" });
        friendIds = new Set<string>(
            (Array.isArray(relRes?.body) ? relRes.body : [])
                .filter((r: any) => r.type === 1)
                .map((r: any) => String(r.id)),
        );
    } catch { /* relationships unavailable — everything shows as "not friends" */ }

    const rows: GhostDmRow[] = [];
    const seen = new Set<string>();
    const push = (channelId: string, uid: string, embedded?: any) => {
        if (!channelId || !uid || seen.has(channelId)) return;
        seen.add(channelId);
        const user = embedded ?? UserStore.getUser(uid);
        rows.push({
            channelId,
            userId: uid,
            // display name first (what Discord itself shows everywhere);
            // auto-generated "user_123456" handles often have a real global_name
            username: user?.global_name ?? user?.username ?? `user ${uid}`,
            isFriend: friendIds.has(uid),
        });
    };
    for (const ch of channels) {
        push(String(ch.id), String(ch.recipient_ids?.[0] ?? ch.recipients?.[0]?.id ?? ""), ch.recipients?.[0]);
    }
    // the local store cache sometimes knows DM channels the REST list omits
    try {
        for (const uid of ChannelStore.getDMUserIds() ?? []) {
            const chId = ChannelStore.getDMFromUserId(String(uid));
            if (chId) push(String(chId), String(uid));
        }
    } catch { /* store unavailable */ }
    rows.sort((a, b) => Number(a.isFriend) - Number(b.isFriend) || a.username.localeCompare(b.username));
    return rows;
}

// The finder lives in a FLOATING panel, not a blocking modal: it stays open
// (always-on-top, draggable) while you click through the DMs it opened, so
// you can navigate your restored conversations without closing/reopening.

interface FloatingHandle {
    close(): void;
    toggle(): void;
    isMin(): boolean;
}
let floating: { root: any; el: HTMLElement; handle: FloatingHandle; } | null = null;

const FLOAT_Z = 2147483000; // above Discord's modals/menus

function clampIntoView(el: HTMLElement) {
    // NEVER let any part of the titlebar (and its hide/close buttons) leave the
    // viewport — a partially off-screen panel is an unclosable panel.
    const w = el.getBoundingClientRect().width || 460;
    const left = parseFloat(el.style.left || "0") || 0;
    const top = parseFloat(el.style.top || "0") || 0;
    el.style.left = Math.max(0, Math.min(window.innerWidth - w, left)) + "px";
    el.style.top = Math.max(0, Math.min(window.innerHeight - 44, top)) + "px";
}

// The renderer context this code runs in may have NO usable localStorage:
// the global can be absent entirely (ReferenceError on bare `localStorage` —
// seen live in Discord's renderer; even Vencord avoids the bare global) or
// throw SecurityError in sandboxed file:// contexts. Probe lazily per call
// and fall back to a module-memory map: persistence degrades to per-session
// instead of crashing the plugin. NEVER touch bare `localStorage` directly.
const __memStore = new Map<string, string>();
function nativeStore(): { getItem(k: string): string | null; setItem(k: string, v: string): void; } | null {
    try {
        const s = (globalThis as any).localStorage;
        if (!s) return null;
        s.getItem("\u0000probe"); // sandboxed contexts throw on access, not assignment
        return s;
    } catch { return null; }
}
const store = {
    getItem(k: string): string | null {
        const s = nativeStore();
        if (s) {
            try {
                const v = s.getItem(k);
                return v == null ? (__memStore.get(k) ?? null) : v;
            } catch { /* fall through to memory */ }
        }
        return __memStore.get(k) ?? null;
    },
    setItem(k: string, v: string): void {
        const s = nativeStore();
        if (s) {
            try { s.setItem(k, v); return; } catch { /* fall through to memory */ }
        }
        __memStore.set(k, v);
    },
};

const WIDTH_KEY = "GhostDmsWidth";
const HEIGHT_KEY = "GhostDmsHeight";

function savedHeight(): number {
    try {
        const v = parseInt(store.getItem(HEIGHT_KEY) ?? "", 10);
        if (v >= 200) return Math.min(v, (typeof window !== "undefined" ? window.innerHeight : 1920) - 40);
    } catch { /* no storage */ }
    return 0; // 0 = auto (max-height clamp)
}

function savedWidth(): number {
    try {
        const v = parseInt(store.getItem(WIDTH_KEY) ?? "", 10);
        if (v >= 320 && v <= 3000) return Math.min(v, (typeof window !== "undefined" ? window.innerWidth : 1920) - 16);
    } catch { /* no storage */ }
    return 460;
}

/** right-edge drag handle: resizes width, persists to localStorage */
function makeResizable(el: HTMLElement, handleEl: HTMLElement) {
    let startX = 0, startW = 0, resizing = false;
    const onDown = (e: MouseEvent) => {
        resizing = true;
        const rect = el.getBoundingClientRect();
        startX = e.clientX; startW = rect.width;
        el.style.left = rect.left + "px";
        el.style.top = rect.top + "px";
        el.style.right = "auto";
        e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
        if (!resizing) return;
        const left = parseFloat(el.style.left) || 0;
        const max = Math.max(320, window.innerWidth - left - 8);
        el.style.width = Math.max(320, Math.min(max, startW + e.clientX - startX)) + "px";
    };
    const onUp = () => {
        if (!resizing) return;
        resizing = false;
        store.setItem(WIDTH_KEY, String(Math.round(el.getBoundingClientRect().width)));
    };
    const onResize = () => {
        if (window.innerWidth < 100 || window.innerHeight < 100) return; // minimizing: transient resize with a degenerate viewport — clamping now would strand the panel tiny
        const w = parseFloat(el.style.width);
        if (w && w > window.innerWidth) el.style.width = window.innerWidth + "px";
    };
    handleEl.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    return () => {
        handleEl.removeEventListener("mousedown", onDown);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("resize", onResize);
    };
}

/** bottom-edge drag handle: resizes height, persists to localStorage */
function makeResizableHeight(el: HTMLElement, handleEl: HTMLElement) {
    let startY = 0, startH = 0, resizing = false;
    const onDown = (e: MouseEvent) => {
        resizing = true;
        const rect = el.getBoundingClientRect();
        startY = e.clientY; startH = rect.height;
        e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
        if (!resizing) return;
        const { top } = el.getBoundingClientRect();
        const max = Math.max(200, window.innerHeight - top - 8);
        el.style.height = Math.max(200, Math.min(max, startH + e.clientY - startY)) + "px";
    };
    const onUp = () => {
        if (!resizing) return;
        resizing = false;
        store.setItem(HEIGHT_KEY, String(Math.round(el.getBoundingClientRect().height)));
    };
    const onResize = () => {
        if (window.innerWidth < 100 || window.innerHeight < 100) return; // minimizing: transient resize with a degenerate viewport — clamping now would strand the panel tiny
        const h = parseFloat(el.style.height);
        const { top } = el.getBoundingClientRect();
        if (h && top + h > window.innerHeight) el.style.height = Math.max(200, window.innerHeight - top - 8) + "px";
    };
    handleEl.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    return () => {
        handleEl.removeEventListener("mousedown", onDown);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("resize", onResize);
    };
}

function makeDraggable(el: HTMLElement, handleEl: HTMLElement) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    const onDown = (e: MouseEvent) => {
        if ((e.target as HTMLElement)?.closest?.("button")) return;
        dragging = true;
        const rect = el.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
        el.style.left = ox + "px";
        el.style.top = oy + "px";
        el.style.right = "auto"; // switch to left/top anchoring once dragged
        e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
        if (!dragging) return;
        el.style.left = String(ox + e.clientX - sx) + "px";
        el.style.top = String(oy + e.clientY - sy) + "px";
        clampIntoView(el);
    };
    const onUp = () => { dragging = false; };
    const onResize = () => {
        if (window.innerWidth < 100 || window.innerHeight < 100) return; // minimizing: transient resize with a degenerate viewport — clamping now would strand the panel tiny
        clampIntoView(el);
    };
    handleEl.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    return () => {
        handleEl.removeEventListener("mousedown", onDown);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("resize", onResize);
    };
}

export function closeGhostFinder() {
    floating?.handle.close();
}

export function openGhostFinder() {
    // toggle behaviour: button re-click hides/restores instead of stacking panels
    if (floating) {
        floating.handle.toggle();
        return;
    }
    if (typeof document === "undefined" || typeof createRoot !== "function") return;

    const el = document.createElement("div") as HTMLElement;
    el.style.cssText = [
        "position:fixed", "top:80px", "right:24px", "width:" + savedWidth() + "px",
        "display:flex", "flex-direction:column", "z-index:" + FLOAT_Z,
        "background:var(--bg-normal, #18191c)", "border:1px solid var(--border-subtle, #333)",
        "border-radius:10px", "box-shadow:0 8px 30px rgba(0,0,0,.6)", "padding:0",
        "color:var(--header-primary, #fff)",
    ].join(";");

    // React replaces ALL children of the container it roots on, so it roots on
    // this inner content div — the plain-DOM titlebar lives directly on `el`
    // and render() can never erase it.
    // start compact; NO max-height cap — the bottom grip can grow it freely
    // (drag/resize clamps only keep it on-screen, never below the start size)
    el.style.height = savedHeight() ? savedHeight() + "px" : "55vh";

    const content = document.createElement("div");
    content.style.cssText = "padding:12px;overflow-y:auto;flex:1;min-height:0";
    const contentRoot = createRoot(content);

    let hidden = false;
    const handle: FloatingHandle = {
        close: () => { }, // filled below once we have contentRoot+el
        toggle: () => {
            hidden = !hidden;
            // NOTE: el.style.display = "" would DELETE the cssText-declared
            // display:flex (inline-style semantics), and the div falls back to
            // display:block — the flex column dies, the content div stops being
            // height-constrained, its scrollbar vanishes and everything
            // overflows the frame. Always restore the EXPLICIT value.
            el.style.display = hidden ? "none" : "flex";
        },
        isMin: () => hidden,
    };
    const onDblClick = (e: MouseEvent) => {
        if (!(e.target as HTMLElement)?.closest?.("button")) handle.close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handle.close(); };
    handle.close = () => {
        try { contentRoot.unmount(); } catch { /* already gone */ }
        el.remove();
        window.removeEventListener("keydown", onKey);
        floating = null;
    };

    document.body.appendChild(el);
    window.addEventListener("keydown", onKey);
    floating = { root: contentRoot, el, handle };

    // plain-DOM titlebar (drag handle + hide/close), sibling of the React root
    const bar = document.createElement("div");
    bar.style.cssText = "padding:10px 14px;font-weight:700;cursor:move;border-bottom:1px solid var(--border-subtle,#333);display:flex;justify-content:space-between;align-items:center;user-select:none";
    const title = document.createElement("span");
    title.textContent = "Ghost DMs — stays open while you browse";
    const btns = document.createElement("span");
    const mk = (label: string, titleTxt: string, fn: () => void, danger = false) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = titleTxt;
        b.style.cssText = "margin-left:6px;width:26px;height:26px;border-radius:6px;border:1px solid var(--border-subtle,#444);"
            + "background:" + (danger ? "#c0392b" : "rgba(255,255,255,.08)") + ";color:#fff;font-size:14px;line-height:1;cursor:pointer";
        b.addEventListener("click", fn);
        btns.appendChild(b);
    };
    mk("–", "hide (bring it back with the bar button, re-clicking it, or /ghost-dms — your list and selection are kept)", () => handle.toggle());
    mk("✕", "close Ghost DMs (double-click the title bar does this too)", () => handle.close(), true);
    bar.appendChild(title);
    bar.appendChild(btns);
    el.insertBefore(bar, el.firstChild);

    el.appendChild(content);
    contentRoot.render(<Finder />);

    // right-edge resize grip: a visible pill straddling the border so it's
    // actually findable (an 8px faint glyph was invisible in practice)
    const grip = document.createElement("div");
    grip.title = "drag to resize width";
    grip.style.cssText = "position:absolute;top:50%;transform:translateY(-50%);right:-8px;"
        + "width:16px;height:52px;cursor:ew-resize;border-radius:8px;user-select:none;"
        + "background:var(--background-tertiary,#111214);border:1px solid var(--interactive-hover,#5865f2);"
        + "box-shadow:0 2px 8px rgba(0,0,0,.5);color:var(--header-primary,#dcddde);font-size:11px;"
        + "display:flex;align-items:center;justify-content:center;letter-spacing:-1px";
    grip.textContent = "⋮⋮";
    el.appendChild(grip);

    // bottom-edge resize grip (height), same visible-pill style rotated
    const gripH = document.createElement("div");
    gripH.title = "drag to resize height";
    gripH.style.cssText = "position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);"
        + "height:16px;width:52px;cursor:ns-resize;border-radius:8px;user-select:none;"
        + "background:var(--background-tertiary,#111214);border:1px solid var(--interactive-hover,#5865f2);"
        + "box-shadow:0 2px 8px rgba(0,0,0,.5);color:var(--header-primary,#dcddde);font-size:11px;"
        + "display:flex;align-items:center;justify-content:center;letter-spacing:-1px";
    gripH.textContent = "⋯";
    el.appendChild(gripH);

    bar.addEventListener("dblclick", onDblClick);
    const cleanup = makeDraggable(el, bar);
    const cleanupResize = makeResizable(el, grip);
    const cleanupResizeH = makeResizableHeight(el, gripH);
    const origClose = handle.close;
    handle.close = () => { cleanup(); cleanupResize(); cleanupResizeH(); bar.removeEventListener("dblclick", onDblClick); origClose(); };
}

const panelStyle: CSSProperties = {
    padding: 12,
    borderRadius: 8,
    border: "1px solid var(--border-subtle, #333)",
};

function Finder() {
    const [rows, setRows] = useState<GhostDmRow[] | null>(null);
    const [search, setSearch] = useState("");
    const [nonFriendsOnly, setNonFriendsOnly] = useState(false);
    const [userId, setUserId] = useState("");
    const [showIdBox, setShowIdBox] = useState(false);
    const [busyId, setBusyId] = useState(""); // user id currently resolving
    const [lookupError, setLookupError] = useState("");
    const [pkgPath, setPkgPath] = useState("");
    const [pkgBusy, setPkgBusy] = useState(false);
    const [pkgMsg, setPkgMsg] = useState("");
    const [rosterBusy, setRosterBusy] = useState(false);
    const [rosterText, setRosterText] = useState("");
    const [rosterMatches, setRosterMatches] = useState<RosterPerson[]>([]);
    const [rosterDone, setRosterDone] = useState(false);
    const stopRoster = useState({ stop: false })[0];
    const [selected, setSelected] = useState<Record<string, boolean>>({}); // userId -> picked
    const [bulkBusy, setBulkBusy] = useState(false);
    const [bulkText, setBulkText] = useState("");
    const [lastScan, setLastScan] = useState<PackageScan | null>(null);
    const stopBulk = useState({ stop: false })[0];
    const [namesBusy, setNamesBusy] = useState(false);
    const [namesText, setNamesText] = useState("");
    const stopNames = useState({ stop: false })[0];

    useEffect(() => {
        listAllDms().then(setRows).catch(() => setRows([]));
    }, []);

    // Open a DM with ANY user id, even one missing from the DM list: Discord's
    // create-or-get endpoint returns the EXISTING channel (history intact) if a
    // DM ever existed; only a never-DM'd user yields a fresh empty channel.
    const openPersonById = async (rawId: string) => {
        const id = rawId.trim();
        if (!SNOWFLAKE_RE.test(id)) {
            setLookupError("That doesn't look like a Discord user ID (15-20 digits).");
            return;
        }
        setLookupError("");
        setBusyId(id);
        try {
            const { channelId, recipientName } = await resolveDmByUserId(id);
            ChannelRouter?.transitionToChannel?.(channelId);
            // the response embeds their current profile — fix any placeholder row
            if (recipientName) {
                setRows(prev => (prev ?? []).map(r2 =>
                    r2.userId === id ? { ...r2, username: recipientName } : r2));
            }
            // panel deliberately stays open — click through DMs without reopening
        } catch (error: any) {
            setLookupError(
                error?.status === 404 || error?.status === 400 || error?.status === 403
                    ? "Discord refused that user — the account may be deleted, blocked, or the ID is wrong."
                    : `Lookup failed: ${String(error?.message ?? error)}`,
            );
        } finally {
            setBusyId("");
        }
    };

    const importPackage = async (usePicker = false) => {
        if (!Native) return;
        setPkgBusy(true);
        setPkgMsg("");
        try {
            let path = pkgPath.trim();
            if (usePicker) {
                const picked: any = await Native.chooseFolder();
                const chosen = typeof picked === "string" ? picked : picked?.path;
                if (!chosen) { setPkgBusy(false); return; }
                setPkgPath(chosen);
                path = chosen;
            }
            const scan = await Native.scanPackage(path);
            if (!scan.ok) {
                setPkgMsg(`❌ ${scan.error}`);
                return;
            }
            const live = rows ?? await listAllDms();
            // friend tag = live relationships ∪ package snapshot (an export from
            // last year still knows who you were friends with then)
            const friendIds = await fetchLiveFriendIds();
            for (const fid of scan.friends ?? []) friendIds.add(fid);
            const merged = mergePackageRows(live, scan, friendIds);
            setRows(merged.rows);
            setLastScan(scan);
            setPkgMsg(`imported ${scan.dms?.length ?? 0} DMs from the package — ${merged.added} conversation(s) Discord's live list no longer shows`
                + (scan.groupDms ? ` (${scan.groupDms} group DMs skipped)` : ""));
            // the export omits recipient profiles, so freshly-imported rows can
            // read "user <id>" — try to fill the real names from the live API
            const placeholders = merged.rows.filter(isPlaceholderName);
            if (placeholders.length && store.getItem("GhostDmsAutoNames") !== "0") {
                resolveNames(merged.rows).catch(() => setNamesText("name lookup hit an unexpected error — try the Resolve button.")); // fire-and-forget; progress shows below
            }
        } catch (error: any) {
            setPkgMsg(`❌ ${String(error?.message ?? error)}`);
        } finally {
            setPkgBusy(false);
        }
    };

    // Resolve "user <id>" placeholder rows by asking Discord for each profile
    // (paced). Auto-runs after a package import; manual button re-runs it.
    const resolveNames = async (source?: GhostDmRow[]) => {
        const targets = (source ?? rows ?? []).filter(isPlaceholderName);
        if (!targets.length) return;
        setNamesBusy(true);
        stopNames.stop = false;
        let processed = 0;
        try {
            const paceRaw = parseInt(store.getItem("GhostDmsNamePace") ?? "", 10);
            const names = await resolveNamesForIds(targets.map(r2 => r2.userId), {
                stop: stopNames,
                paceMs: Number.isFinite(paceRaw) && paceRaw >= 0 ? paceRaw : undefined,
                onProgress: (done, total) => { processed = done; setNamesText(`looking up ${done}/${total}…`); },
            });
            const ids = Object.keys(names);
            if (ids.length) {
                setRows(prev => (prev ?? []).map(r2 => names[r2.userId] ? { ...r2, username: names[r2.userId] } : r2));
            }
            setNamesText(`${stopNames.stop ? "stopped — " : ""}resolved ${ids.length}, ${targets.length - ids.length} still unknown (deleted, blocked, or unfetchable)`);
        } finally {
            setNamesBusy(false);
        }
    };

    const deepSearchRosters = async () => {
        if (search.trim().length < 2) {
            setRosterText("Type at least 2 letters of their name above first.");
            return;
        }
        setRosterBusy(true);
        setRosterDone(false);
        setRosterMatches([]);
        setRosterText("searching every server you're in…");
        stopRoster.stop = false;
        try {
            const res = await searchGuildRosters(search, {
                exclude: new Set((rows ?? []).map(r => r.userId)),
                stop: stopRoster,
                onProgress: (done, total) => setRosterText(`searching servers ${done}/${total}…`),
            });
            setRosterMatches(res.persons);
            setRosterText(res.rateLimited
                ? `stopped early at Discord's rate limit — ${res.persons.length} match(es) from ${res.searched} server(s)`
                : `${res.persons.length} match(es) from ${res.searched} server(s)`);
        } catch (error: any) {
            setRosterText(`search failed: ${String(error?.message ?? error)}`);
        } finally {
            setRosterDone(true);
            setRosterBusy(false);
        }
    };

    const selectedIds = Object.keys(selected).filter(k => selected[k]);

    const toggleSelect = (userId: string) => {
        setSelected(prev => ({ ...prev, [userId]: !prev[userId] }));
    };
    const selectMany = (ids: string[], on: boolean) => {
        setSelected(prev => {
            const next = { ...prev };
            for (const id of ids) if (on) next[id] = true; else delete next[id];
            return next;
        });
    };

    const runBulkRestore = async () => {
        if (!selectedIds.length) return;
        setBulkBusy(true);
        setBulkText("starting…");
        stopBulk.stop = false;
        try {
            const res = await batchRestoreDms(selectedIds, {
                stop: stopBulk,
                onProgress: (done, total) => setBulkText(`restoring ${done}/${total}…`),
            });
            if (res.opened.length) ChannelRouter?.transitionToChannel?.(res.opened[res.opened.length - 1]);
            setBulkText(
                `${res.opened.length} restored`
                + (res.failed.length ? `, ${res.failed.length} refused (deleted/blocked)` : "")
                + (res.rateLimited ? " — stopped early at Discord's rate limit, select the rest and run again" : ""));
            selectMany(selectedIds, false);
        } finally {
            setBulkBusy(false);
        }
    };

    const openDm = (row: GhostDmRow) => {
        // Package-only channels were never loaded by the client — ask Discord
        // for the channel via create-or-get (returns the ORIGINAL one).
        if (row.fromPackage) {
            openPersonById(row.userId);
            return;
        }
        // the channel exists even when the sidebar hides it — jump straight to it;
        // the floating panel stays open so you can keep navigating
        try {
            ChannelRouter?.transitionToChannel?.(row.channelId);
        } catch {
            Toasts.show({ message: "Could not open that DM.", id: Toasts.genId(), type: Toasts.Type.FAILURE });
        }
    };

    const visible = (rows ?? []).filter(r =>
        (!nonFriendsOnly || !r.isFriend)
        && (!search || r.username.toLowerCase().includes(search.toLowerCase()) || r.userId.includes(search)));
    const hiddenCount = (rows ?? []).filter(r => !r.isFriend).length;

    // people the client has seen (user cache + every guild member cache) that
    // have no DM channel — searching names here finds old friends whose DM
    // channel vanished from the list, without needing a snowflake
    const peopleMatches = (rows !== null && search.trim().length >= 2 && !nonFriendsOnly)
        ? searchPeopleCache(search, new Set((rows ?? []).map(r => r.userId)))
        : [];

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Text variant="text-sm/normal">
                {rows === null
                    ? "loading your DM list…"
                    : `${rows.length} conversation${rows.length === 1 ? "" : "s"} · ${hiddenCount} hidden from your sidebar (not friends)`}
            </Text>

            <div>
                <TextInput
                    placeholder="Search by name…"
                    value={search}
                    onChange={(v: string) => setSearch(v)}
                />
            </div>
            <div>
                <Checkbox value={nonFriendsOnly} onChange={(_, v: boolean) => setNonFriendsOnly(v)}>
                    <Text variant="text-sm/normal">Only show hidden (non-friend) DMs</Text>
                </Checkbox>
            </div>

            {peopleMatches.length ? (
                <div style={panelStyle}>
                    <Text variant="text-xs/bold">
                        NOT IN YOUR DM LIST — BUT RECOGNIZED FROM SERVERS / CACHE ({peopleMatches.length})
                    </Text>
                    <div style={{ maxHeight: 160, overflowY: "auto" as const, marginTop: 6 }}>
                        {peopleMatches.map(p => (
                            <div key={p.userId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 4px" }}>
                                <span style={{ flex: 1 }}>{p.username}</span>
                                <span style={{ opacity: 0.4, fontSize: 11 }}>{p.userId}</span>
                                {snowflakeDate(p.userId) ? (
                                    <Text variant="text-xs/normal" style={{ opacity: 0.6 }}>since {snowflakeDate(p.userId)}</Text>
                                ) : null}
                                <Button
                                    variant="secondary"
                                    size="xs"
                                    disabled={busyId === p.userId}
                                    onClick={() => openPersonById(p.userId)}
                                >
                                    {busyId === p.userId ? "opening…" : "Open DM"}
                                </Button>
                            </div>
                        ))}
                    </div>
                    <Text variant="text-xs/normal" style={{ opacity: 0.7 }}>
                        "Open DM" restores the original conversation if one ever existed; otherwise it's an empty DM.
                    </Text>
                </div>
            ) : null}

            {Native ? (
                <div style={panelStyle}>
                    <Text variant="text-xs/bold">IMPORT FROM DISCORD DATA PACKAGE</Text>
                    <Text variant="text-xs/normal" style={{ opacity: 0.7 }}>
                        Point at an unzipped "Request all my Data" package (the folder with Messages/ +
                        Account/). Its DM list is complete — it finds every conversation you've ever had,
                        even ones Discord's live list hides.
                    </Text>
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                        <div style={{ flex: 1 }}>
                            <TextInput
                                placeholder="C:\Users\you\Desktop\package"
                                value={pkgPath}
                                onChange={(v: string) => setPkgPath(v)}
                            />
                        </div>
                        <Button variant="secondary" size="xs" disabled={pkgBusy} onClick={() => importPackage(true)}>
                            Browse…
                        </Button>
                        <Button variant="primary" size="xs" disabled={pkgBusy || !pkgPath.trim()} onClick={() => importPackage(false)}>
                            {pkgBusy ? "reading…" : "Import"}
                        </Button>
                    </div>
                    {pkgMsg ? (
                        <div style={{ marginTop: 4 }}>
                            <Text variant="text-xs/normal">{pkgMsg}</Text>
                        </div>
                    ) : null}
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                        <Button
                            variant="secondary"
                            size="xs"
                            disabled={namesBusy || !(rows ?? []).some(isPlaceholderName)}
                            onClick={() => resolveNames().catch(() => setNamesText("name lookup hit an unexpected error."))}
                        >
                            {namesBusy ? "looking up…" : `Resolve ${(rows ?? []).filter(isPlaceholderName).length} unknown name(s)`}
                        </Button>
                        {namesBusy ? (
                            <Button variant="secondary" size="xs" onClick={() => { stopNames.stop = true; }}>
                                Stop
                            </Button>
                        ) : null}
                    </div>
                    {namesText ? (
                        <div style={{ marginTop: 4 }}>
                            <Text variant="text-xs/normal">{namesText}</Text>
                        </div>
                    ) : null}
                    <Text variant="text-xs/normal" style={{ opacity: 0.6, marginTop: 2 }}>
                        Discord's export doesn't include people's profiles, so some rows say "user ‹id›".
                        This asks Discord (live, paced ~1.1s apart) for each account's current name; deleted,
                        blocked, or rate-limited accounts stay unknown.
                    </Text>
                </div>
            ) : null}

            {search.trim().length >= 2 ? (
                <div style={panelStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1 }}>
                            <Text variant="text-xs/bold">DEEP SEARCH: EVERY SERVER MEMBER LIST</Text>
                            <Text variant="text-xs/normal" style={{ opacity: 0.7 }}>
                                asks each of your servers to search its FULL roster server-side —
                                finds people not in your local cache at all
                            </Text>
                        </div>
                        {rosterBusy ? (
                            <Button variant="secondary" size="xs" onClick={() => { stopRoster.stop = true; }}>
                                Stop
                            </Button>
                        ) : (
                            <Button variant="primary" size="xs" onClick={() => deepSearchRosters()}>
                                Search {`"${search.trim()}"`} in all servers
                            </Button>
                        )}
                    </div>
                    {rosterText ? (
                        <div style={{ marginTop: 4 }}>
                            <Text variant="text-xs/normal">{rosterText}</Text>
                        </div>
                    ) : null}
                    {rosterMatches.length ? (
                        <div style={{ maxHeight: 160, overflowY: "auto" as const, marginTop: 6 }}>
                            {rosterMatches.map(p => (
                                <div key={p.userId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 4px" }}>
                                    <span style={{ flex: 1 }}>{p.username}</span>
                                    <Text variant="text-xs/normal" style={{ opacity: 0.6 }}>in {p.inGuild}</Text>
                                    <Button
                                        variant="secondary"
                                        size="xs"
                                        disabled={busyId === p.userId}
                                        onClick={() => openPersonById(p.userId)}
                                    >
                                        {busyId === p.userId ? "opening…" : "Open DM"}
                                    </Button>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {rosterDone && !rosterMatches.length ? (
                        <Text variant="text-xs/normal" style={{ opacity: 0.7 }}>
                            No one on that name in any server roster — the account may be deleted,
                            or they used a different username.
                        </Text>
                    ) : null}
                </div>
            ) : null}

            {showIdBox ? (
                <div style={panelStyle}>
                    <div style={{ display: "flex", gap: 8 }}>
                        <div style={{ flex: 1 }}>
                            <TextInput
                                placeholder="User ID (15–20 digit snowflake)"
                                value={userId}
                                onChange={(v: string) => setUserId(v)}
                            />
                        </div>
                        <Button
                            variant="primary"
                            size="xs"
                            disabled={busyId !== "" || !userId.trim()}
                            onClick={() => openPersonById(userId)}
                        >
                            {busyId ? "opening…" : "Open DM"}
                        </Button>
                    </div>
                    {SNOWFLAKE_RE.test(userId.trim()) && snowflakeDate(userId.trim()) ? (
                        <div style={{ marginTop: 4 }}>
                            <Text variant="text-xs/normal">account created {snowflakeDate(userId.trim())}</Text>
                        </div>
                    ) : null}
                </div>
            ) : (
                <div>
                    <Button variant="link" size="xs" onClick={() => setShowIdBox(true)}>
                        Have a user ID instead? Open by ID
                    </Button>
                </div>
            )}
            {lookupError ? (
                <div>
                    <Text variant="text-xs/normal">{lookupError}</Text>
                </div>
            ) : null}

            {rows !== null && visible.length ? (
                <div style={panelStyle}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <Button
                            variant="secondary" size="xs" disabled={bulkBusy}
                            onClick={() => selectMany(visible.map(r => r.userId), true)}
                        >
                            Select all ({visible.length})
                        </Button>
                        <Button
                            variant="secondary" size="xs" disabled={bulkBusy}
                            onClick={() => selectMany(visible.filter(r => !r.isFriend).map(r => r.userId), true)}
                        >
                            Select all non-friends ({visible.filter(r => !r.isFriend).length})
                        </Button>
                        {lastScan ? (
                            <Button
                                variant="secondary" size="xs" disabled={bulkBusy}
                                onClick={() => selectMany(visible.filter(r => r.fromPackage).map(r => r.userId), true)}
                            >
                                Select package-only ({visible.filter(r => r.fromPackage).length})
                            </Button>
                        ) : null}
                        <Button variant="link" size="xs" disabled={bulkBusy} onClick={() => selectMany(Object.keys(selected), false)}>
                            Clear
                        </Button>
                        {selectedIds.length ? (
                            <Button
                                variant={bulkBusy ? "secondary" : "primary"} size="xs"
                                onClick={() => (bulkBusy ? (stopBulk.stop = true) : runBulkRestore())}
                            >
                                {bulkBusy ? `Stop (${selectedIds.length} picked)` : `Restore ${selectedIds.length} selected DMs`}
                            </Button>
                        ) : null}
                    </div>
                    <Text variant="text-xs/normal">
                        "Restore" re-opens the DM channels for every picked person at once (paced so Discord doesn't
                        rate-limit you), then jumps you to the last one — they're all back in your sidebar afterwards.
                    </Text>
                    {bulkText ? (
                        <div>
                            <Text variant="text-xs/normal">{bulkText}</Text>
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div style={{ ...panelStyle, overflowY: "auto", padding: 4 }}>
                {rows !== null && !visible.length ? (
                    <div style={{ padding: 12, opacity: 0.7 }}>No DMs match this filter.</div>
                ) : null}
                {visible.map(row => (
                    <div key={row.channelId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px" }}>
                        <Checkbox
                            value={!!selected[row.userId]}
                            disabled={bulkBusy}
                            onChange={() => toggleSelect(row.userId)}
                        />
                        <span style={{ flex: 1 }}>{row.username}</span>
                        <Text variant="text-xs/normal" style={{ opacity: 0.6 }}>
                            {row.isFriend ? "friend" : "not friends"}
                            {row.fromPackage ? " · package only" : ""}
                        </Text>
                        <span style={{ opacity: 0.4, fontSize: 11 }}>{row.userId}</span>
                        <Button variant="secondary" size="xs" onClick={() => openDm(row)}>
                            Open
                        </Button>
                    </div>
                ))}
            </div>

            <Text variant="text-xs/normal">
                Opening a listed DM only navigates — nothing is sent or deleted. Typing a name also
                searches everyone Discord has shown you (user cache + all your servers' member
                lists), so old friends whose DM channel vanished still turn up without knowing
                their ID. Leave any opened DM by clicking another conversation.
            </Text>
        </div>
    );
}
