/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// DmLedger — the permanent DM roster + everything that grew around it.
// Discord's live API only ever shows ~100 recent DM channels, and "recent" is
// sticky (chatty channels never page out), so anything you haven't touched in
// a while is invisible to every DM tool. This plugin:
//
//   ledger      → records every DM partner + display name it ever gets a
//                 chance to see into Vencord's DataStore (IndexedDB); MsgPurge
//                 and its own browser read that roster
//   browser     → /dm-ledger floating window: search/filter everyone, open,
//                 restore, forget, import your data package, deep server-roster
//                 search (absorbed from the retired GhostDms)
//   archiver    → /dm-dashboard + export/save commands + opt-in self-delete
//                 (absorbed from the retired DMArchiver, settings auto-migrate)
//   capture     → passively records every DM you actually send in
//
// It only mutates Discord state when you explicitly click (restore/open) or
// run an export/delete command you enabled yourself.

import { addChatBarButton, ChatBarButton, ChatBarButtonFactory, removeChatBarButton } from "@api/ChatButtons";
import { ApplicationCommandOptionType, findOption } from "@api/Commands";
import { addMessagePreSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { definePluginSettings, SettingsStore } from "@api/Settings";
import { FolderIcon, SearchIcon } from "@components/Icons";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, RestAPI, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

import { applyQuestHiding, type ArchiverSettings, collectDmNames, collectDmUserChannels, deleteUserMessages, dmRecipientId, exportAllDmMedia, getNonFriendDms, resolveDmChannelId, saveAllDmsAsText, saveDmAsText } from "./archiveCore";
import { closeArchiveDashboard, openArchiveDashboard } from "./ArchiveDashboard";
import { openLedgerBrowser } from "./Browser";
import { closeFloating } from "./floating";
import { ledgerDmCount, ledgerNameCount, ledgerReady, recordDm, recordName } from "./ledger";

const log = new Logger("DmLedger");

const settings = definePluginSettings({
    showChatBarEntry: {
        type: OptionType.BOOLEAN,
        description: "Show the Ledger (🔍) button in the chat bar.",
        default: true,
    },
    showArchiveButton: {
        type: OptionType.BOOLEAN,
        description: "Show the Archive (📁) button in DM chat bars (opens the export dashboard).",
        default: true,
    },
    captureOnStart: {
        type: OptionType.BOOLEAN,
        description: "Sweep the live DM list + user cache once at startup (one REST call).",
        default: true,
    },
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
        description: "Unlocks the message-deletion commands and per-row delete buttons. Use responsibly — only your own messages are ever deleted.",
        default: false,
    },
});

// One-time, key-by-key migration from the retired DMArchiver plugin's
// settings namespace (Vencord's migratePluginSettings can't help: DmLedger
// already exists, and showChatBarEntry means different things to each).
function migrateArchiverSettings() {
    try {
        const { plugins } = SettingsStore.plain;
        const oldCfg = plugins?.DMArchiver;
        if (!oldCfg) return;
        // If we're running, the plugin is enabled — a fresh entry must say so
        // or saving plain settings would look like a disable.
        const mine: Record<string, any> = (plugins.DmLedger ??= { enabled: true });
        let moved = 0;
        for (const key of ["downloadFolder", "targetUserId", "includeLinkImages", "exportExternalMedia", "maxImages", "hideQuestStuff", "showDeleteOption"]) {
            if (key in oldCfg && !(key in mine)) { mine[key] = oldCfg[key]; moved++; }
        }
        if ("showChatBarEntry" in oldCfg && !("showArchiveButton" in mine)) { mine.showArchiveButton = oldCfg.showChatBarEntry; moved++; }
        delete plugins.DMArchiver;
        if (moved) {
            SettingsStore.markAsChanged();
            log.info(`migrated ${moved} setting(s) from the old DMArchiver plugin`);
        }
    } catch { /* settings shape unexpected — defaults are safe */ }
}

