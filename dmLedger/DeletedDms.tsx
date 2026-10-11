/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Deleted-DM capture: when someone deletes a DM message you've actually
// seen, append its text + attachment links to a JSON Lines file so it
// survives a restart. Pure logic lives in deletedCore.ts (tested there);
// this file wires it to Discord flux, the disk, and a floating viewer.
//
// Hard boundaries (deliberate):
//   - DM channels only (type 1 / 3). Guild traffic is never touched.
//   - Only OTHER people's messages. Your own deletions are deliberate.
//   - Only messages this client actually saw. A delete that happened while
//     Discord was closed produced no event — nothing can recover it.

import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { ChannelStore, MessageStore, TextInput, useEffect, useMemo, UserStore, useState } from "@webpack/common";

import {
    type DeletedCapture,
    formatLine,
    isDmChannel,
    makeCapture,
    mergeLists,
    parseLines,
    rememberRing,
    ringToMsg,
    takeRing,
    updateRing,
} from "./deletedCore";
import { closeFloating, openFloating } from "./floating";

const log = new Logger("DmLedger/DeletedDms");
const Native = VencordNative.pluginHelpers.DmLedger as PluginNative<typeof import("./native")> | undefined;

export const DELETED_FILE = "dmledger_deleted.jsonl";

// ─── wiring state ────────────────────────────────────────────────────────────
const ring = new Map<string, DeletedCapture[]>();
const seenDeletes = new Set<string>();
let hits: DeletedCapture[] = [];
let cfg: { folder: () => string; enabled: () => boolean; } = {
    folder: () => "",
    enabled: () => false,
};
let warnedNoFolder = false;
let writeChain: Promise<any> = Promise.resolve();

/** call from plugin start(); resets capture state so restarts reload from disk */
export function configureDeletedDms(next: { folder: () => string; enabled: () => boolean; }): void {
    cfg = next;
    ring.clear();
    seenDeletes.clear();
    hits = [];
    warnedNoFolder = false;
}

const myId = () => String(UserStore.getCurrentUser()?.id ?? "");
const nameFor = (id: string) => UserStore.getUser(id)?.globalName ?? UserStore.getUser(id)?.username;

/** pull the durable half back off disk (called from start()) */
export async function reloadDeletedDms(): Promise<number> {
    const folder = cfg.folder().trim();
    if (!folder || !Native?.readFileInFolder) return hits.length;
    try {
        const r = await Native.readFileInFolder(folder, DELETED_FILE);
        if (r?.ok && typeof r.text === "string") {
            hits = mergeLists(parseLines(r.text), hits);
            bump();
        }
    } catch (e) {
        log.warn("could not read deleted-dm file:", String(e));
    }
    return hits.length;
}

// ─── flux handlers (wired in index.tsx) ──────────────────────────────────────
export function onDmMessageCreate(e: any): void {
    remember(e?.message ?? e);
}

export function onDmMessageUpdate(e: any): void {
    remember(e?.message ?? e);
}

// MESSAGE_DELETE flux payload: { channelId, id } (camelCase — Vencord's own
// re-dispatches use the same shape); MESSAGE_DELETE_BULK: { channelId, ids }.
// Accept the snake_case gateway variants too — cheap insurance, tested both.
export function onDmMessageDelete(e: any): void {
    if (!cfg.enabled()) return;
    const cid = String(e?.channelId ?? e?.channel_id ?? "");
    if (!cid) return;
    const ch = ChannelStore.getChannel(cid);
    if (!isDmChannel(ch)) return;
    const ids: string[] = Array.isArray(e?.ids)
        ? e.ids.map(String)
        : (e?.id ?? e?.message_id) != null ? [String(e.id ?? e.message_id)] : [];
    if (!ids.length) return;

    const now = Date.now();
    for (const mid of ids) {
        const key = `${cid}|${mid}`;
        if (seenDeletes.has(key)) continue; // gateway + store re-dispatch safety
        seenDeletes.add(key);

        // live store first (freshest full object), ring buffer second —
        // plugins subscribe AFTER MessageStore handles the delete, so the
        // store is often already empty; the ring is what makes fast deletes
        // recoverable at all.
        const live: any = (MessageStore as any)?.getMessage?.(cid, mid) ?? null;
        const ringCap = takeRing(ring, cid, mid);
        const msg = live ?? (ringCap ? ringToMsg(ringCap) : null);
        if (!msg) continue; // never saw this message — honest skip

        const cap = makeCapture(ch, msg, myId(), now, nameFor) ?? (ringCap ? { ...ringCap, deletedAt: now } : null);
        if (!cap) continue; // own message (you deleted your own) — never saved
        hits = mergeLists([cap], hits);
        bump();
        persist(cap);
    }
}

