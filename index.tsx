/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandOptionType, findOption } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { EmbedJSON, MessageAttachment, MessageJSON } from "@vencord/discord-types";
import { ChannelStore, Constants, MessageStore, RestAPI, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

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

const log = new Logger("DMArchiver");

const settings = definePluginSettings({
    downloadFolder: {
        type: OptionType.STRING,
        description: "Absolute folder path to store exported files into (desktop only). Leave empty to be prompted for each file.",
        placeholder: "C:\\Users\\<you>\\Pictures\\DMExport",
        default: "",
    },
    targetUserId: {
        type: OptionType.STRING,
        description: "Default user ID to operate on. Leave empty to use the current channel. Use /list-dm-users to find IDs.",
        default: "",
    },
    includeLinkImages: {
        type: OptionType.BOOLEAN,
        description: "Also harvest image-like URLs typed directly into message text.",
        default: true,
    },
    exportExternalMedia: {
        type: OptionType.BOOLEAN,
        description: "Export non-Discord-CDN links (imgur, githubusercontent, ...).\n⚠️ External links may die over time.",
        default: false,
    },
    maxImages: {
        type: OptionType.NUMBER,
        description: "Max files to save per run (0 = unlimited).",
        default: 0,
    },
    hideQuestStuff: {
        type: OptionType.BOOLEAN,
        description: "Hide Discord Quest UI elements while the plugin is enabled.",
        default: false,
        onChange: () => applyQuestHiding(settings.store.hideQuestStuff),
    },
    showDeleteOption: {
        type: OptionType.BOOLEAN,
        description: "Unlocks the message-deletion commands. Use responsibly — only your own messages are ever deleted.",
        default: false,
    },
});

// ─── Quest hiding ────────────────────────────────────────────────────────────

const HIDE_QUEST_STYLE_ID = "vc-dmarchiver-hide-quests";
const HIDE_QUEST_CSS = `
    [aria-label*="Quest" i],
    [aria-label*="Quests" i],
    a[href*="/quest" i],
    button[aria-label*="Quest" i] {
        display: none !important;
    }
`;

function applyQuestHiding(enabled: boolean): void {
    document.getElementById(HIDE_QUEST_STYLE_ID)?.remove();
    if (!enabled) return;

    const style = document.createElement("style");
    style.id = HIDE_QUEST_STYLE_ID;
    style.textContent = HIDE_QUEST_CSS;
    document.head.appendChild(style);
}

// ─── Message URL candidates ──────────────────────────────────────────────────

function getCandidates(message: MessageJSON): UrlCandidate[] {
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

    if (settings.store.includeLinkImages && message.content) {
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

function isSupportedMediaContentType(contentType?: string): boolean {
    if (!contentType) return false;
    const mime = contentType.split(";")[0].trim().toLowerCase();
    return mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/");
}

async function downloadMedia(url: string): Promise<{ bytes: Uint8Array; contentType?: string; }> {
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

async function saveFile(data: Uint8Array, fileName: string): Promise<void> {
    const folder = settings.store.downloadFolder?.trim().replace(/[\\/]+$/, "");

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

async function fileExists(fileName: string): Promise<boolean> {
    const folder = settings.store.downloadFolder?.trim().replace(/[\\/]+$/, "");
    if (!folder) return false;
    try {
        return await Native.fileExists(folder, fileName);
    } catch {
        return false;
    }
}

async function processCandidate(
    candidate: UrlCandidate,
    fallbackName: string,
    username: string,
    messageId: string,
): Promise<{ saved: boolean; reason?: string; }> {
    if (candidate.type === "external" && !settings.store.exportExternalMedia) {
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
        await saveFile(media.bytes, fileName);
        return { saved: true };
    } catch (error) {
        return { saved: false, reason: `save failed: ${String(error)}` };
    }
}

// ─── REST helpers ────────────────────────────────────────────────────────────

async function fetchAllDmChannels(): Promise<any[]> {
    try {
        const response = await RestAPI.get({ url: "/users/@me/channels" });
        return Array.isArray(response.body) ? response.body : [];
    } catch (error) {
        log.warn("failed to fetch /users/@me/channels:", error);
        return [];
    }
}

function dmRecipientId(channel: any): string | undefined {
    if (channel.type !== 1 /* DM */) return undefined;
    const id = channel.recipient_ids?.[0] ?? channel.recipients?.[0]?.id;
    return id ? String(id) : undefined;
}

async function resolveDmChannelId(userId: string): Promise<string | undefined> {
    const storeChannelId = ChannelStore.getDMFromUserId(userId);
    if (storeChannelId) return storeChannelId;

    const channels = await fetchAllDmChannels();
    return channels.find(ch => dmRecipientId(ch) === userId)?.id;
}

async function fetchMessages(channelId: string): Promise<MessageJSON[]> {
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

            if (settings.store.maxImages > 0 && results.length >= settings.store.maxImages * 3) break;
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

interface ExportResult {
    foundImages: number;
    savedImages: number;
}

async function exportAllDmMedia(specificUserId?: string): Promise<ExportResult> {
    const channels = await fetchAllDmChannels();
    const perUser = new Map<string, string>(); // userId -> channelId
    for (const ch of channels) {
        const uid = dmRecipientId(ch);
        if (uid && ch.id) perUser.set(uid, ch.id);
    }
    // Merge in whatever the local store knows
    for (const uid of ChannelStore.getDMUserIds() ?? []) {
        if (!perUser.has(uid)) {
            const chId = ChannelStore.getDMFromUserId(uid);
            if (chId) perUser.set(uid, chId);
        }
    }

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
        const messages = await fetchMessages(channelId);
        if (!messages.length) {
            log.info(`no messages for ${username}`);
            continue;
        }

        for (const message of messages) {
            for (const candidate of getCandidates(message)) {
                if (seenUrls.has(candidate.url)) continue;
                seenUrls.add(candidate.url);
                found++;

                if (settings.store.maxImages > 0 && saved >= settings.store.maxImages) {
                    skipped.push({ url: candidate.url, type: candidate.type, reason: "maxImages limit reached", user: username, messageId: message.id });
                    continue;
                }

                const fallbackName = candidate.filename ?? "attachment";
                const previewName = `${username}_${message.id}_${getFileName(candidate.url, fallbackName)}`;
                if (await fileExists(previewName)) {
                    saved++;
                    continue;
                }

                const result = await processCandidate(candidate, fallbackName, username, message.id);
                if (result.saved) {
                    saved++;
                    if (saved % 10 === 0) toast(`saved ${saved} files`);
                } else {
                    skipped.push({ url: candidate.url, type: candidate.type, reason: result.reason ?? "failed", user: username, messageId: message.id });
                }
            }
        }
    }

    if (skipped.length) {
        try {
            await saveFile(new TextEncoder().encode(formatSkippedMediaReport(skipped)), `dmarchiver_skipped_${Date.now()}.txt`);
            toast(`saved skipped-media report (${skipped.length} entries)`);
        } catch (error) {
            log.warn("failed to save skipped media report:", error);
        }
    }

    log.info(`export complete: found ${found}, saved ${saved}`);
    return { foundImages: found, savedImages: saved };
}

function formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? timestamp : date.toLocaleString();
}

async function saveDmAsText(channelId: string, userId: string): Promise<number> {
    const username = UserStore.getUser(userId)?.username ?? userId;
    const messages = await fetchMessages(channelId);

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
    await saveFile(bytes, sanitizeFileName(`dm_${username}_${Date.now()}.txt`) + ".txt");
    return bytes.length;
}

async function saveAllDmsAsText(): Promise<{ savedFiles: number; total: number; }> {
    const channels = await fetchAllDmChannels();
    const perUser = new Map<string, string>();
    for (const ch of channels) {
        const uid = dmRecipientId(ch);
        if (uid && ch.id) perUser.set(uid, ch.id);
    }
    for (const uid of ChannelStore.getDMUserIds() ?? []) {
        if (!perUser.has(uid)) {
            const chId = ChannelStore.getDMFromUserId(uid);
            if (chId) perUser.set(uid, chId);
        }
    }

    if (!perUser.size) throw new Error("No DM users found. Make sure your DM list is loaded.");

    let savedFiles = 0;
    for (const [userId, channelId] of perUser) {
        try {
            await saveDmAsText(channelId, userId);
            savedFiles++;
        } catch (error) {
            log.warn(`failed to save DM text for ${userId}:`, error);
        }
    }
    return { savedFiles, total: perUser.size };
}

async function getNonFriendDms(): Promise<Array<{ id: string; username: string; }>> {
    const relationships = await RestAPI.get({ url: "/users/@me/relationships" });
    const friendIds = new Set<string>(
        (Array.isArray(relationships.body) ? relationships.body : [])
            .filter((r: any) => r.type === 1)
            .map((r: any) => String(r.id)),
    );

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

async function deleteUserMessages(channelId: string, batchSize = 20, delayMs = 1500): Promise<{ deleted: number; failed: number; }> {
    let deleted = 0;
    let failed = 0;

    const currentUserId = UserStore.getCurrentUser()?.id;
    const ownMessages = (await fetchMessages(channelId)).filter(msg => msg.author?.id === currentUserId);

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
    }

    return { deleted, failed };
}

// ─── Small UI helpers ────────────────────────────────────────────────────────

function toast(message: string, type = Toasts.Type.MESSAGE) {
    Toasts.show({ message, id: Toasts.genId(), type });
}

function resolveTargetUserId(args: any[]): string | undefined {
    return (findOption(args, "userId") as string | undefined)?.trim()
        || settings.store.targetUserId?.trim()
        || undefined;
}

function resolveCurrentChannelId(ctx?: { channel?: { id: string; } }): string | undefined {
    return ctx?.channel?.id || SelectedChannelStore?.getLastSelectedChannelId?.();
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "DMArchiver",
    description: "Export and preserve DM content (media + text history), find everyone you've ever DM'd, optional self-deletion of your own messages.",
    authors: [{ name: "redbelter", id: 0n /* replace with your Discord snowflake */ }],
    tags: ["Utility", "Privacy"],
    settings,

    start() {
        applyQuestHiding(settings.store.hideQuestStuff);
        log.info("started — /export-dm-media, /save-dm-text, /list-dm-users ready");
        toast("DMArchiver loaded: /list-dm-users to begin");
        if (settings.store.showDeleteOption) {
            toast("DMArchiver: delete commands ENABLED (use with caution)");
        }
    },

    stop() {
        applyQuestHiding(false);
        log.info("stopped");
    },

    commands: [
        {
            name: "list-dm-users",
            description: "List all DM users available for export (username + ID).",
            execute: async () => {
                const perUser = new Map<string, string>();
                for (const ch of await fetchAllDmChannels()) {
                    const uid = dmRecipientId(ch);
                    if (uid) perUser.set(uid, ch.id);
                }
                for (const uid of ChannelStore.getDMUserIds() ?? []) {
                    if (!perUser.has(uid)) {
                        const chId = ChannelStore.getDMFromUserId(uid);
                        if (chId) perUser.set(uid, chId);
                    }
                }

                if (!perUser.size) return { content: "No DM users found." };

                const lines = [...perUser.keys()].map((id, i) => {
                    const u = UserStore.getUser(id);
                    return `${i + 1}. ${u?.username ?? "Unknown"} (${id})`;
                });
                return { content: `**DM Users (${perUser.size}):**\n${lines.join("\n")}` };
            },
        },
        {
            name: "export-dm-media",
            description: "Download all media from DMs to disk.",
            options: [{
                name: "userId",
                description: "Export only this user's DM media. Blank = all DMs.",
                type: ApplicationCommandOptionType.STRING,
                required: false,
            }],
            execute: async args => {
                const userId = resolveTargetUserId(args);
                try {
                    toast(userId ? `exporting media for ${userId}…` : "exporting media for ALL DMs…");
                    const { foundImages, savedImages } = await exportAllDmMedia(userId);
                    const msg = `DMArchiver: found ${foundImages}, saved ${savedImages}${settings.store.exportExternalMedia ? " (external included)" : ""}`;
                    toast(msg, Toasts.Type.SUCCESS);
                    return { content: msg };
                } catch (error) {
                    const msg = `DMArchiver export failed: ${String(error)}`;
                    log.error(msg, error);
                    toast(msg, Toasts.Type.FAILURE);
                    return { content: msg };
                }
            },
        },
        {
            name: "save-dm-text",
            description: "Save DM history to a text file (current conversation or all).",
            options: [{
                name: "userId",
                description: "Save only this user's DM. Blank = current conversation if in one, else all.",
                type: ApplicationCommandOptionType.STRING,
                required: false,
            }],
            execute: async (args, ctx) => {
                try {
                    const userId = resolveTargetUserId(args);
                    if (userId) {
                        const channelId = await resolveDmChannelId(userId);
                        if (!channelId) return { content: `No DM channel found for ${userId}` };
                        toast("saving DM conversation…");
                        const bytes = await saveDmAsText(channelId, userId);
                        const msg = `✅ Saved ${bytes} bytes`;
                        toast(msg, Toasts.Type.SUCCESS);
                        return { content: msg };
                    }

                    // No userId: try the current channel first, else everything
                    const currentChannelId = resolveCurrentChannelId(ctx);
                    if (currentChannelId) {
                        const currentChannel = ChannelStore.getChannel(currentChannelId);
                        const recipientId = dmRecipientId(currentChannel);
                        if (recipientId) {
                            toast("saving current conversation…");
                            const bytes = await saveDmAsText(currentChannelId, recipientId);
                            const msg = `✅ Saved ${bytes} bytes`;
                            toast(msg, Toasts.Type.SUCCESS);
                            return { content: msg };
                        }
                    }

                    toast("exporting ALL DM conversations…");
                    const { savedFiles, total } = await saveAllDmsAsText();
                    const msg = `✅ Saved ${savedFiles}/${total} conversations`;
                    toast(msg, Toasts.Type.SUCCESS);
                    return { content: msg };
                } catch (error) {
                    const msg = `Save failed: ${String(error)}`;
                    log.error(msg, error);
                    toast(msg, Toasts.Type.FAILURE);
                    return { content: msg };
                }
            },
        },
        {
            name: "list-non-friends",
            description: "List DM users you are not friends with.",
            execute: async () => {
                const nonFriends = await getNonFriendDms();
                if (!nonFriends.length) return { content: "You are friends with everyone you've DM'd! 🎉" };
                const lines = nonFriends.map((u, i) => `${i + 1}. ${u.username} (${u.id})`);
                return { content: `**Non-Friend DM Users (${nonFriends.length}):**\n${lines.join("\n")}` };
            },
        },
        {
            name: "toggle-delete-commands",
            description: "Enable/disable the DMArchiver deletion commands.",
            execute: () => {
                settings.store.showDeleteOption = !settings.store.showDeleteOption;
                const status = settings.store.showDeleteOption ? "enabled" : "disabled";
                toast(`delete commands ${status}`);
                return { content: `✅ Delete commands ${status}` };
            },
        },
        {
            name: "delete-dm-messages",
            description: "Delete YOUR OWN messages in a DM (requires showDeleteOption).",
            options: [{
                name: "userId",
                description: "User ID whose DM to clear. Blank = current channel.",
                type: ApplicationCommandOptionType.STRING,
                required: false,
            }],
            execute: async (args, ctx) => {
                if (!settings.store.showDeleteOption) {
                    return { content: "❌ Delete commands disabled. Enable 'showDeleteOption' in settings." };
                }

                const userId = resolveTargetUserId(args);
                let channelId: string | undefined;
                if (userId) {
                    channelId = await resolveDmChannelId(userId);
                } else {
                    channelId = resolveCurrentChannelId(ctx);
                }
                if (!channelId) return { content: "❌ Could not determine a DM channel. Pass a userId or run this inside a DM." };

                toast("deleting your own messages…");
                const { deleted, failed } = await deleteUserMessages(channelId);
                const msg = `✅ Deleted ${deleted} own messages (${failed} failed)`;
                toast(msg, Toasts.Type.SUCCESS);
                return { content: msg };
            },
        },
        {
            name: "delete-all-my-messages",
            description: "Delete ALL your own messages in the current DM (batched, rate-limited).",
            execute: async (_args, ctx) => {
                if (!settings.store.showDeleteOption) {
                    return { content: "❌ Delete commands disabled. Enable 'showDeleteOption' in settings." };
                }

                const channelId = resolveCurrentChannelId(ctx);
                if (!channelId) return { content: "❌ Run this while inside a DM channel." };

                toast("scanning for your own messages…");
                const { deleted, failed } = await deleteUserMessages(channelId);
                const msg = `✅ Deleted ${deleted} messages (${failed} failed)`;
                toast(msg, Toasts.Type.SUCCESS);
                return { content: msg };
            },
        },
    ],
});