function engineSettings(): ArchiverSettings {
    return {
        downloadFolder: settings.store.downloadFolder,
        includeLinkImages: settings.store.includeLinkImages,
        exportExternalMedia: settings.store.exportExternalMedia,
        maxImages: settings.store.maxImages,
    };
}

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

// ─── Ledger capture ──────────────────────────────────────────────────────────

async function sweepLive(): Promise<void> {
    let channels: any[] = [];
    try {
        const res: any = await RestAPI.get({ url: "/users/@me/channels" });
        channels = Array.isArray(res?.body) ? res.body : [];
    } catch { /* offline / rate limited — next start will catch up */ }

    let friends = new Set<string>();
    try {
        const rel: any = await RestAPI.get({ url: "/users/@me/relationships" });
        friends = new Set<string>((Array.isArray(rel?.body) ? rel.body : []).filter((r: any) => r.type === 1).map((r: any) => String(r.id)));
    } catch { /* relationship unknown — record as undefined, not false */ }

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
    }

    // names visible in the local cache are worth remembering even though the
    // channel may vanish — that's what stops a future name sweep re-asking
    try {
        for (const uid of ChannelStore.getDMUserIds() ?? []) {
            const u: any = UserStore.getUser(String(uid));
            if (u?.id) recordName({ userId: String(u.id), username: u.username, globalName: u.globalName ?? u.global_name });
        }
    } catch { /* cache unavailable */ }
}

// Every DM you send in is recorded the moment you send it — a brand-new
// partner is in the ledger before Discord ever lists the channel anywhere.
const onSend = (channelId: string, messageObj: any) => {
    try {
        if (!channelId) return;
        let uid = "";
        let username: string | undefined;
        const rec: any = messageObj?.recipient;
        if (rec?.id != null) {
            uid = String(rec.id);
            username = rec?.global_name ?? rec?.username;
        } else {
            // payload without a recipient object — the DM channel itself knows
            const ch: any = ChannelStore.getChannel?.(String(channelId));
            if (!ch || ch.type !== 1) return;
            const r: any = ch.recipients?.[0];
            uid = String(r?.id ?? ch.recipient_ids?.[0] ?? "");
            username = r?.global_name ?? r?.username;
        }
        if (!uid) return;
        recordDm({ userId: uid, channelId: String(channelId), username, source: "sent" });
        if (username) recordName({ userId: uid, username, globalName: username });
    } catch { /* never break someone's message send over bookkeeping */ }
};

// ─── Chat bar buttons (two entries: roster 🔍 + archive 📁) ─────────────────

const LedgerButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat || !settings.store.showChatBarEntry) return null;
    return (
        <ChatBarButton
            tooltip="DmLedger — everyone you've ever DM'd (even beyond Discord's list)"
            onClick={() => openLedgerBrowser()}
        >
            <SearchIcon />
        </ChatBarButton>
    );
};

