/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { ApplicationCommandOptionType, findOption } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { FolderIcon } from "@components/Icons";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, SelectedChannelStore, Toasts, UserStore } from "@webpack/common";

import {
    applyQuestHiding,
    type ArchiverSettings,
    collectDmUserChannels,
    deleteUserMessages,
    dmRecipientId,
    exportAllDmMedia,
    getNonFriendDms,
    resolveDmChannelId,
    saveAllDmsAsText,
    saveDmAsText,
} from "./core";
import { openArchiveDashboard } from "./Dashboard";

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
        description: "Unlocks the message-deletion commands and per-row delete buttons. Use responsibly — only your own messages are ever deleted.",
        default: false,
    },
    showChatBarEntry: {
        type: OptionType.BOOLEAN,
        description: "Show the DMArchiver button in the chat bar (DM channels only).",
        default: true,
    },
});

function engineSettings(): ArchiverSettings {
    return {
        downloadFolder: settings.store.downloadFolder,
        includeLinkImages: settings.store.includeLinkImages,
        exportExternalMedia: settings.store.exportExternalMedia,
        maxImages: settings.store.maxImages,
    };
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

// ─── Chat bar button ─────────────────────────────────────────────────────────

const ArchiveButton: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    // DM (1) and group DM (3) only — this tool has no business in guild channels
    if (!isMainChat || !channel || (channel.type !== 1 && channel.type !== 3)) return null;
    if (!settings.store.showChatBarEntry) return null;

    return (
        <ChatBarButton
            tooltip="DMArchiver — export this DM"
            onClick={() => openArchiveDashboard(engineSettings(), settings.store.showDeleteOption)}
        >
            <FolderIcon />
        </ChatBarButton>
    );
};

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "DMArchiver",
    description: "Export and preserve DM content (media + text history), find everyone you've ever DM'd, optional self-deletion. Opens a full archive dashboard.",
    authors: [{ name: "redbelter", id: 0n /* replace with your Discord snowflake */ }],
    tags: ["Utility", "Privacy"],
    settings,

    start() {
        applyQuestHiding(settings.store.hideQuestStuff);
        log.info("started — /dm-dashboard, /export-dm-media, /save-dm-text, /list-dm-users ready");
        toast("DMArchiver loaded: /dm-dashboard or the folder button in DM chats");
        if (settings.store.showDeleteOption) {
            toast("DMArchiver: delete commands ENABLED (use with caution)");
        }
    },

    stop() {
        applyQuestHiding(false);
        log.info("stopped");
    },

    chatBarButton: {
        icon: FolderIcon,
        render: ArchiveButton,
    },

    commands: [
        {
            name: "dm-dashboard",
            description: "Open the DMArchiver dashboard (select DMs, export media/transcripts, audit).",
            execute: () => {
                openArchiveDashboard(engineSettings(), settings.store.showDeleteOption);
                return { content: "Opened DMArchiver dashboard." };
            },
        },
        {
            name: "list-dm-users",
            description: "List all DM users available for export (username + ID).",
            execute: async () => {
                const perUser = await collectDmUserChannels();
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
                    const { foundImages, savedImages } = await exportAllDmMedia(engineSettings(), userId, toast);
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
