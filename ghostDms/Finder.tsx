/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The finder modal: every DM channel you've ever had, including the ones
// Discord's sidebar hides (non-friends, long-inactive, deactivated accounts).

import { Button } from "@components/Button";
import {
    ChannelRouter,
    ChannelStore,
    Checkbox,
    Modal,
    openModal,
    RestAPI,
    Text,
    TextInput,
    Toasts,
    useEffect,
    UserStore,
    useState,
} from "@webpack/common";
import type { CSSProperties } from "react";

export interface GhostDmRow {
    channelId: string;
    userId: string;
    username: string;
    isFriend: boolean;
}

/** Account creation date from a snowflake id (Discord epoch 2015-01-01). */
export function snowflakeDate(id: string): string | null {
    try {
        const ms = (BigInt(id) >> 22n) + 1420070400000n;
        const d = new Date(Number(ms));
        if (isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 10);
    } catch { return null; }
}

const SNOWFLAKE_RE = /^\d{15,20}$/;

/**
 * Ask Discord for the DM channel with this user. If one already exists
 * (including DMs hidden from /users/@me/channels), Discord returns THAT
 * channel with its history intact. If none exists it creates an empty one.
 * Returns { channelId, created } — created=true means a brand-new empty DM.
 */
export async function resolveDmByUserId(userId: string): Promise<string> {
    const res: any = await RestAPI.post({ url: "/users/@me/channels", body: { recipient_id: userId } });
    // real RestAPI resolves with the bare channel body; some shapes nest it
    const ch = res?.id ? res : res?.body;
    if (!ch?.id) throw new Error("Discord did not return a DM channel");
    return String(ch.id);
}

/**
 * Every DM channel via /users/@me/channels — a superset of the sidebar —
 * unioned with whatever the local ChannelStore cache knows about.
 * Names come from the recipient object embedded in the channel payload first
 * (authoritative for unfriended / deleted accounts missing from UserStore).
 */
export async function listAllDms(): Promise<GhostDmRow[]> {
    const chRes: any = await RestAPI.get({ url: "/users/@me/channels" });
    const channels: any[] = Array.isArray(chRes?.body) ? chRes.body.filter(c => c?.type === 1) : [];

    let friendIds = new Set<string>();
    try {
        const relRes: any = await RestAPI.get({ url: "/users/@me/relationships" });
        friendIds = new Set<string>(
            (Array.isArray(relRes?.body) ? relRes.body : [])
                .filter((r: any) => r.type === 1)
                .map((r: any) => String(r.id)),
        );
    } catch { /* relationships unavailable — everything shows as "not friends" */ }

    const rows: GhostDmRow[] = [];
    const seen = new Set<string>();
    const push = (channelId: string, uid: string, embedded?: any) => {
        if (!channelId || !uid || seen.has(channelId)) return;
        seen.add(channelId);
        const user = embedded ?? UserStore.getUser(uid);
        rows.push({
            channelId,
            userId: uid,
            username: user?.username ?? user?.global_name ?? `user ${uid}`,
            isFriend: friendIds.has(uid),
        });
    };
    for (const ch of channels) {
        push(String(ch.id), String(ch.recipient_ids?.[0] ?? ch.recipients?.[0]?.id ?? ""), ch.recipients?.[0]);
    }
    // the local store cache sometimes knows DM channels the REST list omits
    try {
        for (const uid of ChannelStore.getDMUserIds() ?? []) {
            const chId = ChannelStore.getDMFromUserId(String(uid));
            if (chId) push(String(chId), String(uid));
        }
    } catch { /* store unavailable */ }
    rows.sort((a, b) => Number(a.isFriend) - Number(b.isFriend) || a.username.localeCompare(b.username));
    return rows;
}

export function openGhostFinder() {
    openModal(modalProps => (
        <Modal
            {...modalProps}
            size="md"
            title="Ghost DMs"
            subtitle="Every private conversation you've ever had — open the ones Discord hides"
        >
            <Finder onClose={modalProps.onClose} />
        </Modal>
    ));
}

const panelStyle: CSSProperties = {
    padding: 12,
    borderRadius: 8,
    border: "1px solid var(--border-subtle, #333)",
};

