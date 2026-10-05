/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure activity-builder for the GamePresence plugin — zero Discord imports so
// it unit-tests in the harness without mocks. One place decides what the
// presence payload looks like; index.tsx only feeds it and dispatches.

import { ActivityType } from "@vencord/discord-types/enums";

export interface PresenceConfig {
    enabled: boolean;
    name: string; // the big "Playing <name>" title
    verb: string; // playing | streaming | listening | watching | competing
    details?: string; // rich line 1
    state?: string; // rich line 2
    hours?: number; // fake "elapsed" head start (0 = started now)
    button1Label?: string;
    button1Url?: string;
    button2Label?: string;
    button2Url?: string;
    party?: string; // "2 / 5" player chip, blank = none
}

const VERBS: Record<string, ActivityType> = {
    playing: ActivityType.PLAYING,
    streaming: ActivityType.STREAMING,
    listening: ActivityType.LISTENING,
    watching: ActivityType.WATCHING,
    competing: ActivityType.COMPETING,
};

export function verbToType(verb: string | undefined): ActivityType {
    return VERBS[(verb ?? "playing").toLowerCase().trim()] ?? ActivityType.PLAYING;
}

/**
 * Build the activity payload, or null when it should NOT show (disabled /
 * no name). Timestamp start is computed from a passed-in `now` so tests are
 * deterministic; the real call site passes Date.now().
 */
export function buildActivity(cfg: PresenceConfig, now: number, appId: string): Record<string, any> | null {
    if (!cfg.enabled || !cfg.name?.trim()) return null;

    const act: Record<string, any> = {
        application_id: appId,
        name: cfg.name.trim().slice(0, 128),
        type: verbToType(cfg.verb),
        created_at: now,
    };

    if (cfg.details?.trim()) act.details = cfg.details.trim().slice(0, 128);
    if (cfg.state?.trim()) act.state = cfg.state.trim().slice(0, 128);

    // elapsed timer: Discord renders "HH:MM elapsed" from start. An hours
    // head-start shifts the start backwards without lying about "now".
    const start = now - Math.max(0, Number(cfg.hours) || 0) * 3_600_000;
    act.timestamps = { start };

    const labels: string[] = [];
    const urls: string[] = [];
    const push = (label?: string, url?: string) => {
        const l = label?.trim(), u = url?.trim();
        // a button without a real http(s) url is a dead chip — skip it whole
        if (l && u && /^https?:\/\//i.test(u)) { labels.push(l.slice(0, 32)); urls.push(u); }
    };
    push(cfg.button1Label, cfg.button1Url);
    push(cfg.button2Label, cfg.button2Url);
    if (labels.length) {
        act.buttons = labels;
        act.metadata = { button_urls: urls };
    }

    // "N / M players" chip. Discord wants party.size = [current, max];
    // garbage input silently drops the chip instead of corrupting presence.
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec((cfg.party ?? "").trim());
    if (m) {
        const cur = parseInt(m[1], 10), max = parseInt(m[2], 10);
        if (max >= 1 && cur >= 0 && cur <= max) act.party = { size: [cur, max] };
    }

    // STREAMING shows a twitch-style link when a url is present
    if (act.type === ActivityType.STREAMING && urls.length) act.url = urls[0];

    return act;
}

/** Parse "2 / 5" style input leniently for the /playing party option. */
export function parseParty(input: string | undefined): string {
    return (input ?? "").trim();
}
