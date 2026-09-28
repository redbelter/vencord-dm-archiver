/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Archive dashboard: searchable DM list, per-channel selection, live progress,
// media/text export, and (opt-in) own-message deletion — all in one modal.

import { Button } from "@components/Button";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { Checkbox, ConfirmModal, Modal, openModal, Text, TextInput, useEffect, UserStore,useState } from "@webpack/common";

import {
    type ArchiverSettings,
    collectDmNames,
    collectDmUserChannels,
    deleteUserMessages,
    exportForUsers,
    getFriendIds,
    saveDmAsText,
} from "./core";

const log = new Logger("DMArchiver/Dashboard");

const Native = VencordNative.pluginHelpers.DMArchiver as PluginNative<typeof import("./native")> | undefined;

interface Row {
    userId: string;
    channelId: string;
    username: string;
    isFriend: boolean;
}

export function openArchiveDashboard(initialSettings: ArchiverSettings, showDeleteOption: boolean, initialChannelId?: string) {
    openModal(modalProps => (
        <Modal
            {...modalProps}
            size="lg"
            title="DMArchiver"
            subtitle="Export DM media & transcripts, audit your DMs"
        >
            <Dashboard onClose={modalProps.onClose} initialSettings={initialSettings} showDeleteOption={showDeleteOption} initialChannelId={initialChannelId} />
        </Modal>
    ));
}

