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
}

export const SWEEP_DEFAULTS = { maxChannels: 400, delayMs: 60 };

/** Build the sweep list: all guilds first (usually higher media yield), then DMs. */
export function planSweep(
    guilds: Array<{ id: string; name: string }>,
    channels: Array<{ id: string; type: number; name?: string; recipients?: Array<{ id: string; username?: string; global_name?: string }> }>,
): SweepTarget[] {
    const out: SweepTarget[] = [];
    for (const g of guilds ?? []) if (g?.id) out.push({ kind: "guild", id: g.id, label: g.name || g.id });
    for (const c of channels ?? []) {
        if (!c?.id || (c.type !== 1 && c.type !== 3)) continue; // DM + group DM only
        const label = c.name || c.recipients?.map(r => r.global_name || r.username).filter(Boolean).join(", ") || "DM";
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

/** One author-scoped `has=file` pass over a single channel, paginated. */
export async function searchChannel(
    rest: RestLike,
    target: SweepTarget,
    userId: string,
    clock: () => number = Date.now,
): Promise<MediaHit[]> {
    const base = target.kind === "guild"
        ? `/guilds/${target.id}/messages/search`
        : `/channels/${target.id}/messages/search`;
    const out: MediaHit[] = [];
    let offset = 0;
    // LIVE-PROVEN: /messages/search rejects limit>25 with 400. 40x25 = 1000 msg cap.
    for (let page = 0; page < 40; page++) {
        const res = await rest.get({
            url: base,
            query: { author_id: userId, has: "file", limit: 25, offset },
        });
        // Vencord RestAPI wraps responses: { body, status, ok }
        const data = res?.body ?? res;
        const msgs: any[] = Array.isArray(data?.messages?.[0]) ? data.messages[0] : (data?.messages ?? []);
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
    const delayMs = opts.delayMs ?? SWEEP_DEFAULTS.delayMs;
    const report: SweepReport = { hits: [], channelsScanned: 0, channelsFailed: 0, rateLimited: 0, truncated: false };
    const list = targets.slice(0, maxChannels);
    if (targets.length > list.length) report.truncated = true;

    let done = 0;
    for (const t of list) {
        done++;
        opts.onProgress?.(done, list.length, t.label);
        try {
            report.hits.push(...await searchChannel(rest, t, userId));
        } catch (e: any) {
            if (e?.status === 429) {
                // Discord rate-limits message search hard (measured live: ~30%
                // of rapid requests). Vencord's RestAPI rejects with the full
                // response: { status, retryAfter (s), body.retry_after }.
                // Wait the advertised pause, give the channel ONE more chance.
                const wait = Math.min(Number(e?.retryAfter ?? e?.body?.retry_after) || 3, 6) * 1000;
                await new Promise(r => setTimeout(r, wait));
                try {
                    report.hits.push(...await searchChannel(rest, t, userId));
                } catch {
                    report.rateLimited++; // still limited — Retry can recover it
                }
            } else {
                report.channelsFailed++; // private archive/403/no-index — skip quietly
            }
        }
        report.channelsScanned++; // attempted = scanned, whatever the outcome
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
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
