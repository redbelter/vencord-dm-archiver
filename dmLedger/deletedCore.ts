/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Deleted-DM-message capture engine: pure (no Discord imports), fully
// testable. DmLedger's flux handlers feed it observed DM messages; when a
// delete event arrives it recovers what it can (live store → ring buffer)
// and the caller appends the record to disk. The file is JSON Lines — one
// JSON object per deleted message, append-only, human-openable, greppable.

export interface DeletedCapture {
    mid: string; // message id (dedupe key)
    cid: string; // DM channel id
    chLabel: string; // best-known partner / group label at capture time
    author: string; // author id
    name: string; // author display name at capture time
    content: string; // message text (latest edited version we saw)
    urls: string[]; // attachment urls
    ts: string; // message timestamp (ISO, as Discord sent it)
    deletedAt: number; // epoch ms when we saw the delete (0 = still alive, ring entry)
}

// DM = 1, GROUP_DM = 3. Guild text channels, threads, everything else are
// off-limits: this feature is about DMs, and logging guild traffic would be
// a different (much louder) thing.
export function isDmChannel(ch: any): boolean {
    return !!ch && (ch.type === 1 || ch.type === 3);
}

// ChannelStore DM channels carry recipient ids; REST /users/@me/channels
// carries recipient OBJECTS. Both shapes seen live — normalize.
function recipientIds(ch: any): string[] {
    const raw = Array.isArray(ch?.recipients) ? ch.recipients
        : Array.isArray(ch?.recipient_ids) ? ch.recipient_ids
            : [];
    return raw.map((r: any) => (typeof r === "string" ? r : r?.id)).filter(Boolean);
}

// Name lookups are injected so this file stays import-free of Discord stores.
// Returns null for own messages (your own deletions are deliberate — saving
// them is noise) and for messages with no resolvable author.
export function makeCapture(ch: any, msg: any, myId: string, now: number, userName: (id: string) => string | undefined): DeletedCapture | null {
    if (!ch?.id || !msg?.id) return null;
    const authorId = msg.author?.id ?? msg.author_id;
    if (!authorId) return null;
    if (String(authorId) === String(myId)) return null;
    const partners = recipientIds(ch).filter(id => String(id) !== String(myId));
    const chLabel = ch.type === 3
        ? `Group DM (${partners.map(p => userName(p) ?? "member").slice(0, 4).join(", ")})`
        : partners.map(p => userName(p)).find(Boolean) ?? "unknown";
    const urls = (Array.isArray(msg.attachments) ? msg.attachments : [])
        .map((a: any) => a?.url).filter((u: any): u is string => typeof u === "string" && !!u);
    const cap: DeletedCapture = {
        mid: String(msg.id),
        cid: String(ch.id),
        chLabel,
        author: String(authorId),
        name: userName(String(authorId)) ?? "unknown",
        content: typeof msg.content === "string" ? msg.content : "",
        urls,
        ts: typeof msg.timestamp === "string" ? msg.timestamp : "",
        deletedAt: now,
    };
    // stickers vanish from chat rows with no text trace — leave a text marker
    if (!cap.content && Array.isArray(msg.sticker_items) && msg.sticker_items.length)
        cap.content = `[sticker: ${msg.sticker_items.map((s: any) => s?.name ?? "item").join(", ")}]`;
    return cap;
}

// ─── ring buffer ─────────────────────────────────────────────────────────────
// Live MESSAGE_DELETE often arrives AFTER MessageStore already evicted the
// message (plugins subscribe late; the store deletes first), so getMessage()
// alone loses fast deletes. Remembering what we saw in MESSAGE_CREATE is what
// makes the capture actually complete. Memory-only and bounded — the file is
// the durable half.
export const RING_CAP = 300; // messages kept per DM channel (fast deletes arrive within seconds; 300 covers bursts)

export function rememberRing(ring: Map<string, DeletedCapture[]>, cap: DeletedCapture, capPer: number = RING_CAP): void {
    if (!cap.cid || !cap.mid) return;
    let list = ring.get(cap.cid);
    if (!list) ring.set(cap.cid, list = []);
    if (list.some(c => c.mid === cap.mid)) return; // pending→sent re-fire of the same message
    list.push(cap);
    if (list.length > capPer) list.splice(0, list.length - capPer); // drop OLDEST — keep the recent window
}

export function takeRing(ring: Map<string, DeletedCapture[]>, cid: string, mid: string): DeletedCapture | undefined {
    // lookup only — never splice: bulk deletes reference ids and the entry is
    // harmless to keep, while removing mid-iteration corrupts the cap window
    return ring.get(cid)?.find(c => c.mid === mid);
}

export function updateRing(ring: Map<string, DeletedCapture[]>, cap: DeletedCapture): void {
    const list = ring.get(cap.cid);
    const i = list?.findIndex(c => c.mid === cap.mid) ?? -1;
    if (list && i >= 0) list[i] = cap; // edit refresh: capture the LATEST text, not the typo
}

// rebuild a message-ish object from a ring record (delete-time source when
// the live store already lost it)
export function ringToMsg(c: DeletedCapture): any {
    return {
        id: c.mid,
        channel_id: c.cid,
        author: { id: c.author },
        content: c.content,
        timestamp: c.ts,
        attachments: c.urls.map((u, i) => ({ id: `ring${i}`, url: u })),
    };
}

// ─── file format ─────────────────────────────────────────────────────────────
export function formatLine(cap: DeletedCapture): string {
    return JSON.stringify(cap) + "\n";
}

// Tolerant parse: a torn tail line (power loss mid-append) must never make
// the whole log unloadable. Bad lines are skipped, good ones recovered.
export function parseLines(text: string): DeletedCapture[] {
    const out: DeletedCapture[] = [];
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            const v = JSON.parse(t);
            if (!v || typeof v.mid !== "string" || typeof v.cid !== "string") continue;
            out.push({
                mid: v.mid,
                cid: v.cid,
                chLabel: typeof v.chLabel === "string" ? v.chLabel : "unknown",
                author: String(v.author ?? ""),
                name: String(v.name ?? "unknown"),
                content: String(v.content ?? ""),
                urls: Array.isArray(v.urls) ? v.urls.filter((u: any) => typeof u === "string") : [],
                ts: String(v.ts ?? ""),
                deletedAt: Number(v.deletedAt) || 0,
            });
        } catch { /* half-written line — skip it, the log stays appendable */ }
    }
    return out;
}

export const LIST_CAP = 5000; // in-memory viewer cap (the file never truncates)

// dedupe by mid|cid (file reload + live capture overlap), newest deletion first
export function mergeLists(incoming: DeletedCapture[], existing: DeletedCapture[], cap: number = LIST_CAP): DeletedCapture[] {
    const byId = new Map<string, DeletedCapture>();
    for (const c of existing) byId.set(`${c.mid}|${c.cid}`, c);
    for (const c of incoming) byId.set(`${c.mid}|${c.cid}`, c);
    return [...byId.values()].sort((a, b) => b.deletedAt - a.deletedAt).slice(0, cap);
}