function Dashboard({ onClose, initialSettings, showDeleteOption, initialChannelId }: {
    onClose(): void;
    initialSettings: ArchiverSettings;
    showDeleteOption: boolean;
    initialChannelId?: string;
}) {
    const [rows, setRows] = useState<Row[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [filter, setFilter] = useState("");
    const [nonFriendsOnly, setNonFriendsOnly] = useState(false);
    const [busy, setBusy] = useState(true);
    const [status, setStatus] = useState("Loading DM list…");
    const [cfg, setCfg] = useState<ArchiverSettings>({ ...initialSettings });
    const [dots, setDots] = useState(0);
    // Collapsed starts false (list unknown until loaded); flipped true once the
    // current-DM channel is matched in the loaded list.
    const [collapsed, setCollapsed] = useState(false);

    useEffect(() => {
        const t = setInterval(() => setDots(d => (d + 1) % 4), 400);
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const [perUser, friendIds, names] = await Promise.all([
                    collectDmUserChannels(),
                    getFriendIds(),
                    collectDmNames(),
                ]);
                const list: Row[] = [...perUser.entries()].map(([userId, channelId]) => ({
                    userId,
                    channelId,
                    username: UserStore.getUser(userId)?.username ?? names.get(userId) ?? userId,
                    isFriend: friendIds.has(userId),
                }));
                list.sort((a, b) => a.username.localeCompare(b.username));
                setRows(list);

                // Pre-select the current DM by matching channel id against the list
                // (the chat-bar/slash-context channel object shape varies between
                // Discord builds, so match on ids we control instead).
                if (initialChannelId) {
                    const hit = list.find(r => r.channelId === initialChannelId);
                    if (hit) {
                        setSelected(new Set([hit.userId]));
                        setCollapsed(true);
                        setStatus(`${list.length} DM conversations — current DM pre-selected`);
                    } else {
                        setStatus(`${list.length} DM conversations`);
                    }
                } else {
                    setStatus(`${list.length} DM conversations`);
                }
            } catch (error) {
                log.error("failed to load DM list", error);
                setStatus(`Failed to load: ${String(error)}`);
            } finally {
                setBusy(false);
            }
        })();
    }, []);

    const matchesFilters = (r: Row) =>
        (!nonFriendsOnly || !r.isFriend)
        && (!filter || r.username.toLowerCase().includes(filter.toLowerCase()) || r.userId.includes(filter));

    // Collapsed: only selected DMs listed. Expanded: everything matching filters.
    const visible = (collapsed ? rows.filter(r => selected.has(r.userId)) : rows).filter(matchesFilters);
    const hiddenCount = rows.length - visible.length;

    const toggle = (userId: string) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(userId)) next.delete(userId);
        else next.add(userId);
        return next;
    });

    const runWithStatus = async (fn: (status: (s: string) => void) => Promise<void>) => {
        setBusy(true);
        setStatus("Working…");
        try {
            await fn(setStatus);
        } catch (error) {
            setStatus(`❌ ${String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    const selectedIds = [...selected];
    const canAct = !busy && selectedIds.length > 0;

    const exportMedia = () => runWithStatus(async report => {
        const result = await exportForUsers(
            cfg,
            selectedIds,
            m => setStatus(m),
            p => report(`${p.user}: found ${p.found}, saved ${p.saved}`),
        );
        setStatus(`✅ Media done — found ${result.foundImages}, saved ${result.savedImages}, skipped ${result.skipped.length}`);
    });

    const saveText = () => runWithStatus(async report => {
        let done = 0;
        for (const userId of selectedIds) {
            const row = rows.find(r => r.userId === userId);
            if (!row) continue;
            const bytes = await saveDmAsText(cfg, row.channelId, userId);
            done++;
            report(`saved ${done}/${selectedIds.length} transcripts (${bytes} bytes)`);
        }
        setStatus(`✅ Text done — ${done} transcripts`);
    });

    const deleteOwn = (row: Row) => {
        openModal(confirmProps => (
            <ConfirmModal
                {...confirmProps}
                title={`Delete YOUR OWN messages with ${row.username}?`}
                confirmText="Delete them"
                cancelText="Cancel"
                variant="critical-primary"
                onConfirm={() => {
                    runWithStatus(async report => {
                        report("Scanning for your own messages…");
                        const { deleted, failed } = await deleteUserMessages(row.channelId, 20, 1500, report);
                        setStatus(`✅ Deleted ${deleted} own messages (${failed} failed)`);
                    });
                }}
            >
                This permanently deletes every message YOU wrote in this DM. The other
                person's messages are never touched. This cannot be undone.
            </ConfirmModal>
        ));
    };

    const sectionLabel = (text: string) => (
        <Text variant="text-xs/bold" style={{ textTransform: "uppercase", opacity: 0.6 }}>{text}</Text>
    );

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* export target + toggles */}
            <div>
                {sectionLabel("Export destination")}
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <div style={{ flex: 1 }}>
                        <TextInput
                            value={cfg.downloadFolder}
                            onChange={(v: string) => setCfg(c => ({ ...c, downloadFolder: v }))}
                            placeholder="(empty = save dialog per file)"
                        />
                    </div>
                    <Button
                        variant="secondary"
                        disabled={busy || !Native}
                        onClick={async () => {
                            try {
                                const folder = await Native?.chooseFolder?.();
                                if (folder) setCfg(c => ({ ...c, downloadFolder: folder }));
                            } catch (error) {
                                log.warn("folder picker failed:", error);
                            }
                        }}
                    >
                        Browse…
                    </Button>
                </div>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <Checkbox
                    value={cfg.exportExternalMedia}
                    onChange={(_, v: boolean) => setCfg(c => ({ ...c, exportExternalMedia: v }))}
                    size={20}
                >
                    <Text variant="text-sm/normal">Include external links (imgur, …)</Text>
                </Checkbox>
                <Checkbox
                    value={cfg.includeLinkImages}
                    onChange={(_, v: boolean) => setCfg(c => ({ ...c, includeLinkImages: v }))}
                    size={20}
                >
                    <Text variant="text-sm/normal">Harvest image URLs from message text</Text>
                </Checkbox>
            </div>

            {/* filters / selection */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                    <TextInput
                        value={filter}
                        onChange={setFilter}
                        placeholder="Filter by name or ID…"
                    />
                </div>
                <Checkbox
                    value={nonFriendsOnly}
                    onChange={(_, v: boolean) => setNonFriendsOnly(v)}
                    size={20}
                >
                    <Text variant="text-sm/normal">Non-friends</Text>
                </Checkbox>
                <Button variant="secondary" size="xs" disabled={busy} onClick={() => setSelected(new Set(visible.map(r => r.userId)))}>
                    Select all shown
                </Button>
                <Button
                    variant="secondary"
                    size="xs"
                    disabled={busy}
                    onClick={() => setSelected(prev => new Set([...prev, ...visible.filter(r => !r.isFriend).map(r => r.userId)]))}
                >
                    + non-friends
                </Button>
                <Button variant="secondary" size="xs" disabled={busy} onClick={() => setSelected(new Set())}>
                    Clear
                </Button>
            </div>

            {/* DM list */}
            <div style={{ maxHeight: "40vh", overflowY: "auto", border: "1px solid var(--border-subtle, #333)", borderRadius: 8, padding: 4 }}>
                {busy && !rows.length && <div style={{ padding: 12, opacity: 0.7 }}>{status}</div>}
                {!collapsed && rows.length > 0 && (
                    <div style={{ display: "flex", justifyContent: "flex-end", padding: "2px 8px" }}>
                        <Button variant="link" size="xs" onClick={() => setCollapsed(true)}>
                            Collapse to selected ({selected.size})
                        </Button>
                    </div>
                )}
                {collapsed && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", opacity: 0.8 }}>
                        <Text variant="text-xs/normal">
                            Showing {visible.length} selected {hiddenCount > 0 ? `· ${hiddenCount} hidden` : ""}
                        </Text>
                        <Button variant="secondary" size="xs" disabled={busy} onClick={() => setCollapsed(false)}>
                            Show all DMs ({rows.length})
                        </Button>
                    </div>
                )}
                {visible.map(row => (
                    <div key={row.userId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px" }}>
                        <Checkbox value={selected.has(row.userId)} onChange={() => toggle(row.userId)} size={18} disabled={busy} />
                        <span style={{ flex: 1 }}>{row.username}</span>
                        {!row.isFriend && <Text variant="text-xs/normal" style={{ opacity: 0.6 }}>not friends</Text>}
                        <span style={{ opacity: 0.4, fontSize: 11 }}>{row.userId}</span>
                        {showDeleteOption && (
                            <Button variant="dangerSecondary" size="xs" disabled={busy} onClick={() => deleteOwn(row)}>
                                delete mine
                            </Button>
                        )}
                    </div>
                ))}
                {!busy && !visible.length && <div style={{ padding: 12, opacity: 0.7 }}>No DMs match this filter.</div>}
            </div>

            {/* actions */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button onClick={exportMedia} disabled={!canAct}>
                    Export media ({selectedIds.length})
                </Button>
                <Button variant="secondary" onClick={saveText} disabled={!canAct}>
                    Save transcripts ({selectedIds.length})
                </Button>
                <Button variant="link" onClick={onClose}>Close</Button>
            </div>

            {/* live status */}
            <div style={{ minHeight: 20, opacity: 0.85 }} aria-live="polite">
                {busy ? `${"○".repeat(dots)}${"●".repeat(3 - dots)} ${status}` : status}
            </div>
        </div>
    );
}
