/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface RestLike {
    /** resolves with body on 2xx, throws on 4xx/5xx (matches Discord RestAPI) */
    get(opts: { url: string; query?: Record<string, unknown> }): Promise<any>;
}

export interface SweepTarget {
    kind: "guild" | "dm";
    id: string;
    label: string;
}

export interface MediaHit {
    messageId: string;
    channelId: string;
    channelLabel: string;
    kind: "guild" | "dm";
    guildId: string | null;
    timestamp: string;
    urls: string[];
    preview: string;
}

export interface SweepReport {
    hits: MediaHit[];
    channelsScanned: number;
    channelsFailed: number;
    /** channels still rate-limited after the single courtesy retry */
    rateLimited: number;
    truncated: boolean;
}

export interface SweepOptions {
    maxChannels?: number; // safety cap
    delayMs?: number; // courtesy pause between requests
    onProgress?(done: number, total: number, label: string): void;
    /** pacing changes (throttle-up after 429s, relax after clean runs) */
    onPace?(ms: number): void;
}

export const SWEEP_DEFAULTS = { maxChannels: 400, delayMs: 150 };

/**
 * Build the sweep list: all guilds first (usually higher media yield), then
 * DMs. When `userId` is given, DM-type channels that provably do NOT include
 * that person are skipped: a DM can only contain messages from its own
 * participants, so 100+ unrelated DMs are pure wasted search budget (and
 * 429 risk). Channels with unknown recipients stay in — we can't rule them out.
 */
export function planSweep(
    guilds: Array<{ id: string; name: string }>,
    channels: Array<{ id: string; type: number; name?: string; recipient_ids?: string[]; recipients?: Array<{ id: string; username?: string; global_name?: string }> }>,
    userId?: string,
): SweepTarget[] {
    const out: SweepTarget[] = [];
    for (const g of guilds ?? []) if (g?.id) out.push({ kind: "guild", id: g.id, label: g.name || g.id });
    for (const c of channels ?? []) {
        if (!c?.id || (c.type !== 1 && c.type !== 3)) continue; // DM + group DM only
        // house pattern: real API gives `recipients`, older payloads `recipient_ids`
        const recips = c.recipients ?? c.recipient_ids ?? [];
        if (userId && recips.length && !recips.some((r: any) => String(r?.id ?? r) === String(userId))) continue;
        const label = c.name || (c.recipients ?? []).map(r => r.global_name || r.username).filter(Boolean).join(", ") || "DM";
        out.push({ kind: "dm", id: c.id, label });
    }
    return out;
}

const MEDIA_HOSTS = ["cdn.discordapp.com", "media.discordapp.net", "canary.discordapp", "ptb.discordapp"];

