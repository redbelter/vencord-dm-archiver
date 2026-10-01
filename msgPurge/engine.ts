/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { MessageJSON } from "@vencord/discord-types";
import { Constants, MessageStore, RestAPI, UserStore } from "@webpack/common";

import { ledgerDms, ledgerGhostDms, ledgerNameFor, ledgerRefresh, recordDm } from "./ledger";

export const log = new Logger("MsgPurge");

export type PurgeScope = "all" | "media";

export interface PurgeEstimate {
    /** own messages matching the scope, summed across targets */
    count: number;
    /** how many of those targets actually have matching messages */
    channels: number;
    /** targets considered */
    targets: number;
    /** DMs skipped due to friends-only */
    skipped: number;
    cancelled: boolean;
    ratePerMinute: number;
    /** null when count is 0 */
    etaMs: number | null;
}

export interface PurgeConfig {
    /** "all" = every message you sent; "media" = only messages with attachments */
    scope: PurgeScope;
    /** include messages you sent in the currently-open channel (a DM or any channel) */
    includeCurrentChannel: boolean;
    /** additionally sweep your messages from every DM channel */
    includeDms: boolean;
    /** explicit DM channel ids (picker mode); when set, ONLY these DMs are targeted */
    selectedDmIds?: string[];
    /** when true, only delete DM messages sent to non-friends */
    friendsOnly: boolean;
    /** explicit "current channel" (e.g. slash-command context) instead of store lookup */
    currentChannelId?: string;
    /** resume a saved queue without scanning for new targets */
    resumeOnly?: boolean;
}

export interface PurgeStatus {
    running: boolean;
    paused: boolean;
    cancelled: boolean;
    scope: PurgeScope;
    currentTarget: string;
    scanned: number;
    deleted: number;
    failed: number;
    skipped: number;
    ratePerMin: number;
    startedAt: number;
    lastEventAt: number;
    lastMessage: string;
    targetsDone: number;
    targetsTotal: number;
    /** rolling epoch-ms timestamps of recent deletes, for msg/min estimate */
    recent: number[];
}

export interface EngineHooks {
    /** injected so index.tsx can persist progress via definePluginSettings store */
    save: (snapshot: Partial<PurgeStatus> & { pending?: Record<string, string[]>; }) => void;
    notify: (message: string) => void;
}

export interface EngineSettings {
    enabled: boolean;
    ratePerMinute: number;
    maxRetries: number;
    resumeAfterRestart: boolean;
}

// ─── pure helpers (exported for tests) ───────────────────────────────────────

/** A message is "media" if it has any attachments (files, images, videos). */
export function hasMedia(message: MessageJSON): boolean {
    return Array.isArray(message.attachments) && message.attachments.length > 0;
}

/** Fixed-window rate limiter: at most `ratePerMinute` actions per 60s window. */
export function rateWindowDelayMs(ratePerMinute: number): number {
    const rate = Math.max(1, Math.min(30, Math.floor(ratePerMinute)));
    return (60_000 / rate) * 1.2; // +20% headroom
}

export function withJitter(delayMs: number): number {
    return Math.round(delayMs * (0.8 + Math.random() * 0.4));
}

// ─── engine ──────────────────────────────────────────────────────────────────

const MAX_MESSAGE_PAGES = 500;
const CHECKPOINT_EVERY = 10;

export class PurgeEngine {
    readonly status: PurgeStatus = {
        running: false,
        paused: false,
        cancelled: false,
        scope: "all",
        currentTarget: "",
        scanned: 0,
        deleted: 0,
        failed: 0,
        skipped: 0,
        ratePerMin: 0,
        startedAt: 0,
        lastEventAt: 0,
        lastMessage: "",
        targetsDone: 0,
        targetsTotal: 0,
        recent: [],
    };

    /** message ids still to delete, per channel, persisted for resume */
    private pending = new Map<string, string[]>();

    constructor(
        private getSettings: () => EngineSettings,
        private hooks: EngineHooks,
    ) { }

