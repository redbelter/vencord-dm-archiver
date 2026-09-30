/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// DmLedger native side (main process): reads a Discord data-package folder
// (the "Request a copy of your data" output: Messages/<id>/channel.json etc.)
// and enumerates every DM conversation it contains — including DM channels the
// live /users/@me/channels API no longer returns. Read-only: never writes.

import { BrowserWindow, dialog } from "electron";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface PackageDm {
    channelId: string;
    recipientId: string; // the partner (me excluded)
    name?: string; // resolved from any name source we harvested
}

export interface PackageScan {
    ok: boolean;
    error?: string;
    /** Account id this package belongs to (Account/user.json) */
    meId?: string;
    dms?: PackageDm[];
    /** how many Group DMs were found but skipped (not openable by id alone) */
    groupDms?: number;
    /** every id we learned a display name for, from any source */
    names?: Record<string, string>;
    /** ids that were friends at export time (relationship type 1) */
    friends?: string[];
    totalChannelDirs?: number;
}

function readJson(path: string): any {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return null;
    }
}

// The zip arrives un-unzipped as "html.zip" — nothing to do there; caller
// gets a clear hint.
function looksLikeZip(path: string): boolean {
    return /\.zip$/i.test(path);
}

/**
 * Harvest id -> display-name from every source the package offers, in
 * priority order (later sources don't override earlier better ones):
 *   1. Account/user.json relationships (friend profiles, global_name preferred)
 *   2. Messages/index.json labels ("Unknown user" labels are ignored)
 *   3. Servers/<guild>/members.json profile objects
 */
function harvestNames(root: string): { names: Record<string, string>; meId: string | null; friends: string[] } {
    const names: Record<string, string> = {};
    const friends: string[] = [];
    const put = (id: unknown, name: unknown) => {
        const i = id == null ? "" : String(id);
        const n = typeof name === "string" ? name.trim() : "";
        if (/^[0-9]{5,25}$/.test(i) && n && n !== "?" && !/^Unknown /i.test(n) && !(i in names)) {
            names[i] = n;
        }
    };

    let meId: string | null = null;
    const acct = readJson(join(root, "Account", "user.json"));
    if (acct?.id) meId = String(acct.id);
    // relationships: array of { id, type, user: { id, username, global_name } }
    for (const r of Array.isArray(acct?.relationships) ? acct.relationships : []) {
        const u = r?.user;
        if (u?.id) put(u.id, u.global_name ?? u.username);
        // type 1 = FRIEND in the relationships array
        if (r?.type === 1 && u?.id) friends.push(String(u.id));
    }

    const idx = readJson(join(root, "Messages", "index.json"));
    if (idx && typeof idx === "object") {
        for (const [id, label] of Object.entries(idx)) {
            // labels come as "Direct Message with <name>" — keep the name only
            put(id, typeof label === "string" ? label.replace(/^Direct (Group )?Message with /i, "") : label);
        }
    }

    const serversDir = join(root, "Servers");
    if (existsSync(serversDir)) {
        for (const gid of readdirSync(serversDir)) {
            const members = readJson(join(serversDir, gid, "members.json"));
            for (const m of Array.isArray(members) ? members : []) {
                const u = m?.user;
                if (u?.id) put(u.id, u.global_name ?? u.username);
            }
        }
    }
    return { names, meId, friends };
}

/**
 * Scan a request-your-data package root (the folder containing Messages/).
 * Returns every DM (type 1) channel: the live API omits some — the package
 * never does, it's the full history.
 */
export async function scanPackage(_event: any, rootRaw: unknown): Promise<PackageScan> {
    const root = String(rootRaw ?? "").replace(/^["']+|["']+$/g, "").trim();
    if (!root || looksLikeZip(root)) {
        return { ok: false, error: root ? "That's a zip file — unzip it first, then pick the extracted folder." : "No folder chosen." };
    }
    const msgsDir = join(root, "Messages");
    if (!existsSync(msgsDir)) {
        return { ok: false, error: "No Messages\\ folder there. Pick the root of the extracted request-your-data package (the folder that contains Messages)." };
    }

    try {
        const { names, meId, friends } = harvestNames(root);
        const dms: PackageDm[] = [];
        let groupDms = 0;
        let total = 0;

        for (const dirName of readdirSync(msgsDir)) {
            const ch = readJson(join(msgsDir, dirName, "channel.json"));
            if (!ch) continue;
            total++;
            const channelId = String(ch.id ?? dirName.replace(/^c/, ""));
            // Exports store type as a string ("DM"); some tools use numbers (1/3)
            const ctype = String(ch.type ?? "");
            if (ctype === "GROUP_DM" || ctype === "3") {
                groupDms++;
                continue;
            }
            if (ctype !== "DM" && ctype !== "1") continue;

            const recips = (ch.recipients ?? []) as any[];
            const partner = recips.find(r => String(r?.id ?? r) !== meId) ?? recips[0];
            const recipientId = partner == null ? "" : String(partner?.id ?? partner);
            if (!/^[0-9]{1,25}$/.test(recipientId)) continue;

            const name = names[recipientId] ?? names[channelId];
            dms.push({ channelId, recipientId, ...(name ? { name } : {}) });
        }

        return { ok: true, meId: meId ?? undefined, dms, groupDms, names, friends, totalChannelDirs: total };
    } catch (e) {
        return { ok: false, error: `Scan failed: ${String(e)}` };
    }
}

export async function chooseFolder(_event: any): Promise<{ path: string | null; error?: string }> {
    try {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
        const opts = { title: "Pick your extracted Discord data package", properties: ["openDirectory" as const] };
        const res = win
            ? await dialog.showOpenDialog(win, opts)
            : await dialog.showOpenDialog(opts);
        if (res.canceled || !res.filePaths?.[0]) return { path: null };
        return { path: res.filePaths[0] };
    } catch (e) {
        return { path: null, error: String(e) };
    }
}
