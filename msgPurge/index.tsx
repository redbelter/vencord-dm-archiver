/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// msgPurge — rate-limited, resumable deletion of YOUR OWN messages.
// Designed for long runs (hours): built-in rate control, pause/resume,
// live status modal, and a persisted queue that survives restarts.

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { ApplicationCommandOptionType, findOption } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { DeleteIcon } from "@components/Icons";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { SelectedChannelStore, Toasts } from "@webpack/common";

import { PurgeEngine, type PurgeScope,setChannelIdProvider } from "./engine";
import { openPurgeControl } from "./UI";

const log = new Logger("MsgPurge");

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Master switch — turning this off disables the plugin (an in-progress purge is paused and its queue saved).",
        default: false,
    },
    ratePerMinute: {
        type: OptionType.NUMBER,
        description: "Max deletions per minute (1-30). Lower = safer for hours-long runs.",
        default: 15,
        restartNeeded: false,
    },
    maxRetries: {
        type: OptionType.NUMBER,
        description: "Delete attempts per message before giving up (1-5).",
        default: 3,
    },
    resumeAfterRestart: {
        type: OptionType.BOOLEAN,
        description: "After Discord restarts, offer to resume an unfinished purge queue.",
        default: true,
    },
    defaultScope: {
        type: OptionType.SELECT,
        description: "Default scope pre-selected in the control panel.",
        options: [
            { label: "All messages", value: "all", default: true },
            { label: "Only media (attachments)", value: "media" },
        ],
    },
    showChatBarEntry: {
        type: OptionType.BOOLEAN,
        description: "Show the msgPurge button in the chat bar.",
        default: true,
    },
    // persisted engine state (written by the engine, not user-edited)
    savedStatus: {
        type: OptionType.STRING,
        description: "internal — persisted purge progress",
        default: "",
        hidden: () => true,
    },
});

function engineSettings() {
    return {
        enabled: settings.store.enabled,
        ratePerMinute: settings.store.ratePerMinute,
        maxRetries: settings.store.maxRetries,
        resumeAfterRestart: settings.store.resumeAfterRestart,
    };
}

/**
 * Resolve the channel the user is looking at. The real store returns "-1"
 * (string) when nothing is selected — that must never be treated as a target.
 */
function resolveCurrentChannelId(ctxChannelId?: string | number): string | undefined {
    const selected = SelectedChannelStore?.getCurrentlySelectedChannelId?.();
    const candidates = [
        ctxChannelId,
        (selected as any)?.channelId,
        SelectedChannelStore?.getChannelId?.(null),
        SelectedChannelStore?.getLastSelectedChannelId?.(),
    ];
    for (const c of candidates) {
        const s = c == null ? "" : String(c);
        if (s && s !== "-1" && s !== "undefined") return s;
    }
    return undefined;
}

function toast(message: string, type = Toasts.Type.MESSAGE) {
    Toasts.show({ message, id: Toasts.genId(), type });
}

// ─── persisted progress ──────────────────────────────────────────────────────

interface SavedState {
    pending?: Record<string, string[]>;
    deleted?: number;
    failed?: number;
    scope?: PurgeScope;
}

function loadSaved(): SavedState | null {
    const raw = settings.store.savedStatus;
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as SavedState;
        return parsed?.pending && Object.keys(parsed.pending).length ? parsed : null;
    } catch {
        return null;
    }
}

function saveState(snapshot: Partial<PurgeStatusLite> & { pending?: Record<string, string[]>; }) {
    const pending = snapshot.pending ?? {};
    const hasWork = Object.keys(pending).length > 0;
    // settings.store is a read/write Proxy — assignment persists (same pattern
    // core plugins use, e.g. ignoreActivities writing settings.store.idsList).
    settings.store.savedStatus = hasWork ? JSON.stringify({
        pending,
        deleted: snapshot.deleted ?? 0,
        failed: snapshot.failed ?? 0,
        scope: snapshot.scope ?? "all",
    }) : "";
}

type PurgeStatusLite = import("./engine").PurgeStatus;

// ─── engine singleton ────────────────────────────────────────────────────────

export const engine = new PurgeEngine(engineSettings, {
    save: saveState,
    notify: msg => toast(msg),
});