    get isRunning(): boolean {
        return this.status.running;
    }

    private lastConfig: PurgeConfig = { scope: "all", includeCurrentChannel: true, includeDms: false, friendsOnly: false };

    /** Total message ids still queued (live or loaded from a saved run). */
    getPendingCount(): number {
        let n = 0;
        for (const ids of this.pending.values()) n += ids.length;
        return n;
    }

    hasPending(): boolean {
        return this.getPendingCount() > 0;
    }

    /** After a restart, the original run's config is gone — restore at least its scope. */
    setSavedScope(scope: PurgeScope): void {
        this.lastConfig = { ...this.lastConfig, scope };
    }

    /** Load a persisted queue (from a previous run) into memory. */
    hydrate(pending: Record<string, string[]> | undefined, scope?: PurgeScope): void {
        if (scope) {
            this.status.scope = scope;
            this.setSavedScope(scope);
        }
        if (!pending) return;
        for (const [ch, ids] of Object.entries(pending)) {
            if (Array.isArray(ids) && ids.length) this.pending.set(ch, [...ids]);
        }
    }

    /** Fired after any run finishes (cleanly or cancelled). index.tsx clears saved state. */
    onAfterComplete: (() => void) | undefined;

    /** Drop in-memory queue + counters (not the persisted snapshot). Tests / hard reset. */
    reset(): void {
        if (this.status.running) return;
        this.pending = new Map();
        Object.assign(this.status, {
            paused: false, cancelled: false, currentTarget: "", scanned: 0, deleted: 0,
            failed: 0, skipped: 0, ratePerMin: 0, startedAt: 0, lastEventAt: 0,
            lastMessage: "", targetsDone: 0, targetsTotal: 0, recent: [],
        });
    }

    discardPending(): void {
        if (this.status.running) return;
        this.pending = new Map();
        this.hooks.save({ ...this.status, pending: {} });
    }

    /** Re-arm a stopped run with the saved queue only — never re-scans. */
    resumePending(): boolean {
        if (this.status.running || !this.hasPending()) return false;
        // start() wipes the queue, so hand it back explicitly
        return this.start({ ...this.lastConfig, resumeOnly: true }, this.snapshotPending());
    }

    /** Start (or resume) a purge. Returns false if one is already running. */
    start(config: PurgeConfig, savedPending?: Record<string, string[]>): boolean {
        if (this.status.running) {
            this.hooks.notify("A purge is already running.");
            return false;
        }
        if (!this.getSettings().enabled) {
            this.hooks.notify("msgPurge is disabled — enable it in plugin settings first.");
            return false;
        }

        this.status.running = true;
        this.status.paused = false;
        this.status.cancelled = false;
        this.status.scope = config.scope;
        this.lastConfig = { ...config };
        this.status.scanned = 0;
        this.status.deleted = 0;
        this.status.failed = 0;
        this.status.skipped = 0;
        this.status.targetsDone = 0;
        this.status.startedAt = Date.now();
        this.status.lastEventAt = Date.now();
        this.status.recent = [];
        this.pending = new Map();
        if (savedPending) {
            for (const [ch, ids] of Object.entries(savedPending)) {
                if (Array.isArray(ids) && ids.length) this.pending.set(ch, [...ids]);
            }
        }

        void this.run(config);
        return true;
    }

    pause(): void {
        if (this.status.running) this.status.paused = true;
    }
    resume(): void {
        if (this.status.running) this.status.paused = false;
    }
    cancel(): void {
        if (this.status.running) this.status.cancelled = true;
    }

    snapshotPending(): Record<string, string[]> {
        const out: Record<string, string[]> = {};
        for (const [ch, ids] of this.pending) if (ids.length) out[ch] = [...ids];
        return out;
    }

    private event(message: string): void {
        this.status.lastMessage = message;
        this.status.lastEventAt = Date.now();
        this.hooks.save({ ...this.status, pending: this.snapshotPending() });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }

