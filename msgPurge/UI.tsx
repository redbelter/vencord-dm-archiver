/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// msgPurge control center: scope picker, live status strip, rate control,
// and pause / resume / stop for long-running deletions.

import { Button } from "@components/Button";
import { Checkbox, Modal, openModal, Text, useEffect, useState } from "@webpack/common";
import type { CSSProperties } from "react";

import { getDmSummary,type PurgeConfig, type PurgeEngine, type PurgeScope } from "./engine";

export function openPurgeControl(engine: PurgeEngine, initialScope: PurgeScope, canTargetCurrentChannel: boolean) {
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
                canTargetCurrentChannel={canTargetCurrentChannel}
            />
        </Modal>
    ));
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

function PurgeControl({ engine, onClose, initialScope, canTargetCurrentChannel }: {
    engine: PurgeEngine;
    onClose(): void;
    initialScope: PurgeScope;
    canTargetCurrentChannel: boolean;
}) {
    const [scope, setScope] = useState<PurgeScope>(initialScope);
    const [targetCurrent, setTargetCurrent] = useState(canTargetCurrentChannel);
    const [targetDms, setTargetDms] = useState(false);
    const [friendsOnly, setFriendsOnly] = useState(false);
    const [, setTick] = useState(0);
    const [dmCount, setDmCount] = useState<number | undefined>(undefined);

    // refresh the status strip ~1/s while something is happening
    useEffect(() => {
        const t = setInterval(() => setTick(x => x + 1), 1000);
        return () => clearInterval(t);
    }, []);

    // preview how big "all DMs" actually is
    useEffect(() => {
        getDmSummary().then(s => setDmCount(s.total)).catch(() => setDmCount(undefined));
    }, []);

    const st = engine.status;
    const { running } = st;
    const pendingNow = engine.getPendingCount();
    // queue exists but nothing is running → resume/discard banner
    const showSavedQueue = !running && pendingNow > 0;

    const start = () => {
        const config: PurgeConfig = {
            scope,
            includeCurrentChannel: targetCurrent && canTargetCurrentChannel,
            includeDms: targetDms,
            friendsOnly: friendsOnly && targetDms,
        };
        if (!config.includeCurrentChannel && !config.includeDms) return;
        engine.start(config);
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
                            My entire DM list{dmCount !== undefined ? ` (${dmCount} conversation${dmCount === 1 ? "" : "s"})` : " (all private chats)"}
                        </Text>
                    </Checkbox>
                </div>
                <div>
                    <Checkbox
                        value={friendsOnly}
                        disabled={running || !targetDms}
                        onChange={(_, v: boolean) => !running && setFriendsOnly(v)}
                    >
                        <Text variant="text-sm/normal">When sweeping DMs, skip people on my friends list</Text>
                    </Checkbox>
                </div>
            </div>

            {/* ── action row ─────────────────────────────────────────── */}
            <div style={{ display: "flex", gap: 8 }}>
                {!running ? (
                    <Button
                        variant="dangerPrimary"
                        size="xs"
                        disabled={(!targetCurrent && !targetDms) || showSavedQueue}
                        onClick={start}
                    >
                        Start purge
                    </Button>
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