engine.onAfterComplete = () => {
    // run finished: if nothing is queued any more, wipe persisted state
    if (!engine.hasPending()) settings.store.savedStatus = "";
};

// ─── chat bar button ─────────────────────────────────────────────────────────

const PurgeButton: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    if (!isMainChat || !channel) return null;
    if (!settings.store.showChatBarEntry) return null;

    return (
        <ChatBarButton
            tooltip="msgPurge — delete your own messages (rate-limited)"
            onClick={() => openPurgeControl(
                engine,
                settings.store.defaultScope as PurgeScope,
                resolveCurrentChannelId(channel?.id as string | undefined),
            )}
        >
            <DeleteIcon />
        </ChatBarButton>
    );
};

function countPending(s: SavedState): number {
    let n = 0;
    for (const ids of Object.values(s.pending ?? {})) n += ids.length;
    return n;
}

// ─── plugin ──────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "MsgPurge",
    description: "Rate-limited deletion of your own messages — all messages or media-only, with pause/resume, live status, and a queue that survives restarts.",
    authors: [{ name: "redbelter", id: 0n /* replace with your Discord snowflake */ }],
    tags: ["Utility", "Privacy"],
    settings,

    start() {
                // getChannelId() returns "-1" when nothing is selected (e.g. Friends
        // view); null guildId so it returns the active DM channel too
        setChannelIdProvider(() => resolveCurrentChannelId());
        if (!settings.store.enabled) {
            log.info("installed but disabled — enable 'Master switch' in settings to use");
            return;
        }
        const saved = settings.store.resumeAfterRestart ? loadSaved() : null;
        if (saved) {
            engine.hydrate(saved.pending, saved.scope);
            engine.setSavedScope(saved.scope ?? "all");
            toast(`msgPurge: ${countPending(saved)} queued deletion(s) from a previous run — open /msgpurge to resume or discard`);
        }
        log.info(`started — /msgpurge ready (${settings.store.ratePerMinute}/min)`);
        toast("MsgPurge loaded: /msgpurge or the trash button in the chat bar");
    },

    stop() {
        if (engine.isRunning) {
            engine.pause();
            engine.cancel();
            log.info("stopped mid-run — queue saved");
        }
        setChannelIdProvider(() => undefined);
    },

    chatBarButton: {
        icon: DeleteIcon,
        render: PurgeButton,
    },

    commands: [{
        name: "msgpurge",
        description: "Open the msgPurge control panel (rate-limited self-deletion)",
        options: [
            {
                name: "scope",
                description: "Delete all your messages or only ones with media",
                type: ApplicationCommandOptionType.STRING,
                required: false,
                choices: [
                    { name: "all", label: "All messages", value: "all" },
                    { name: "media", label: "Only media", value: "media" },
                ],
            },
        ],
        execute: (args, ctx) => {
            if (!settings.store.enabled) {
                toast("MsgPurge is disabled — enable it in Settings → Plugins → MsgPurge.", Toasts.Type.FAILURE);
                return;
            }
            const scopeArg = (findOption(args, "scope") as string | undefined)?.trim();
            const scope: PurgeScope = scopeArg === "media" ? "media" : scopeArg === "all" ? "all" : settings.store.defaultScope as PurgeScope;
            openPurgeControl(engine, scope, resolveCurrentChannelId(ctx.channel?.id as string | undefined));
        },
    }, {
        name: "msgpurge-here",
        description: "Immediately purge your messages in THIS channel at the configured rate (all messages)",
        execute: (_args, ctx) => {
            if (!settings.store.enabled) {
                toast("MsgPurge is disabled — enable it in Settings → Plugins → MsgPurge.", Toasts.Type.FAILURE);
                return;
            }
            const channelId = resolveCurrentChannelId(ctx.channel?.id as string | undefined);
            if (!channelId) {
                toast("Could not resolve the current channel.", Toasts.Type.FAILURE);
                return;
            }
            engine.start({
                scope: "all",
                includeCurrentChannel: true,
                includeDms: false,
                friendsOnly: false,
                currentChannelId: channelId,
            });
            toast(`Purging your messages in this channel at ${settings.store.ratePerMinute}/min — /msgpurge to watch or pause`);
        },
    }],
});