    /** Sleep that resolves early the moment pause or cancel flips (for gate waits). */
    private sleepUntilFlagged(ms: number): Promise<void> {
        return new Promise(resolve => {
            const start = Date.now();
            const tick = setInterval(() => {
                if (this.status.cancelled || this.status.paused || Date.now() - start >= ms) {
                    clearInterval(tick);
                    resolve();
                }
            }, 25);
        });
    }

    /** Wait until pause/cancel clears and the rate limiter allows one more delete. */
    private async gate(): Promise<boolean> {
        while (!this.status.cancelled) {
            if (!this.status.paused) {
                const rate = Math.max(1, Math.min(30, Math.floor(this.getSettings().ratePerMinute)));
                const delay = withJitter(rateWindowDelayMs(rate) * (this.windowMs / 60_000));
                const cutoff = Date.now() - this.windowMs;
                this.status.recent = this.status.recent.filter(t => t > cutoff);
                this.status.ratePerMin = this.status.recent.length;
                if (this.status.recent.length < rate) {
                    // wait a jittered inter-delete gap so bursts don't look like spam
                    await this.sleepUntilFlagged(Math.min(delay / 2, this.maxGateWaitMs));
                    if (this.status.cancelled) break;
                    if (this.status.paused) continue;
                    this.status.recent.push(Date.now());
                    return true;
                }
                // window full — wait for old deletes to age out (wake early on pause/cancel)
                await this.sleepUntilFlagged(Math.min(250, Math.max(5, this.windowMs / 8)));
                continue;
            }
            await this.sleepUntilFlagged(500);
        }
        return false;
    }