/** A URL is media when it lives on Discord's CDN or looks like a media file. */
export function isMediaUrl(u: string): boolean {
    if (typeof u !== "string" || !u.startsWith("http")) return false;
    if (MEDIA_HOSTS.some(h => u.includes(h))) return true;
    return /\.(png|jpe?g|gif|webp|mp4|webm|mov|gifv|avif)([?#]|$)/i.test(u);
}

/** Pull media URLs out of one raw message JSON (attachments + embeds + text). */
export function extractMedia(msg: any): { urls: string[]; ts: string; preview: string } {
    const urls: string[] = [];
    for (const a of msg?.attachments ?? []) {
        const u = a?.url ?? a?.proxy_url;
        if (u && isMediaUrl(u)) urls.push(u);
    }
    for (const e of msg?.embeds ?? []) {
        const u = e?.image?.url ?? e?.video?.url ?? e?.thumbnail?.url;
        if (u && isMediaUrl(u)) urls.push(u);
    }
    // bare CDN links typed into text (Discord's search matched them via `has`)
    for (const m of String(msg?.content ?? "").match(/https?:\/\/\S+/g) ?? []) {
        const clean = m.replace(/[)>.,;'"]+$/, "");
        if (isMediaUrl(clean)) urls.push(clean);
    }
    const urlsUnique = [...new Set(urls)];
    const content = String(msg?.content ?? "").trim();
    return {
        urls: urlsUnique,
        ts: msg?.timestamp ?? "",
        preview: (content || urlsUnique[0] || "").slice(0, 120),
    };
}

/**
 * One author-scoped `has=file` pass over a single channel, paginated.
 * `keepPartialOn429`: a 429 mid-pagination normally REJECTS the whole
 * channel — discarding pages already collected (live-proven: soul's DM had
 * 25 good hits on page 0, page-1 429 threw them all away). The sweep passes
 * true so pages survive; the one-shot retry re-searches from 0 and dedupe
 * collapses the overlap.
 */
export async function searchChannel(
    rest: RestLike,
    target: SweepTarget,
    userId: string,
    clock: () => number = Date.now,
    opts: { keepPartialOn429?: boolean; state?: { saw429: boolean; retryAfter?: number } } = {},
): Promise<MediaHit[]> {
    const base = target.kind === "guild"
        ? `/guilds/${target.id}/messages/search`
        : `/channels/${target.id}/messages/search`;
    const out: MediaHit[] = [];
    const swallow = (e: any) => {
        if (e?.status === 429) {
            if (opts.state) {
                opts.state.saw429 = true;
                opts.state.retryAfter = Number(e?.retryAfter ?? e?.body?.retry_after) || 3;
            }
            return !!opts.keepPartialOn429;
        }
        return false;
    };
    let offset = 0;
    // LIVE-PROVEN: /messages/search rejects limit>25 with 400. 40x25 = 1000 msg cap.
    for (let page = 0; page < 40; page++) {
        let res: any;
        try {
            res = await rest.get({
                url: base,
                query: { author_id: userId, has: "file", limit: 25, offset },
            });
        } catch (e: any) {
            if (swallow(e)) break; // keep what page(s) gave us
            throw e;
        }
        // Vencord RestAPI wraps responses: { body, status, ok }
        const data = res?.body ?? res;
        // LIVE-PROVEN SHAPE: Discord groups search hits — /channels/<dm>/search
        // with 16 hits returned 16 SEPARATE 1-message groups ([[m],[m],...]).
        // Reading only messages[0] silently yields ONE media per channel.
        // Flatten every group; plain (ungrouped) arrays pass through flat().
        const raw = data?.messages ?? [];
        const msgs: any[] = Array.isArray(raw[0]) ? raw.flat() : raw;
        if (!msgs.length) break;
        for (const msg of msgs) {
            if (!msg?.id) continue;
            // defense in depth: the query already filters author; never leak
            // someone else's media through a server-side glitch
            if (String(msg?.author?.id ?? userId) !== String(userId)) continue;
            const { urls, ts, preview } = extractMedia(msg);
            if (!urls.length) continue;
            out.push({
                messageId: String(msg.id),
                channelId: String(msg.channel_id ?? target.id),
                channelLabel: target.label,
                kind: target.kind,
                guildId: target.kind === "guild" ? target.id : null,
                timestamp: ts,
                urls,
                preview,
            });
        }
        if (msgs.length < 25) break;
        offset += 25;
        if (clock() === -Infinity) break; // test hook, never true in prod
    }
    return out;
}

/** Full sweep across all accessible places, with progress + failure accounting. */
export async function sweepAll(
    rest: RestLike,
    targets: SweepTarget[],
    userId: string,
    opts: SweepOptions = {},
): Promise<SweepReport> {
    const maxChannels = opts.maxChannels ?? SWEEP_DEFAULTS.maxChannels;
    const baseDelay = opts.delayMs ?? SWEEP_DEFAULTS.delayMs;
    const report: SweepReport = { hits: [], channelsScanned: 0, channelsFailed: 0, rateLimited: 0, truncated: false };
    const list = targets.slice(0, maxChannels);
    if (targets.length > list.length) report.truncated = true;

    // ADAPTIVE THROTTLE (measured: rapid sweeps get ~30% 429s). Start polite,
    // triple the pause on every 429 (cap 3s), relax by half after 20 clean
    // channels — Discord's search rate-limit window recovers within seconds.
    let delay = baseDelay;
    let cleanStreak = 0;

    let done = 0;
    for (const t of list) {
        done++;
        opts.onProgress?.(done, list.length, t.label);
        const st = { saw429: false, retryAfter: 0 };
        try {
            // 429 mid-page keeps already-collected hits (live-proven loss:
            // soul's DM page-0 returned 25 hits, page-1 429 threw ALL of them)
            report.hits.push(...await searchChannel(rest, t, userId, Date.now, { keepPartialOn429: true, state: st }));
        } catch {
            report.channelsFailed++; // 403/no-index/etc — skip quietly
        }
        if (st.saw429) {
            delay = Math.min(delay * 3, 3000); // escalate pacing
            cleanStreak = 0;
            opts.onPace?.(delay);
            await new Promise(r => setTimeout(r, Math.min(st.retryAfter || 3, 6) * 1000));
            const st2 = { saw429: false, retryAfter: 0 };
            try {
                report.hits.push(...await searchChannel(rest, t, userId, Date.now, { keepPartialOn429: true, state: st2 }));
            } catch { /* retry errored — partials from pass 1 still stand */ }
            if (st2.saw429) report.rateLimited++; // retry STILL limited — Retry can catch more
        } else {
            // no 429 here (200 or 403 — both cost ~one request) → count toward relax
            cleanStreak++;
            if (cleanStreak >= 20 && delay > baseDelay) {
                delay = Math.max(baseDelay, Math.floor(delay / 2));
                cleanStreak = 0;
                opts.onPace?.(delay);
            }
        }
        report.channelsScanned++; // attempted = scanned, whatever the outcome
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }

    // collapse duplicate message ids across pages (crossposts/forwards)
    report.hits = dedupePerMessage(report.hits);
    report.hits.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    return report;
}

/** collapse duplicate message ids across pages, merging their url sets */
export function dedupePerMessage(hits: MediaHit[]): MediaHit[] {
    const byId = new Map<string, MediaHit>();
    for (const h of hits) {
        const key = h.channelId + ":" + h.messageId;
        const prev = byId.get(key);
        if (!prev) byId.set(key, { ...h, urls: [...h.urls] });
        else for (const u of h.urls) if (!prev.urls.includes(u)) prev.urls.push(u);
    }
    return [...byId.values()];
}

/** Discord URL that opens + highlights the message. `@me` for DMs. */
export function jumpUrl(hit: MediaHit): string {
    const host = String(globalThis?.location?.host ?? "canary.discord.com");
    const guild = hit.kind === "guild" ? hit.guildId : "@me";
    return `https://${host}/channels/${guild}/${hit.channelId}/${hit.messageId}`;
}

/** All media URLs as plain text (clipboard copy-all). */
export function allUrls(hits: MediaHit[]): string {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const h of hits) for (const u of h.urls) {
        if (!seen.has(u)) { seen.add(u); lines.push(u); }
    }
    return lines.join("\n");
}