const ArchiveButton: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    // DM (1) and group DM (3) only — export has no business in guild channels
    if (!isMainChat || !channel || (channel.type !== 1 && channel.type !== 3)) return null;
    if (!settings.store.showArchiveButton) return null;
    return (
        <ChatBarButton
            tooltip="DmLedger archive — export this DM"
            onClick={() => openArchiveDashboard(engineSettings(), settings.store.showDeleteOption, String(channel.id))}
        >
            <FolderIcon />
        </ChatBarButton>
    );
};

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "DmLedger",
    description: "Permanently remembers every DM partner (client-side IndexedDB), browses/restores them beyond Discord's ~100 list, and archives DM media/text to disk. Absorbs the retired GhostDms + DMArchiver.",
    authors: [{ name: "redbelter", id: 0n /* replace with your Discord snowflake */ }],
    settings,
    tags: ["Utility", "Privacy"],

    async start() {
        migrateArchiverSettings();
        await ledgerReady();
        addMessagePreSendListener(onSend);
        addChatBarButton("dm-ledger-archive", ArchiveButton, FolderIcon);
        if (settings.store.captureOnStart) sweepLive().catch(() => undefined);
        applyQuestHiding(settings.store.hideQuestStuff);
        log.info(`ready — ledger holds ${ledgerDmCount()} partner(s), ${ledgerNameCount()} name(s)`);
        toast("DmLedger loaded: /dm-ledger (roster) · /dm-dashboard (export) · 🔍 and 📁 in DM chat bars");
        if (settings.store.showDeleteOption) {
            toast("DmLedger: delete commands ENABLED (use with caution)");
        }
    },

    stop() {
        removeMessagePreSendListener(onSend);
        removeChatBarButton("dm-ledger-archive");
        applyQuestHiding(false);
        closeFloating(); // roster browser (default key)
        closeArchiveDashboard(); // archive dashboard ("DMArchiver" key) — windows die with the plugin
    },

    chatBarButton: {
        icon: SearchIcon,
        render: LedgerButton,
    },

    commands: [
        {
            name: "dm-ledger",
            description: "Browse the permanent DM roster — everyone you've ever DM'd, beyond Discord's ~100 list",
            execute: () => {
                openLedgerBrowser();
            },
        },
        {
            name: "dm-dashboard",
            description: "Open the archive dashboard (current DM pre-selected, select more if you want).",
            execute: async (_args, ctx) => {
                const channelId = resolveCurrentChannelId(ctx);
                openArchiveDashboard(engineSettings(), settings.store.showDeleteOption, channelId);
                return { content: "Opened the archive dashboard." };
            },
        },
        {
            name: "list-dm-users",
            description: "List all DM users available for export (username + ID).",
            execute: async () => {
                const [perUser, names] = await Promise.all([collectDmUserChannels(), collectDmNames()]);
                if (!perUser.size) return { content: "No DM users found." };

                const lines = [...perUser.keys()].map((id, i) => {
                    const name = UserStore.getUser(id)?.username ?? names.get(id);
                    return `${i + 1}. ${name ?? "Unknown"} (${id})`;
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
                    const { foundImages, savedImages } = await exportAllDmMedia(engineSettings(), userId, toast);
                    const msg = `Export: found ${foundImages}, saved ${savedImages}${settings.store.exportExternalMedia ? " (external included)" : ""}`;
                    toast(msg, Toasts.Type.SUCCESS);
                    return { content: msg };
                } catch (error) {
                    const msg = `Export failed: ${String(error)}`;
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
                        const bytes = await saveDmAsText(engineSettings(), channelId, userId);
                        const msg = `✅ Saved ${bytes} bytes`;
                        toast(msg, Toasts.Type.SUCCESS);
                        return { content: msg };
                    }

                    // No userId: try the current channel first, else everything
                    const currentChannelId = resolveCurrentChannelId(ctx);
                    if (currentChannelId) {
                        const recipientId = dmRecipientId(ChannelStore.getChannel(currentChannelId));
                        if (recipientId) {
                            toast("saving current conversation…");
                            const bytes = await saveDmAsText(engineSettings(), currentChannelId, String(recipientId));
                            const msg = `✅ Saved ${bytes} bytes`;
                            toast(msg, Toasts.Type.SUCCESS);
                            return { content: msg };
                        }
                    }

                    toast("exporting ALL DM conversations…");
                    const { savedFiles, total } = await saveAllDmsAsText(engineSettings());
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
            description: "Enable/disable the DmLedger deletion commands.",
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
                const { deleted, failed } = await deleteUserMessages(channelId, 20, 1500, toast);
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
                const { deleted, failed } = await deleteUserMessages(channelId, 20, 1500, toast);
                const msg = `✅ Deleted ${deleted} messages (${failed} failed)`;
                toast(msg, Toasts.Type.SUCCESS);
                return { content: msg };
            },
        },
    ],
});
