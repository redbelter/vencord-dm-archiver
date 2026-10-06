/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { Logger } from "@utils/Logger";
import { NavigationRouter, RestAPI, showToast, TextInput, useEffect, useMemo, useState } from "@webpack/common";

import { closeFloating, openFloating } from "./floating";
import {
    allUrls, type MediaHit, planSweep, sweepAll,
type SweepReport,
} from "./mediaCore";

const log = new Logger("MediaFinder");

interface Session {
    userId: string;
    userName: string;
    report: SweepReport | null;
    progress: { done: number; total: number; label: string } | null;
    running: boolean;
}

let session: Session | null = null;

export function closeMediaFinder(): boolean {
    return closeFloating("DmMediaFinder");
}

export function openMediaFinder(userId: string, userName: string): void {
    const toggled = openFloating({
        storageKey: "DmMediaFinder",
        title: `Media from ${userName}`,
        render: close => <MediaFinder key={session?.userId ?? userId} close={close} />,
    });
    // start a fresh sweep only when the window was just created or the
    // person changed; toggling an existing window back should not re-sweep
    const isNew = !toggled || session?.userId !== userId;
    if (isNew) void startSweep(userId, userName);
}

async function startSweep(userId: string, userName: string): Promise<void> {
    // empty id would make every request author-filter nothing and the
    // client-side guard would drop every message — a silent, permanent zero.
    if (!userId) {
        showToast("Media finder: missing user id", "failure");
        session = { userId: "", userName, report: null, progress: null, running: false };
        bump();
        return;
    }
    session = { userId, userName, report: null, progress: { done: 0, total: 0, label: "planning…" }, running: true };
    bump();
    try {
        const [guildsRes, channelsRes] = await Promise.all([
            RestAPI.get({ url: "/users/@me/guilds" }),
            RestAPI.get({ url: "/users/@me/channels" }),
        ]);
        const targets = planSweep(guildsRes.body ?? [], channelsRes.body ?? [], userId);
        log.info(`sweeping ${targets.length} places for ${userName}`);
        const report = await sweepAll(RestAPI, targets, userId, {
            onProgress: (done, total, label) => {
                if (!session) return;
                session.progress = { done, total, label };
                bump();
            },
        });
        if (session) { session.report = report; session.running = false; }
        log.info(`done: ${report.hits.length} media message(s), ${report.channelsFailed} unreadable skipped, ${report.rateLimited} rate-limited`);
    } catch (e) {
        log.error("sweep failed:", e);
        if (session) { session.running = false; session.progress = null; }
        showToast(`Media sweep failed: ${String((e as any)?.message ?? e)}`, "failure");
    }
    bump();
}

// tiny event bus so the floating window re-renders on progress ticks
let listener: (() => void) | null = null;
function bump() { listener?.(); }

