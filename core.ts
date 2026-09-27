/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Engine layer — no React, no settings import. Everything the UI (commands,
// dashboard modal) runs through lives here, with explicit settings passed in
// so the dashboard can override scope per run.

import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";
import { EmbedJSON, MessageAttachment, MessageJSON } from "@vencord/discord-types";
import { ChannelStore, Constants, MessageStore, RestAPI, UserStore } from "@webpack/common";

import {
    formatSkippedMediaReport,
    getFileName,
    isDiscordCdnUrl,
    sanitizeFileName,
    SkippedMediaEntry,
    URL_IMAGE_EXT_RE,
    UrlCandidate,
} from "./utils";

const Native = VencordNative.pluginHelpers.DMArchiver as PluginNative<typeof import("./native")>;

export const log = new Logger("DMArchiver");

export interface ArchiverSettings {
    downloadFolder: string;
    includeLinkImages: boolean;
    exportExternalMedia: boolean;
    maxImages: number;
}

export interface ExportResult {
    foundImages: number;
    savedImages: number;
    skipped: SkippedMediaEntry[];
}

export type Tick = (message: string) => void;
export type Progress = (p: { user: string; found: number; saved: number; }) => void;

// ─── Quest hiding ────────────────────────────────────────────────────────────

export const HIDE_QUEST_STYLE_ID = "vc-dmarchiver-hide-quests";
const HIDE_QUEST_CSS = `
    [aria-label*="Quest" i],
    [aria-label*="Quests" i],
    a[href*="/quest" i],
    button[aria-label*="Quest" i] {
        display: none !important;
    }
`;

export function applyQuestHiding(enabled: boolean): void {
    document.getElementById(HIDE_QUEST_STYLE_ID)?.remove();
    if (!enabled) return;

    const style = document.createElement("style");
    style.id = HIDE_QUEST_STYLE_ID;
    style.textContent = HIDE_QUEST_CSS;
    document.head.appendChild(style);
}

// ─── Message URL candidates ──────────────────────────────────────────────────

export function getCandidates(message: MessageJSON, includeLinkImages: boolean): UrlCandidate[] {
    const out = new Map<string, UrlCandidate>();
    const add = (url: string, filename?: string) => {
        if (out.has(url)) return;
        out.set(url, {
            url,
            filename,
            type: isDiscordCdnUrl(url) ? "discord" : "external",
        });
    };

    for (const att of message.attachments ?? []) {
        if (att.url) add(att.url, att.filename);
    }

    for (const emb of message.embeds as EmbedJSON[] ?? []) {
        if (emb.thumbnail?.url) add(emb.thumbnail.url);
        // EmbedJSON lacks `image` in the type defs, but Discord sends it
        if ((emb as any).image?.url) add((emb as any).image.url);
        if (emb.video?.url) add(emb.video.url);
        if (emb.url && URL_IMAGE_EXT_RE.test(emb.url)) add(emb.url);
    }

    if (includeLinkImages && message.content) {
        for (const token of message.content.split(/\s+/)) {
            if (/^https?:\/\//i.test(token)) {
                try {
                    add(new URL(token).href);
                } catch { /* malformed */ }
            }
        }
    }

    return [...out.values()];
}

// ─── Downloading & saving ────────────────────────────────────────────────────

export function isSupportedMediaContentType(contentType?: string): boolean {
    if (!contentType) return false;
    const mime = contentType.split(";")[0].trim().toLowerCase();
    return mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/");
}

export async function downloadMedia(url: string): Promise<{ bytes: Uint8Array; contentType?: string; }> {
    try {
        const nativeResult = await Native.downloadUrl(url);
        if (nativeResult.ok) {
            return { bytes: new Uint8Array(nativeResult.bytes as any), contentType: nativeResult.contentType };
        }
        log.warn("native download failed, falling back to fetch:", nativeResult.error);
    } catch (error) {
        log.warn("native download threw, falling back to fetch:", error);
    }

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const contentType = response.headers.get("content-type") ?? undefined;
    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
}

export async function saveFile(data: Uint8Array, fileName: string, downloadFolder: string): Promise<void> {
    const folder = downloadFolder?.trim().replace(/[\\/]+$/, "");

    if (folder) {
        const result = await Native.writeFile(folder, fileName, data);
        if (result.success) return;
        throw new Error(`writeFile to ${folder} failed: ${result.error}`);
    }

    if (DiscordNative?.fileManager?.saveWithDialog) {
        await DiscordNative.fileManager.saveWithDialog(data, fileName);
        return;
    }

    // Last resort: browser download
    const blob = new Blob([data as unknown as ArrayBuffer]);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(link.href);
}

async function fileExists(fileName: string, downloadFolder: string): Promise<boolean> {
    const folder = downloadFolder?.trim().replace(/[\\/]+$/, "");
    if (!folder) return false;
    try {
        return await Native.fileExists(folder, fileName);
    } catch {
        return false;
    }
}

async function processCandidate(
    settings: ArchiverSettings,
    candidate: UrlCandidate,
    fallbackName: string,
    username: string,
    messageId: string,
): Promise<{ saved: boolean; reason?: string; }> {
    if (candidate.type === "external" && !settings.exportExternalMedia) {
        return { saved: false, reason: "external media excluded by settings (exportExternalMedia=false)" };
    }

    let media: { bytes: Uint8Array; contentType?: string; };
    try {
        media = await downloadMedia(candidate.url);
    } catch (error) {
        return { saved: false, reason: `download failed: ${String(error)}` };
    }

    if (media.contentType && !isSupportedMediaContentType(media.contentType)) {
        return { saved: false, reason: `unsupported content-type ${media.contentType}` };
    }
    if (!candidate.url.match(URL_IMAGE_EXT_RE) && !media.contentType) {
        return { saved: false, reason: "unsupported or missing media extension" };
    }

    try {
        const fileName = `${username}_${messageId}_${getFileName(candidate.url, fallbackName, media.contentType)}`;
        await saveFile(media.bytes, fileName, settings.downloadFolder);
        return { saved: true };
    } catch (error) {
        return { saved: false, reason: `save failed: ${String(error)}` };
    }
}

// ─── REST helpers ────────────────────────────────────────────────────────────

export async function fetchAllDmChannels(): Promise<any[]> {
    try {
        const response = await RestAPI.get({ url: "/users/@me/channels" });
        return Array.isArray(response.body) ? response.body : [];
    } catch (error) {
        log.warn("failed to fetch /users/@me/channels:", error);
        return [];
    }
}

export function dmRecipientId(channel: any): string | undefined {
    if (!channel || channel.type !== 1 /* DM */) return undefined;
    const id = channel.recipient_ids?.[0] ?? channel.recipients?.[0]?.id;
    return id ? String(id) : undefined;
}

/** userId -> channelId, merging the REST DM list with whatever the store knows */
export async function collectDmUserChannels(): Promise<Map<string, string>> {
    const perUser = new Map<string, string>();
    for (const ch of await fetchAllDmChannels()) {
        const uid = dmRecipientId(ch);
        if (uid && ch.id) perUser.set(uid, ch.id);
    }
    for (const uid of ChannelStore.getDMUserIds() ?? []) {
        if (!perUser.has(uid)) {
            const chId = ChannelStore.getDMFromUserId(uid);
            if (chId) perUser.set(uid, chId);
        }
    }
    return perUser;
}

export async function resolveDmChannelId(userId: string): Promise<string | undefined> {
    const storeChannelId = ChannelStore.getDMFromUserId(userId);
    if (storeChannelId) return storeChannelId;

    const channels = await fetchAllDmChannels();
    return channels.find(ch => dmRecipientId(ch) === userId)?.id;
}

export async function fetchMessages(channelId: string, maxImages: number): Promise<MessageJSON[]> {
    const results: MessageJSON[] = [];
    const seen = new Set<string>();

    // Seed from cache
    try {
        const cache = MessageStore.getMessages(channelId);
        if (cache && Array.isArray(cache._array)) {
            for (const msg of cache._array) {
                if (msg?.id && !seen.has(msg.id)) {
                    seen.add(msg.id);
                    results.push(msg as unknown as MessageJSON);
                }
            }
        }
    } catch { /* cache shape may differ */ }

    const maxPages = 500;
    let before: string | undefined;

    for (let page = 0; page < maxPages; page++) {
        const query: Record<string, any> = { limit: 100 };
        if (before) query.before = before;

        try {
            const response = await RestAPI.get({
                url: Constants.Endpoints.MESSAGES(channelId),
                query,
            });
            const body = response.body as MessageJSON[] | undefined;
            if (!Array.isArray(body) || !body.length) break;

            const batch = body.filter(msg => msg?.id && !seen.has(msg.id));
            batch.forEach(msg => seen.add(msg.id));
            if (!batch.length) break;

            results.push(...batch);
            before = batch[batch.length - 1]?.id;
            if (!before || body.length < 100) break;

            if (maxImages > 0 && results.length >= maxImages * 3) break;
            await new Promise(r => setTimeout(r, 150));
        } catch (error) {
            log.warn(`history fetch failed for channel ${channelId} page ${page}:`, error);
            break;
        }
    }

    // Oldest first (snowflake ids are fixed-width → lexicographic sort is safe)
    return results.sort((a, b) => a.id.localeCompare(b.id));
}

// ─── Export flows ────────────────────────────────────────────────────────────

export async function exportAllDmMedia(
    settings: ArchiverSettings,
    specificUserId?: string,
    onTick?: Tick,
    report?: Progress,
): Promise<ExportResult> {
    const perUser = await collectDmUserChannels();

    const targetIds = specificUserId ? [specificUserId] : [...perUser.keys()];
    if (specificUserId && !perUser.has(specificUserId)) {
        throw new Error(`User ID ${specificUserId} not found in DM list. Use /list-dm-users to see available IDs.`);
    }

    let found = 0;
    let saved = 0;
    const seenUrls = new Set<string>();
    const skipped: SkippedMediaEntry[] = [];

    for (const userId of targetIds) {
        const channelId = perUser.get(userId);
        if (!channelId) {
            log.warn(`no DM channel for user ${userId}`);
            continue;
        }

        const username = UserStore.getUser(userId)?.username ?? userId;
        const messages = await fetchMessages(channelId, settings.maxImages);
        if (!messages.length) {
            log.info(`no messages for ${username}`);
            continue;
        }

        for (const message of messages) {
            for (const candidate of getCandidates(message, settings.includeLinkImages)) {
                if (seenUrls.has(candidate.url)) continue;
                seenUrls.add(candidate.url);
                found++;

                if (settings.maxImages > 0 && saved >= settings.maxImages) {
                    skipped.push({ url: candidate.url, type: candidate.type, reason: "maxImages limit reached", user: username, messageId: message.id });
                    continue;
                }

                const fallbackName = candidate.filename ?? "attachment";
                const previewName = `${username}_${message.id}_${getFileName(candidate.url, fallbackName)}`;
                if (await fileExists(previewName, settings.downloadFolder)) {
                    saved++;
                    continue;
                }

                const result = await processCandidate(settings, candidate, fallbackName, username, message.id);
                if (result.saved) {
                    saved++;
                    if (saved % 10 === 0) onTick?.(`saved ${saved} files`);
                } else {
                    skipped.push({ url: candidate.url, type: candidate.type, reason: result.reason ?? "failed", user: username, messageId: message.id });
                }
            }
        }

        report?.({ user: username, found, saved });
    }

    if (skipped.length) {
        try {
            await saveFile(new TextEncoder().encode(formatSkippedMediaReport(skipped)), `dmarchiver_skipped_${Date.now()}.txt`, settings.downloadFolder);
            onTick?.(`saved skipped-media report (${skipped.length} entries)`);
        } catch (error) {
            log.warn("failed to save skipped media report:", error);
        }
    }

    log.info(`export complete: found ${found}, saved ${saved}`);
    return { foundImages: found, savedImages: saved, skipped };
}

export async function exportForUsers(
    settings: ArchiverSettings,
    userIds: string[],
    onTick?: Tick,
    report?: Progress,
): Promise<ExportResult> {
    const total = { foundImages: 0, savedImages: 0, skipped: [] as SkippedMediaEntry[] };
    for (const userId of userIds) {
        const r = await exportAllDmMedia(settings, userId, onTick, report);
        total.foundImages += r.foundImages;
        total.savedImages += r.savedImages;
        total.skipped.push(...r.skipped);
    }
    return total;
}

export function formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

export async function saveDmAsText(settings: ArchiverSettings, channelId: string, userId: string): Promise<number> {
    const username = UserStore.getUser(userId)?.username ?? userId;
    const messages = await fetchMessages(channelId, settings.maxImages);

    let text =
        `DM Conversation with ${username} (${userId})\n` +
        `Exported on ${new Date().toLocaleString()}\n` +
        `Total messages: ${messages.length}\n` +
        "=".repeat(80) + "\n\n";

    for (const message of messages) {
        const authorName = UserStore.getUser(message.author?.id)?.username ?? "Unknown";
        text += `[${formatTimestamp(message.timestamp)}] ${authorName}:\n${message.content ?? ""}\n`;
        const atts = message.attachments as MessageAttachment[] | undefined;
        if (atts?.length) {
            text += `  [Attachments: ${atts.length}]\n`;
            for (const att of atts) text += `    - ${att.url}\n`;
        }
        text += "\n";
    }

    const bytes = new TextEncoder().encode(text);
    await saveFile(bytes, sanitizeFileName(`dm_${username}_${Date.now()}.txt`) + ".txt", settings.downloadFolder);
    return bytes.length;
}

export async function saveAllDmsAsText(settings: ArchiverSettings): Promise<{ savedFiles: number; total: number; }> {
    const perUser = await collectDmUserChannels();
    if (!perUser.size) throw new Error("No DM users found. Make sure your DM list is loaded.");

    let savedFiles = 0;
    for (const [userId, channelId] of perUser) {
        try {
            await saveDmAsText(settings, channelId, userId);
            savedFiles++;
        } catch (error) {
            log.warn(`failed to save DM text for ${userId}:`, error);
        }
    }
    return { savedFiles, total: perUser.size };
}

export async function getFriendIds(): Promise<Set<string>> {
    try {
        const relationships = await RestAPI.get({ url: "/users/@me/relationships" });
        return new Set<string>(
            (Array.isArray(relationships.body) ? relationships.body : [])
                .filter((r: any) => r.type === 1)
                .map((r: any) => String(r.id)),
        );
    } catch (error) {
        log.warn("failed to fetch relationships:", error);
        return new Set();
    }
}

export async function getNonFriendDms(): Promise<Array<{ id: string; username: string; }>> {
    const friendIds = await getFriendIds();
    const out: Array<{ id: string; username: string; }> = [];
    for (const ch of await fetchAllDmChannels()) {
        const uid = dmRecipientId(ch);
        if (uid && !friendIds.has(uid)) {
            out.push({ id: uid, username: UserStore.getUser(uid)?.username ?? "Unknown" });
        }
    }
    return out;
}

// ─── Deletion flows (own messages only) ─────────────────────────────────────

export async function deleteUserMessages(
    channelId: string,
    batchSize = 20,
    delayMs = 1500,
    onTick?: Tick,
): Promise<{ deleted: number; failed: number; }> {
    let deleted = 0;
    let failed = 0;

    const currentUserId = UserStore.getCurrentUser()?.id;
    const ownMessages = (await fetchMessages(channelId, 0)).filter(msg => msg.author?.id === currentUserId);

    for (let offset = 0; offset < ownMessages.length; offset += batchSize) {
        const batch = ownMessages.slice(offset, offset + batchSize);

        for (const message of batch) {
            let attempt = 0;
            let done = false;
            while (attempt < 3 && !done) {
                attempt++;
                try {
                    const response = await RestAPI.del({ url: Constants.Endpoints.MESSAGE(channelId, message.id) });
                    done = Boolean(response?.ok || response?.status === 204 || response?.status === 200);
                    if (done) deleted++;
                    else log.warn(`delete attempt ${attempt} failed for ${message.id}`);
                } catch (error) {
                    log.warn(`delete attempt ${attempt} threw for ${message.id}:`, error);
                }
                if (!done && attempt < 3) await new Promise(r => setTimeout(r, delayMs));
            }
            if (!done) failed++;
        }

        if (offset + batchSize < ownMessages.length) await new Promise(r => setTimeout(r, delayMs));
        onTick?.(`deleted ${deleted}…`);
    }

    return { deleted, failed };
}
