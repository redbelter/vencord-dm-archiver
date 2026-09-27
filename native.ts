/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// DMArchiver native side (main process). Provides direct disk writes and
// downloads that bypass browser sandboxing. All methods return safe values;
// the renderer falls back to fetch / save dialogs when these are unavailable.

import { BrowserWindow, dialog,IpcMainInvokeEvent } from "electron";
import { access, mkdir, writeFile as fsWriteFile } from "fs/promises";
import { join } from "path";

// Strip any path components so a crafted "fileName" can't escape the folder
function safeJoin(folder: string, fileName: string): string {
    const safe = fileName.replace(/[/\\]/g, "_").replace(/\0/g, "_");
    return join(folder, safe);
}

export async function downloadUrl(_: IpcMainInvokeEvent, url: string) {
    try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentType = res.headers.get("content-type") ?? undefined;
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { ok: true as const, bytes, contentType };
    } catch (error) {
        return { ok: false as const, error: String(error) };
    }
}

export async function writeFile(_: IpcMainInvokeEvent, folder: string, fileName: string, data: Uint8Array) {
    try {
        await mkdir(folder, { recursive: true });
        await fsWriteFile(safeJoin(folder, fileName), data);
        return { success: true as const };
    } catch (error) {
        return { success: false as const, error: String(error) };
    }
}

export async function fileExists(_: IpcMainInvokeEvent, folder: string, fileName: string) {
    try {
        await access(safeJoin(folder, fileName));
        return true;
    } catch {
        return false;
    }
}

export async function chooseFolder(event: IpcMainInvokeEvent) {
    try {
        const parent = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const options = { title: "Choose export folder", properties: ["openDirectory" as const, "createDirectory" as const] };
        const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
    } catch {
        return null;
    }
}