function age(ts: string): string {
    if (!ts) return "";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

function MediaFinder({ close }: { close: () => void; }) {
    const [, setTick] = useState(0);
    const [filter, setFilter] = useState("");
    const [shown, setShown] = useState(60);
    useEffect(() => { listener = () => setTick(t => t + 1); return () => { listener = null; }; }, []);

    const s = session;
    const hits = useMemo(() => {
        let list = s?.report?.hits ?? [];
        const q = filter.trim().toLowerCase();
        if (q) list = list.filter(h => h.channelLabel.toLowerCase().includes(q) || h.preview.toLowerCase().includes(q));
        return list;
    }, [s?.report, filter]);

    const jump = (h: MediaHit) => NavigationRouter.transitionTo(jumpPath(h));

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", color: "var(--text-normal)", fontSize: 13 }}>
            <div style={{ display: "flex", gap: 8, padding: "8px 10px", alignItems: "center", borderBottom: "1px solid var(--background-tertiary)" }}>
                <div style={{ flex: 1 }}>
                    <TextInput
                        value={filter}
                        placeholder={s?.running ? "sweeping…" : "Filter by channel or text…"}
                        onChange={(v: string) => { setFilter(v ?? ""); setShown(60); }}
                    />
                </div>
                <button onClick={() => s && startSweep(s.userId, s.userName)} disabled={s?.running} style={btn}>Retry</button>
                <button
                    onClick={() => { const t = allUrls(hits); copyToClipboard(t); showToast(`Copied ${t ? t.split("\n").length : 0} link(s)`, "success"); }}
                    disabled={!hits.length}
                    style={btn}
                >
                    Copy all links
                </button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px" }}>
                {s?.running && (
                    <div style={{ padding: 8 }}>
                        sweeping {s.progress?.done ?? 0}/{s.progress?.total ?? "?"} — {s.progress?.label ?? ""}
                        <div style={{ height: 4, background: "var(--background-tertiary)", borderRadius: 2, marginTop: 6 }}>
                            <div style={{ height: "100%", width: `${s.progress?.total ? Math.round(100 * s.progress.done / s.progress.total) : 4}%`, background: "var(--brand-experiment, #5865f2)", borderRadius: 2 }} />
                        </div>
                    </div>
                )}
                {!s?.running && s?.report && (
                    <div style={{ padding: "4px 0", opacity: 0.8 }}>
                        {s.report.hits.length} media message(s) in {s.report.channelsScanned} place(s)
                        {s.report.channelsFailed ? ` · ${s.report.channelsFailed} unreadable skipped` : ""}
                        {s.report.rateLimited ? ` · ${s.report.rateLimited} rate-limited (Retry to catch)` : ""}
                        {s.report.truncated ? " · capped, retry in smaller scopes" : ""}
                    </div>
                )}
                {!s?.running && !s?.report && <div style={{ padding: 8 }}>idle</div>}

                {hits.slice(0, shown).map(h => (
                    <div key={h.channelId + h.messageId} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 4px", borderBottom: "1px solid var(--background-tertiary)" }}>
                        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                            <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                                <span style={{ fontWeight: 600 }}>{h.channelLabel}</span>
                                <span style={{ opacity: 0.6 }}>{h.kind === "dm" ? "DM" : "server"}{age(h.timestamp) ? ` · ${age(h.timestamp)}` : ""}</span>
                            </div>
                            {h.preview && <div style={{ opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.preview}</div>}
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                                {h.urls.slice(0, 3).map(u => (
                                    <a key={u} href={u} target="_blank" rel="noreferrer noopener" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{u.split("/").pop()}</a>
                                ))}
                                {h.urls.length > 3 && <span style={{ fontSize: 11, opacity: 0.6 }}>+{h.urls.length - 3}</span>}
                            </div>
                        </div>
                        <div style={{ display: "flex", gap: 4 }}>
                            <button style={btn} onClick={() => jump(h)}>Open</button>
                            <button style={btn} onClick={() => { copyToClipboard(h.urls.join("\n")); showToast("Copied link(s)", "success"); }}>Copy</button>
                        </div>
                    </div>
                ))}
                {hits.length > shown && (
                    <button onClick={() => setShown(n => n + 100)} style={{ ...btn, width: "100%", marginTop: 8 }}>
                        show {Math.min(100, hits.length - shown)} more ({hits.length - shown} left)
                    </button>
                )}
            </div>
            <div style={{ padding: "6px 10px", borderTop: "1px solid var(--background-tertiary)", opacity: 0.6, fontSize: 11 }}>
                {s?.userName ? `author: ${s.userName} · ` : ""}every server + every DM with them your account can read
            </div>
            <button onClick={close} hidden aria-hidden />
        </div>
    );
}

const btn: React.CSSProperties = {
    background: "var(--background-tertiary)", color: "var(--text-normal)",
    border: "none", borderRadius: 4, padding: "5px 10px", cursor: "pointer", fontSize: 12,
};

function jumpPath(h: MediaHit): string {
    return `/channels/${h.kind === "guild" ? h.guildId : "@me"}/${h.channelId}/${h.messageId}`;
}
