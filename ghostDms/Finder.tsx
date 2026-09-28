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

/**
 * Every DM channel via /users/@me/channels — a superset of the sidebar.
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
    for (const ch of channels) {
        const uid = String(ch.recipient_ids?.[0] ?? ch.recipients?.[0]?.id ?? "");
        if (!uid) continue;
        const embedded = ch.recipients?.[0];
        const user = embedded ?? UserStore.getUser(uid);
        rows.push({
            channelId: String(ch.id),
            userId: uid,
            username: user?.username ?? user?.global_name ?? `user ${uid}`,
            isFriend: friendIds.has(uid),
        });
    }
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

    useEffect(() => {
        listAllDms().then(setRows).catch(() => setRows([]));
    }, []);

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
                Opening a hidden DM only shows it — nothing is sent or deleted. Close it again by
                clicking any other conversation.
            </Text>
        </div>
    );
}