    /**
     * One pass per channel: collect your own message ids with their media flag.
     * Single scan — no second fetch pass even for media-only scope.
     */
    private async scanOwnMessages(channelId: string): Promise<Array<{ id: string; media: boolean; }>> {
        const me = UserStore.getCurrentUser()?.id;
        const out: Array<{ id: string; media: boolean; }> = [];
        const seen = new Set<string>();

        const record = (msg: MessageJSON) => {
            if (msg?.id && msg.author?.id === me && !seen.has(msg.id)) {
                seen.add(msg.id);
                out.push({ id: msg.id, media: hasMedia(msg) });
            }
        };

        // seed from locally cached messages (free, no API cost)
        try {
            const cache = MessageStore.getMessages(channelId);
            if (cache && Array.isArray(cache._array)) for (const msg of cache._array) record(msg as unknown as MessageJSON);
        } catch { /* cache shape may differ */ }

        let before: string | undefined;
        for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
            const query: Record<string, any> = { limit: 100 };
            if (before) query.before = before;
            try {
                const response = await RestAPI.get({
                    url: Constants.Endpoints.MESSAGES(channelId),
                    query,
                });
                const body = response.body as MessageJSON[] | undefined;
                if (!Array.isArray(body) || !body.length) break;
                const batch = body.filter(msg => msg?.id);
                if (!batch.length) break;
                batch.forEach(record);
                before = batch[batch.length - 1]?.id;
                if (!before || body.length < 100) break;
                await this.sleep(500);
            } catch (error) {
                log.warn(`history fetch failed for ${channelId}:`, error);
                break;
            }
        }
        return out;
    }

    /** backoff schedule knobs — production defaults, tests may shrink them */
    rateLimitBackoffMs = 60_000;
    retryBackoffMs = 5_000;
    /** cap on the per-delete gate sleep (tests shrink this; Infinity in prod) */
    maxGateWaitMs = Number.POSITIVE_INFINITY;
    /** rate-limiter window width (60s in prod; shrunk only by tests) */
    windowMs = 60_000;

    /**
     * Classify a delete result against BOTH Discord RestAPI shapes:
     *  - real Vencord: resolves with a bare body on 2xx, THROWS HTTPResponseError
     *    (carrying .status) on 4xx/5xx
     *  - envelope style: { ok, status } — older wrapper / harness
     * "gone" (404) means the message is already deleted → counts as deleted.
     */
    private classifyDelete(response?: any, error?: any): "ok" | "gone" | "ratelimited" | "retry" {
        const status = error?.status ?? response?.status;
        if (status === 429) return "ratelimited";
        if (status === 404) return "gone";
        if (error) return "retry";
        if (response == null) return "ok"; // 204 with empty body
        if (response.ok === true) return "ok";
        if (typeof status === "number") return status >= 200 && status < 300 ? "ok" : "retry";
        if (response.ok === false) return "retry";
        return "ok"; // resolved with a bare body → success
    }

    private async deleteOne(channelId: string, messageId: string): Promise<boolean> {
        const max = Math.max(1, this.getSettings().maxRetries);
        for (let attempt = 1; attempt <= max; attempt++) {
            let verdict: "ok" | "gone" | "ratelimited" | "retry";
            try {
                verdict = this.classifyDelete(await RestAPI.del({ url: Constants.Endpoints.MESSAGE(channelId, messageId) }));
            } catch (error: any) {
                verdict = this.classifyDelete(undefined, error);
                if (verdict === "retry") log.warn(`delete attempt ${attempt} threw for ${messageId}: ${error?.message ?? error}`);
            }

            if (verdict === "ok" || verdict === "gone") return true;
            if (verdict === "ratelimited") {
                this.event("rate limited — cooling down");
                await this.sleep(this.rateLimitBackoffMs * attempt);
                continue;
            }
            if (attempt < max) await this.sleep(this.retryBackoffMs * attempt);
        }
        return false;
    }

    /** Resolve which channels a config points at (shared by run() and estimate()). */
    private async buildTargets(config: PurgeConfig): Promise<{ targets: Array<{ id: string; label: string; }>; skipped: number; }> {
        const targets: Array<{ id: string; label: string; }> = [];
        let skipped = 0;
        const currentChannelId = config.currentChannelId ?? getCurrentChannelId();
        if (config.includeCurrentChannel && currentChannelId) {
            targets.push({ id: currentChannelId, label: "this channel" });
        }
        const picked = config.selectedDmIds?.filter(Boolean) ?? [];
        if (picked.length) {
            // explicit picker mode: exactly these DMs, no friend filter
            const want = new Set(picked.map(String));
            const seen = new Set<string>();
            for (const row of await listDms()) {
                if (!want.has(row.channelId)) continue;
                seen.add(row.channelId);
                if (row.channelId === currentChannelId && config.includeCurrentChannel) continue;
                targets.push({ id: row.channelId, label: row.username });
            }
            // channel ids matching no live row (hidden-window DMs): the ledger
            // may still know who they are — deleting by id needs no live list
            await ledgerRefresh().catch(() => undefined);
            for (const id of want) {
                if (seen.has(id) || id === currentChannelId) continue;
                const led = ledgerDms().find(l => l.channelId === id);
                targets.push({ id, label: (led && (led.username ?? ledgerNameFor(led.userId))) ?? "DM" });
            }
        } else if (config.includeDms) {
            const friendIds = config.friendsOnly ? await fetchFriendIds() : new Set<string>();
            for (const ch of await fetchDmChannels()) {
                const uid = ch.recipient_ids?.[0] ?? ch.recipients?.[0]?.id;
                if (!uid) continue;
                if (config.friendsOnly && friendIds.has(String(uid))) {
                    skipped++;
                    continue;
                }
                if (String(ch.id) === currentChannelId && config.includeCurrentChannel) continue;
                targets.push({ id: String(ch.id), label: UserStore.getUser(String(uid))?.username ?? "DM" });
            }
        }
        return { targets, skipped };
    }

    /**
     * Count what a purge WOULD delete (and how long it'd take) without deleting
     * anything. Walks the same scan path as run(); cancels via cancelEstimate().
     */
    async estimate(config: PurgeConfig, onProgress?: (done: number, total: number, counted: number) => void): Promise<PurgeEstimate> {
        if (this.status.running) throw new Error("a purge is running");
        this.estimating = true;
        this.cancelEstimateFlag = false;
        try {
            const { targets, skipped } = await this.buildTargets(config);
            let count = 0, channelsWithHits = 0;
            for (let i = 0; i < targets.length; i++) {
                if (this.cancelEstimateFlag) return { count, channels: channelsWithHits, targets: targets.length, skipped, cancelled: true, ratePerMinute: this.effectiveRate(), etaMs: null };
                const own = await this.scanOwnMessages(targets[i].id);
                const hits = own.filter(m => config.scope !== "media" || m.media).length;
                count += hits;
                if (hits) channelsWithHits++;
                onProgress?.(i + 1, targets.length, count);
            }
            const rate = this.effectiveRate();
            return {
                count,
                channels: channelsWithHits,
                targets: targets.length,
                skipped,
                cancelled: false,
                ratePerMinute: rate,
                etaMs: count && rate ? (count / rate) * 60_000 : null,
            };
        } finally {
            this.estimating = false;
        }
    }

    cancelEstimate(): void {
        this.cancelEstimateFlag = true;
    }

    private estimating = false;
    private cancelEstimateFlag = false;

    effectiveRate(): number {
        return Math.max(1, Math.min(30, Math.floor(this.getSettings().ratePerMinute)));
    }

    private async run(config: PurgeConfig): Promise<void> {
        const st = this.status;
        try {
            // Build target list (skipped entirely when resuming a saved run)
            const targets: Array<{ id: string; label: string; }> = [];
            if (!config.resumeOnly) {
                const built = await this.buildTargets(config);
                targets.push(...built.targets);
                st.skipped += built.skipped;
            }

            if (!targets.length && !this.pending.size) {
                st.running = false;
                this.event("nothing to purge — no targets found");
                this.hooks.notify("msgPurge found nothing to delete.");
                return;
            }

            st.targetsTotal = targets.length;
            st.currentTarget = "";
            this.event(config.resumeOnly ? `resuming ${this.getPendingCount()} queued deletions` : `prepared ${targets.length} target(s)`);

            // Phase 1: scan every target and collect matching own-message ids
            for (const t of targets) {
                if (st.cancelled) break;
                if (this.pending.has(t.id)) { st.targetsDone++; continue; } // already queued from resume
                st.currentTarget = t.label;
                this.event(`scanning ${t.label}…`);
                const own = await this.scanOwnMessages(t.id);
                const queued = own
                    .filter(m => config.scope !== "media" || m.media)
                    .map(m => m.id);
                st.scanned += own.length;
                if (queued.length) this.pending.set(t.id, queued);
                st.targetsDone++;
                this.event(`${t.label}: ${queued.length} queued`);
            }

            // Phase 2: delete from every queued channel, respecting the rate gate
            st.targetsDone = 0;
            st.targetsTotal = this.pending.size;
            let processed = 0;

            outer:
            for (const [channelId, ids] of this.pending) {
                while (ids.length) {
                    const allowed = await this.gate(); // handles pause/cancel/rate limit
                    if (!allowed) break outer;

                    st.currentTarget = UserStore.getUser(channelId)?.username ?? `channel …${channelId.slice(-4)}`;
                    const success = await this.deleteOne(channelId, ids[0]);
                    ids.shift();
                    if (success) st.deleted++;
                    else st.failed++;

                    processed++;
                    if (processed % CHECKPOINT_EVERY === 0) this.event(`${st.deleted} deleted, ${ids.length} left in queue`);

                    if (st.cancelled) break outer;
                }
                st.targetsDone++;
            }

            st.running = false;
            st.currentTarget = "";
            const { cancelled } = st;
            const leftover = this.snapshotPending();
            this.event(cancelled ? `stopped — ${st.deleted} deleted` : `done — ${st.deleted} deleted, ${st.failed} failed`);
            this.hooks.save({ ...st, pending: cancelled || Object.keys(leftover).length ? leftover : {} });
            this.hooks.notify(
                cancelled
                    ? `msgPurge stopped after ${st.deleted} deletions (progress saved).`
                    : `msgPurge finished: ${st.deleted} deleted${st.failed ? `, ${st.failed} failed` : ""}.`,
            );
            this.onAfterComplete?.();
        } catch (error) {
            st.running = false;
            log.error("purge crashed:", error);
            this.event(`error: ${(error as Error)?.message ?? error}`);
            this.hooks.notify(`msgPurge hit an error: ${(error as Error)?.message ?? error}`);
        }
    }

}