function remember(msg: any): void {
    if (!cfg.enabled() || !msg?.id || !msg.channel_id) return;
    const ch = ChannelStore.getChannel(msg.channel_id);
    if (!isDmChannel(ch)) return;
    const cap = makeCapture(ch, msg, myId(), Date.now(), nameFor);
    if (!cap) return;
    rememberRing(ring, cap);
    updateRing(ring, cap); // edits refresh content so we log the latest text
}

function persist(cap: DeletedCapture): void {
    const folder = cfg.folder().trim();
    if (!folder) {
        if (!warnedNoFolder) {
            warnedNoFolder = true;
            log.warn("deleted DM captured in memory, but no downloadFolder is set in DmLedger settings — nothing was written to disk");
        }
        return;
    }
    writeChain = writeChain.then(async () => {
        const r = await Native?.appendFile?.(folder, DELETED_FILE, formatLine(cap));
        if (r && !r.success) log.error(`append failed: ${r.error}`);
    }).catch(() => { /* disk hiccups shouldn't wedge the chain */ });
}

/** number of messages held in memory (log line at start) */
export function deletedDmCount(): number {
    return hits.length;
}

// ─── floating viewer ─────────────────────────────────────────────────────────
let listener: (() => void) | null = null;
function bump() { listener?.(); }

export function closeDeletedDms(): boolean {
    return closeFloating("DmDeletedDms");
}

export function openDeletedDms(): void {
    openFloating({
        storageKey: "DmDeletedDms",
        title: "Deleted DM messages",
        render: close => <DeletedDmsView close={close} />,
    });
    void reloadDeletedDms();
}

export function deletedDmSnapshot(): DeletedCapture[] {
    return hits;
}

function age(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? "" : `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function DeletedDmsView({ close }: { close: () => void; }) {
    const [, setTick] = useState(0);
    const [filter, setFilter] = useState("");
    const [shown, setShown] = useState(60);
    useEffect(() => { listener = () => setTick(t => t + 1); return () => { listener = null; }; }, []);

    const rows = useMemo(() => {
        let list = hits;
        const q = filter.trim().toLowerCase();
        if (q) list = list.filter(h => h.chLabel.toLowerCase().includes(q) || h.name.toLowerCase().includes(q) || h.content.toLowerCase().includes(q) || h.urls.some(u => u.toLowerCase().includes(q)));
        return list;
    }, [hits, filter]);

    const folder = cfg.folder().trim();
    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", color: "var(--text-normal)", fontSize: 13 }}>
            <div style={{ display: "flex", gap: 8, padding: "8px 10px", alignItems: "center", borderBottom: "1px solid var(--background-tertiary)" }}>
                <div style={{ flex: 1 }}>
                    <TextInput
                        value={filter}
                        placeholder="Filter by person, channel, text, or link…"
                        onChange={(v: string) => { setFilter(v ?? ""); setShown(60); }}
                    />
                </div>
                <button onClick={() => void reloadDeletedDms()} style={btn}>Reload file</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "6px 10px" }}>
                {!rows.length && <div style={{ padding: 8 }}>Nothing captured yet. Messages get saved the moment the other person deletes them (while Discord is running).</div>}
                {rows.slice(0, shown).map(h => (
                    <div key={h.cid + "|" + h.mid} style={{ padding: "7px 4px", borderBottom: "1px solid var(--background-tertiary)" }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                            <span style={{ fontWeight: 600 }}>{h.name}</span>
                            <span style={{ opacity: 0.6 }}>to {h.chLabel}</span>
                            <span style={{ opacity: 0.6 }}>{age(h.deletedAt)}</span>
                        </div>
                        {h.content && <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{h.content}</div>}
                        {!!h.urls.length && (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                                {h.urls.slice(0, 3).map(u => (
                                    <a key={u} href={u} target="_blank" rel="noreferrer noopener" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{u.split("/").pop()}</a>
                                ))}
                                {h.urls.length > 3 && <span style={{ fontSize: 11, opacity: 0.6 }}>+{h.urls.length - 3}</span>}
                            </div>
                        )}
                    </div>
                ))}
                {rows.length > shown && (
                    <button onClick={() => setShown(n => n + 100)} style={{ ...btn, width: "100%", marginTop: 8 }}>
                        show {Math.min(100, rows.length - shown)} more ({rows.length - shown} left)
                    </button>
                )}
            </div>
            <div style={{ padding: "6px 10px", borderTop: "1px solid var(--background-tertiary)", opacity: 0.6, fontSize: 11 }}>
                {hits.length} saved · {folder ? `file: ${folder}\\${DELETED_FILE}` : "no downloadFolder set in DmLedger settings — captures stay in memory only"}
            </div>
            <button onClick={close} hidden aria-hidden />
        </div>
    );
}

const btn: React.CSSProperties = {
    background: "var(--background-tertiary)", color: "var(--text-normal)",
    border: "none", borderRadius: 4, padding: "5px 10px", cursor: "pointer", fontSize: 12,
};