function Finder({ onClose }: { onClose(): void; }) {
    const [rows, setRows] = useState<GhostDmRow[] | null>(null);
    const [search, setSearch] = useState("");
    const [nonFriendsOnly, setNonFriendsOnly] = useState(false);
    const [userId, setUserId] = useState("");
    const [lookupBusy, setLookupBusy] = useState(false);
    const [lookupError, setLookupError] = useState("");

    useEffect(() => {
        listAllDms().then(setRows).catch(() => setRows([]));
    }, []);

    // Open a DM by snowflake ID — works even when the channel is missing from
    // the DM list entirely. Discord's create-or-get returns the EXISTING
    // channel (with history) if there was ever a DM; only a never-DM'd user
    // produces a new empty channel, so we ask before touching the API.
    const lookupById = async () => {
        const id = userId.trim();
        if (!SNOWFLAKE_RE.test(id)) {
            setLookupError("That doesn't look like a Discord user ID (15-20 digits).");
            return;
        }
        setLookupError("");
        setLookupBusy(true);
        try {
            const channelId = await resolveDmByUserId(id);
            ChannelRouter?.transitionToChannel?.(channelId);
            onClose();
        } catch (error: any) {
            setLookupError(
                error?.status === 404 || error?.status === 400 || error?.status === 403
                    ? "Discord refused that user — the account may be deleted, blocked, or the ID is wrong."
                    : `Lookup failed: ${String(error?.message ?? error)}`,
            );
        } finally {
            setLookupBusy(false);
        }
    };

    const openDm = (row: GhostDmRow) => {
        // the channel exists even when the sidebar hides it — jump straight to it
        try {
            ChannelRouter?.transitionToChannel?.(row.channelId);
            onClose();
        } catch {
            Toasts.show({ message: "Could not open that DM.", id: Toasts.genId(), type: Toasts.Type.FAILURE });
        }
    };

    const visible = (rows ?? []).filter(r =>
        (!nonFriendsOnly || !r.isFriend)
        && (!search || r.username.toLowerCase().includes(search.toLowerCase()) || r.userId.includes(search)));
    const hiddenCount = (rows ?? []).filter(r => !r.isFriend).length;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Text variant="text-sm/normal">
                {rows === null
                    ? "loading your DM list…"
                    : `${rows.length} conversation${rows.length === 1 ? "" : "s"} · ${hiddenCount} hidden from your sidebar (not friends)`}
            </Text>

            <div>
                <TextInput
                    placeholder="Search by name…"
                    value={search}
                    onChange={(v: string) => setSearch(v)}
                />
            </div>
            <div>
                <Checkbox value={nonFriendsOnly} onChange={(_, v: boolean) => setNonFriendsOnly(v)}>
                    <Text variant="text-sm/normal">Only show hidden (non-friend) DMs</Text>
                </Checkbox>
            </div>

            <div style={panelStyle}>
                <Text variant="text-xs/bold">NOT IN THE LIST? OPEN BY USER ID</Text>
                <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <div style={{ flex: 1 }}>
                        <TextInput
                            placeholder="User ID (snowflake), e.g. 183740859087306753"
                            value={userId}
                            onChange={(v: string) => setUserId(v)}
                        />
                    </div>
                    <Button
                        variant="primary"
                        size="xs"
                        disabled={lookupBusy || !userId.trim()}
                        onClick={() => lookupById()}
                    >
                        {lookupBusy ? "opening…" : "Open DM"}
                    </Button>
                </div>
                {SNOWFLAKE_RE.test(userId.trim()) && snowflakeDate(userId.trim()) ? (
                    <div style={{ marginTop: 4 }}>
                        <Text variant="text-xs/normal">account created {snowflakeDate(userId.trim())}</Text>
                    </div>
                ) : null}
                {lookupError ? (
                    <div style={{ marginTop: 4 }}>
                        <Text variant="text-xs/normal">{lookupError}</Text>
                    </div>
                ) : null}
            </div>

            <div style={{ ...panelStyle, maxHeight: "50vh", overflowY: "auto", padding: 4 }}>
                {rows !== null && !visible.length ? (
                    <div style={{ padding: 12, opacity: 0.7 }}>No DMs match this filter.</div>
                ) : null}
                {visible.map(row => (
                    <div key={row.channelId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px" }}>
                        <span style={{ flex: 1 }}>{row.username}</span>
                        <Text variant="text-xs/normal" style={{ opacity: 0.6 }}>
                            {row.isFriend ? "friend" : "not friends"}
                        </Text>
                        <span style={{ opacity: 0.4, fontSize: 11 }}>{row.userId}</span>
                        <Button variant="secondary" size="xs" onClick={() => openDm(row)}>
                            Open
                        </Button>
                    </div>
                ))}
            </div>

            <Text variant="text-xs/normal">
                Opening a listed DM only navigates — nothing is sent or deleted. ID lookup asks
                Discord for the DM channel: if you ever DM'd that user your history comes back,
                otherwise you just get an empty DM nobody else can see. Leave by clicking any
                other conversation.
            </Text>
        </div>
    );
}
