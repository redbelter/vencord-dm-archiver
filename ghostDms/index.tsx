/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ghostDms — a chat-bar button + /ghost-dms that lists EVERY DM you've ever
// had (including non-friend conversations Discord hides from the sidebar) and
// opens any of them with one click. Read-only: nothing is sent or deleted.

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { OpenExternalIcon } from "@components/Icons";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";

import { openGhostFinder } from "./Finder";

const log = new Logger("GhostDms");

const settings = definePluginSettings({
    showChatBarEntry: {
        type: OptionType.BOOLEAN,
        description: "Show the Ghost DMs button in the chat bar.",
        default: true,
    },
});

const GhostButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat) return null;
    if (!settings.store.showChatBarEntry) return null;

    return (
        <ChatBarButton
            tooltip="Ghost DMs — find & open hidden conversations"
            onClick={() => openGhostFinder()}
        >
            <OpenExternalIcon />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "GhostDms",
    description: "List and open every DM you've ever had — including non-friend chats Discord hides from the sidebar.",
    authors: [{ name: "redbelter", id: 0n /* replace with your Discord snowflake */ }],
    settings,
    tags: ["Utility", "Privacy"],

    start() {
        log.info("ready — /ghost-dms or the chat-bar button");
    },

    chatBarButton: {
        icon: OpenExternalIcon,
        render: GhostButton,
    },

    commands: [{
        name: "ghost-dms",
        description: "List every DM you've ever had and open hidden (non-friend) conversations",
        execute: () => {
            openGhostFinder();
        },
    }],
});
