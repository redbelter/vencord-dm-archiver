/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// DmLedger — a client-side roster that outlives Discord's ~100-DM window.
// Discord's live API only ever shows ~100 recent DM channels, and "recent" is
// sticky (chatty channels never page out), so anything you haven't touched in
// a while is invisible to the plugins that enumerate it. This plugin records
// every DM partner + display name it ever gets a chance to see, into Vencord's
// DataStore (IndexedDB), and offers that roster to the other userplugins:
//
//   GhostDms    → restore/find partners no live list shows anymore
//   DMArchiver  → export DMs whose channel left the enumeration window
//   MsgPurge    → target DMs the deleter otherwise couldn't discover
//   itself      → passively captures every DM you actually send in
//
// Read-only by nature: it never sends, deletes, or restores anything.

import { definePluginSettings } from "@api/Settings";
import { addMessagePreSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, RestAPI, UserStore } from "@webpack/common";

import { ledgerDmCount, ledgerNameCount, ledgerReady, recordDm, recordName } from "./ledger";

const log = new Logger("DmLedger");

const settings = definePluginSettings({
    captureOnStart: {
        type: OptionType.BOOLEAN,
        description: "Sweep the live DM list + user cache once at startup (one REST call).",
        default: true,
    },
});

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
// (Vencord's pre-send payload carries message.recipient = the DM partner;
// falling back to nothing rather than guessing is deliberate — bookkeeping
// must never mis-attribute.)
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

export default definePlugin({
    name: "DmLedger",
    description: "Permanently remembers every DM partner and display name this client has seen (client-side IndexedDB), so GhostDms / DMArchiver / MsgPurge can reach DMs Discord's ~100-recent window hides.",
    authors: [{ name: "redbelter", id: 0n /* replace with your Discord snowflake */ }],
    settings,
    tags: ["Utility", "Privacy"],

    async start() {
        await ledgerReady();
        addMessagePreSendListener(onSend);
        if (settings.store.captureOnStart) sweepLive().catch(() => undefined);
        log.info(`ready — ledger holds ${ledgerDmCount()} partner(s), ${ledgerNameCount()} name(s)`);
    },

    stop() {
        removeMessagePreSendListener(onSend);
    },
});