// ─── small store helpers (kept out of the class for testability) ─────────────

function getCurrentChannelId(): string | undefined {
    // SelectedChannelStore lives behind @webpack/common; index.tsx injects the
    // raw getter here so the engine import stays React-free.
    return currentChannelIdProvider?.();
}

let currentChannelIdProvider: (() => string | undefined) | undefined;
export function setChannelIdProvider(fn: () => string | undefined): void {
    currentChannelIdProvider = fn;
}

async function fetchDmChannels(): Promise<any[]> {
    try {
        const response = await RestAPI.get({ url: "/users/@me/channels" });
        return Array.isArray(response.body) ? response.body.filter(c => c?.type === 1) : [];
    } catch {
        return [];
    }
}

/** How much DM surface exists, for the control panel to preview scope size. */
export interface DmRow {
    channelId: string;
    userId: string;
    username: string;
    isFriend: boolean;
}

/** Every DM channel with its recipient, friend status and best-known username. */
export async function listDms(): Promise<DmRow[]> {
    const channels = await fetchDmChannels();
    const friendIds = await fetchFriendIds();
    const rows: DmRow[] = [];
    for (const ch of channels) {
        const uid = String(ch.recipient_ids?.[0] ?? ch.recipients?.[0]?.id ?? "");
        if (!uid) continue;
        // the channel payload embeds the recipient — authoritative for
        // unfriended / long-gone accounts missing from UserStore
        const user = ch.recipients?.[0] ?? UserStore.getUser(uid);
        // recipient object is embedded in the channel payload — names still
        // resolve for unfriended / long-gone accounts missing from UserStore
        const name = user?.global_name ?? user?.username ?? ledgerNameFor(uid) ?? `user ${uid}`;
        rows.push({
            channelId: String(ch.id),
            userId: uid,
            username: name,
            isFriend: friendIds.has(uid),
        });
        recordDm({ userId: uid, channelId: String(ch.id), username: name === `user ${uid}` ? undefined : name, isFriend: friendIds.has(uid), source: "live" });
    }
    // ledger-only partners: DMs Discord's live window no longer lists. The
    // deleter can still target them by channel id — deleting messages never
    // needed the channel to be in anyone's list.
    for (const led of ledgerGhostDms()) {
        if (rows.some(r => r.userId === led.userId)) continue;
        rows.push({
            channelId: led.channelId,
            userId: led.userId,
            username: led.username ?? ledgerNameFor(led.userId) ?? `user ${led.userId}`,
            isFriend: false,
        });
    }
    return rows;
}

export async function getDmSummary(): Promise<{ total: number; nonFriends: number; }> {
    const channels = await fetchDmChannels();
    const friendIds = await fetchFriendIds();
    let nonFriends = 0;
    for (const ch of channels) {
        const uid = ch.recipient_ids?.[0] ?? ch.recipients?.[0]?.id;
        if (uid && !friendIds.has(String(uid))) nonFriends++;
    }
    return { total: channels.length, nonFriends };
}

async function fetchFriendIds(): Promise<Set<string>> {
    try {
        const response = await RestAPI.get({ url: "/users/@me/relationships" });
        return new Set<string>(
            (Array.isArray(response.body) ? response.body : [])
                .filter((r: any) => r.type === 1)
                .map((r: any) => String(r.id)),
        );
    } catch {
        return new Set();
    }
}
