/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// msgPurge control center: scope picker, live status strip, rate control,
// and pause / resume / stop for long-running deletions.

import { Button } from "@components/Button";
import { ChannelRouter, Checkbox, Modal, openModal, Text, TextInput, useEffect, useState } from "@webpack/common";
import type { CSSProperties } from "react";

import { type DmRow, getDmSummary, listDms, type PurgeConfig, type PurgeEngine, type PurgeEstimate, type PurgeScope } from "./engine";

export function openPurgeControl(engine: PurgeEngine, initialScope: PurgeScope, currentChannelId?: string) {
    openModal(modalProps => (
        <Modal
            {...modalProps}
            size="md"
            title="msgPurge"
            subtitle="Rate-limited deletion of your own messages"
        >
            <PurgeControl
                onClose={modalProps.onClose}
                engine={engine}
                initialScope={initialScope}
                currentChannelId={currentChannelId}
            />
        </Modal>
    ));
}

function fmtDuration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtElapsed(ms: number): string {
    if (ms <= 0) return "—";
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

const panelStyle: CSSProperties = {
    padding: 12,
    borderRadius: 8,
    background: "var(--background-tertiary, rgba(128,128,128,.15))",
};

function PurgeControl({ engine, onClose, initialScope, currentChannelId }: {
    engine: PurgeEngine;
    onClose(): void;
    initialScope: PurgeScope;
    currentChannelId?: string;
}) {
    const canTargetCurrentChannel = Boolean(currentChannelId);
    const [scope, setScope] = useState<PurgeScope>(initialScope);
    const [targetCurrent, setTargetCurrent] = useState(canTargetCurrentChannel);
    const [targetDms, setTargetDms] = useState(false);
    const [friendsOnly, setFriendsOnly] = useState(false);
    const [, setTick] = useState(0);
    const [dmCount, setDmCount] = useState<number | undefined>(undefined);
    const [estimating, setEstimating] = useState(false);
    const [estimate, setEstimate] = useState<PurgeEstimate | null>(null);
    const [estimateProgress, setEstimateProgress] = useState("");
    // DM picker: loaded lazily the first time it's expanded
    const [showPicker, setShowPicker] = useState(false);
    const [dmList, setDmList] = useState<DmRow[] | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState("");

    // refresh the status strip ~1/s while something is happening
    useEffect(() => {
        const t = setInterval(() => setTick(x => x + 1), 1000);
        return () => clearInterval(t);
    }, []);

    // preview how big "all DMs" actually is
    useEffect(() => {
        getDmSummary().then(s => setDmCount(s.total)).catch(() => setDmCount(undefined));
    }, []);

    // load the DM picker list the first time it's opened
    useEffect(() => {
        if (showPicker && dmList === null) {
            listDms().then(rows => setDmList(rows)).catch(() => setDmList([]));
        }
    }, [showPicker]);

    const st = engine.status;
    const { running } = st;
    const pendingNow = engine.getPendingCount();
    // queue exists but nothing is running → resume/discard banner
    const showSavedQueue = !running && pendingNow > 0;

    const toggleDm = (channelId: string) =>
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(channelId)) next.delete(channelId);
            else next.add(channelId);
            return next;
        });

    const buildConfig = (): PurgeConfig => ({
        scope,
        includeCurrentChannel: targetCurrent && canTargetCurrentChannel,
        // picker mode: explicit list wins over the full sweep checkbox, but an
        // explicit "All my DMs" check (later) overrides stale selections
        includeDms: targetDms || selected.size > 0,
        selectedDmIds: !targetDms && selected.size > 0 ? [...selected] : undefined,
        friendsOnly: friendsOnly && targetDms,
        // captured when the modal opened — the store fallback can return a
        // guild channel (or "") while browsing DMs, so pass it explicitly
        currentChannelId,
    });

    const start = () => {
        const config = buildConfig();
        if (!config.includeCurrentChannel && !config.includeDms) return;
        engine.start(config);
    };

    const doEstimate = () => {
        const config = buildConfig();
        if (!config.includeCurrentChannel && !config.includeDms) return;
        setEstimating(true);
        setEstimate(null);
        setEstimateProgress("counting…");
        engine.estimate(config, (done, total, counted) =>
            setEstimateProgress(`counting ${done}/${total} conversations — ${counted} so far…`))
            .then(res => { setEstimate(res); setEstimating(false); })
            .catch(() => { setEstimating(false); setEstimateProgress(""); });
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* ── saved queue banner ─────────────────────────────────── */}
            {showSavedQueue ? (
                <div style={panelStyle}>
                    <Text variant="text-sm/normal">
                        Unfinished purge: {pendingNow} message(s) still queued. Resume or discard.
                    </Text>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <Button variant="primary" size="xs" onClick={() => engine.resumePending()}>
                            Resume queue
                        </Button>
                        <Button variant="secondary" size="xs" onClick={() => engine.discardPending()}>
                            Discard
                        </Button>
                    </div>
                </div>
            ) : null}

            {/* ── live status strip ──────────────────────────────────── */}
            <div style={panelStyle}>
                <Text variant="text-sm/bold">
                    {running
                        ? (st.paused ? "PAUSED" : "RUNNING")
                        : (pendingNow > 0 ? "STOPPED — queue saved" : "IDLE")}
                    {" · "}
                    {st.scope === "media" ? "media only" : "all messages"}
                </Text>
                <div>
                    <Text variant="text-sm/normal">
                        deleted {st.deleted} · failed {st.failed} · scanned {st.scanned}
                        {running ? ` · ${st.ratePerMin}/min · queued ${pendingNow}` : ""}
                        {running && st.targetsTotal ? ` · target ${Math.min(st.targetsDone + 1, st.targetsTotal)}/${st.targetsTotal}` : ""}
                    </Text>
                </div>
                {running && st.currentTarget ? (
                    <Text variant="text-sm/normal">target: {st.currentTarget} · elapsed {fmtElapsed(Date.now() - st.startedAt)}</Text>
                ) : null}
                {st.lastMessage ? (
                    <Text variant="text-xs/normal">{st.lastMessage}</Text>
                ) : null}
            </div>

            {/* ── configuration (locked while running) ───────────────── */}
            <div style={{ opacity: running ? 0.5 : 1 }}>
                <Text variant="text-xs/bold">DELETE WHAT?</Text>
                <div>
                    <Checkbox
                        value={scope === "all"}
                        disabled={running}
                        onChange={(_, v: boolean) => !running && v && setScope("all")}
                    >
                        <Text variant="text-sm/normal">All messages I sent</Text>
                    </Checkbox>
                </div>
                <div>
                    <Checkbox
                        value={scope === "media"}
                        disabled={running}
                        onChange={(_, v: boolean) => !running && v && setScope("media")}
                    >
                        <Text variant="text-sm/normal">Only messages with media (attachments/images)</Text>
                    </Checkbox>
                </div>

                <div style={{ marginTop: 12 }}>
                    <Text variant="text-xs/bold">WHERE?</Text>
                </div>
                <div>
                    <Checkbox
                        value={targetCurrent}
                        disabled={running || !canTargetCurrentChannel}
                        onChange={(_, v: boolean) => !running && setTargetCurrent(v)}
                    >
                        <Text variant="text-sm/normal">Only this conversation{canTargetCurrentChannel ? "" : " (open one first)"}</Text>
                    </Checkbox>
                </div>
                <div>
                    <Checkbox
                        value={targetDms}
                        disabled={running}
                        onChange={(_, v: boolean) => !running && setTargetDms(v)}
                    >
                        <Text variant="text-sm/normal">
                            All my DMs — only my own messages
                            {dmCount !== undefined ? ` (${dmCount} conversation${dmCount === 1 ? "" : "s"})` : " (every private chat)"}
                        </Text>
                    </Checkbox>
                </div>
                <div>
                    <Checkbox
                        value={friendsOnly}
                        disabled={running || !targetDms}
                        onChange={(_, v: boolean) => !running && setFriendsOnly(v)}
                    >
                                                <Text variant="text-sm/normal">Skip DMs with friends (only sweep strangers)</Text>
                    </Checkbox>
                </div>

                {/* ── DM picker: choose specific people (incl. non-friends you can't open) ── */}
                <div style={{ marginTop: 8 }}>
                    <Button
                        variant="secondary"
                        size="xs"
                        disabled={running || targetDms}
                        onClick={() => setShowPicker(v => !v)}
                    >
                        {showPicker ? "Hide DM list" : "Pick specific DMs…"}
                        {selected.size ? ` (${selected.size} selected)` : ""}
                    </Button>
                </div>
                {showPicker && !targetDms ? (
                    <div style={{ ...panelStyle, maxHeight: 240, overflowY: "auto" as const }}>
                        {dmList === null ? (
                            <Text variant="text-sm/normal">loading DM list…</Text>
                        ) : dmList.length === 0 ? (
                            <Text variant="text-sm/normal">No DM channels found.</Text>
                        ) : (
                            <>
                                <TextInput
                                    placeholder="Search by name…"
                                    value={search}
                                    onChange={(v: string) => setSearch(v)}
                                />
                                <div style={{ display: "flex", gap: 6, margin: "6px 0" }}>
                                    <Button variant="secondary" size="xs"
                                        onClick={() => setSelected(new Set(dmList.filter(r => !r.isFriend).map(r => r.channelId)))}>
                                        All non-friends
                                    </Button>
                                    <Button variant="secondary" size="xs"
                                        onClick={() => setSelected(new Set(dmList.filter(r => r.isFriend).map(r => r.channelId)))}>
                                        All friends
                                    </Button>
                                    <Button variant="secondary" size="xs" onClick={() => setSelected(new Set())}>
                                        Clear
                                    </Button>
                                </div>
                                {dmList
                                    .filter(r => !search || r.username.toLowerCase().includes(search.toLowerCase()))
                                    .map(r => (
                                        <div key={r.channelId} style={{ display: "flex", alignItems: "center" }}>
                                            <Checkbox
                                                value={selected.has(r.channelId)}
                                                onChange={() => toggleDm(r.channelId)}
                                            >
                                                <Text variant="text-sm/normal">
                                                    {r.username}
                                                    <Text variant="text-xs/normal" style={{ color: "var(--text-muted, inherit)" }}>
                                                        {r.isFriend ? " · friend" : " · not friends"}
                                                    </Text>
                                                </Text>
                                            </Checkbox>
                                            <Button
                                                variant="secondary"
                                                size="xs"
                                                style={{ marginLeft: "auto" }}
                                                onClick={() => {
                                                    try {
                                                        ChannelRouter?.transitionToChannel?.(r.channelId);
                                                        onClose();
                                                    } catch { /* router unavailable */ }
                                                }}
                                            >
                                                Open
                                            </Button>
                                        </div>
                                    ))}
                            </>
                        )}
                    </div>
                ) : null}
            </div>

            {/* ── estimate ───────────────────────────────────────────── */}
            {estimating || estimate ? (
                <div style={panelStyle}>
                    {estimating ? (
                        <Text variant="text-sm/normal">{estimateProgress || "counting…"}</Text>
                    ) : estimate ? (
                        <>
                            <Text variant="text-sm/bold">
                                ≈ {estimate.count.toLocaleString()} message{estimate.count === 1 ? "" : "s"} to delete
                                {estimate.cancelled ? " (count cancelled early — partial)" : ""}
                            </Text>
                            <div>
                                <Text variant="text-sm/normal">
                                    in {estimate.channels} conversation{estimate.channels === 1 ? "" : "s"}
                                    {estimate.skipped ? ` · ${estimate.skipped} friend DM${estimate.skipped === 1 ? "" : "s"} skipped` : ""}
                                </Text>
                            </div>
                            {estimate.etaMs !== null ? (
                                <div>
                                    <Text variant="text-sm/normal">
                                        at {estimate.ratePerMinute}/min → about {fmtDuration(estimate.etaMs)}
                                    </Text>
                                </div>
                            ) : (
                                <div><Text variant="text-sm/normal">Nothing to delete — you sent no {scope === "media" ? "media" : "messages"} in the selected scope.</Text></div>
                            )}
                        </>
                    ) : null}
                </div>
            ) : null}

            {/* ── action row ─────────────────────────────────────────── */}
            <div style={{ display: "flex", gap: 8 }}>
                {!running ? (
                    <>
                        <Button
                            variant="secondary"
                            size="xs"
                            disabled={estimating || (!targetCurrent && !targetDms && selected.size === 0) || showSavedQueue}
                            onClick={estimating ? () => engine.cancelEstimate() : doEstimate}
                        >
                            {estimating ? "Cancel count" : "Estimate first"}
                        </Button>
                        <Button
                            variant="dangerPrimary"
                            size="xs"
                            disabled={estimating || (!targetCurrent && !targetDms && selected.size === 0) || showSavedQueue}
                            onClick={start}
                        >
                            Start purge
                        </Button>
                    </>
                ) : (
                    <>
                        {st.paused ? (
                            <Button variant="primary" size="xs" onClick={() => engine.resume()}>
                                Resume
                            </Button>
                        ) : (
                            <Button variant="secondary" size="xs" onClick={() => engine.pause()}>
                                Pause
                            </Button>
                        )}
                        <Button variant="dangerPrimary" size="xs" onClick={() => engine.cancel()}>
                            Stop & save
                        </Button>
                    </>
                )}
                <Button variant="secondary" size="xs" onClick={onClose}>
                    Close
                </Button>
            </div>

            <Text variant="text-xs/normal">
                Rate limit lives in plugin settings (default 15/min). Progress auto-saves — safe to close
                Discord mid-run; the queue resumes next launch. Only messages you sent are ever deleted.
            </Text>
        </div>
    );
}
