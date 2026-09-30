/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 redbelter
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Reusable always-on-top floating window (same UX family as GhostDms' finder):
// draggable titlebar, hide/close + double-click/Esc, right/bottom resize grips
// persisted to localStorage, viewport-clamped so it can never strand off-screen.
// Kept plugin-local (one copy per plugin) so each plugin folder stays
// self-contained for drop-into-src/userplugins distribution.

import { createRoot } from "@webpack/common";
import type { ReactNode } from "react";

export interface FloatingHandle {
    close(): void;
    toggle(): void;
}

interface FloatingOpts {
    /** localStorage prefix for the size (e.g. "MsgPurge" -> MsgPurgeWidth/Height) */
    storageKey: string;
    title: string;
    render(close: () => void): ReactNode;
}

const FLOAT_Z = 2147483000; // above Discord's modals/menus
const MIN_W = 320, MIN_H = 200;

// This renderer context may have NO usable localStorage: the global can be
// absent entirely (bare `localStorage` -> ReferenceError; seen live in
// Discord's renderer — even Vencord avoids the bare global) or throw
// SecurityError in sandboxed contexts. Probe lazily and fall back to a
// module-memory map: persistence degrades to per-session, never crashes.
// NEVER touch bare `localStorage` directly here.
const __memStore = new Map<string, string>();
function nativeStore(): { getItem(k: string): string | null; setItem(k: string, v: string): void; } | null {
    try {
        const s = (globalThis as any).localStorage;
        if (!s) return null;
        s.getItem("\u0000probe"); // sandboxed contexts throw on access, not assignment
        return s;
    } catch { return null; }
}
const store = {
    getItem(k: string): string | null {
        const s = nativeStore();
        if (s) {
            try {
                const v = s.getItem(k);
                return v == null ? (__memStore.get(k) ?? null) : v;
            } catch { /* fall through to memory */ }
        }
        return __memStore.get(k) ?? null;
    },
    setItem(k: string, v: string): void {
        const s = nativeStore();
        if (s) {
            try { s.setItem(k, v); return; } catch { /* fall through to memory */ }
        }
        __memStore.set(k, v);
    },
};

let floating: { root: any; el: HTMLElement; handle: FloatingHandle; } | null = null;

export function closeFloating(): boolean {
    if (!floating) return false;
    floating.handle.close();
    return true;
}

/** true when the open window was just hidden/shown (toggle) instead of created */
export function openFloating(opts: FloatingOpts): boolean {
    if (floating) {
        floating.handle.toggle();
        return true;
    }
    if (typeof document === "undefined" || typeof createRoot !== "function") return false;

    const widthKey = opts.storageKey + "Width";
    const heightKey = opts.storageKey + "Height";
    const saved = (key: string, min: number, fallback: number, viewport: number) => {
        try {
            const v = parseInt(store.getItem(key) ?? "", 10);
            if (Number.isFinite(v) && v >= min) return Math.min(v, viewport - 16);
        } catch { /* no storage */ }
        return fallback;
    };
    const winW = typeof window !== "undefined" ? window.innerWidth : 1920;
    const winH = typeof window !== "undefined" ? window.innerHeight : 1080;

    const el = document.createElement("div") as HTMLElement;
    el.style.cssText = [
        "position:fixed", "top:80px", "right:24px",
        "width:" + saved(widthKey, MIN_W, 460, winW) + "px",
        "display:flex", "flex-direction:column", "z-index:" + FLOAT_Z,
        "background:var(--bg-normal, #18191c)", "border:1px solid var(--border-subtle, #333)",
        "border-radius:10px", "box-shadow:0 8px 30px rgba(0,0,0,.6)", "padding:0",
        "color:var(--header-primary, #fff)",
    ].join(";");
    // starts compact; NO max-height cap — the bottom grip grows it freely
    const sh = saved(heightKey, MIN_H, 0, winH);
    el.style.height = sh ? sh + "px" : "55vh";

    // React replaces ALL children of its container — root it on this inner
    // div; the plain-DOM titlebar/grips live on `el` and survive render().
    const content = document.createElement("div");
    content.style.cssText = "padding:12px;overflow-y:auto;flex:1;min-height:0";
    const contentRoot = createRoot(content);

    let hidden = false;
    const handle: FloatingHandle = {
        close: () => { /* filled below */ },
        toggle: () => {
            hidden = !hidden;
            // NOTE: el.style.display = "" would DELETE the cssText-declared
            // display:flex (inline-style semantics), and the div falls back to
            // display:block — the flex column dies, the content div stops being
            // height-constrained, its scrollbar vanishes and everything
            // overflows the frame. Always restore the EXPLICIT value.
            el.style.display = hidden ? "none" : "flex";
        },
    };
    const onDblClick = (e: MouseEvent) => {
        if (!(e.target as HTMLElement)?.closest?.("button")) handle.close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") handle.close(); };
    handle.close = () => {
        try { contentRoot.unmount(); } catch { /* already gone */ }
        el.remove();
        window.removeEventListener("keydown", onKey);
        floating = null;
    };

    document.body.appendChild(el);
    window.addEventListener("keydown", onKey);
    floating = { root: contentRoot, el, handle };

    // titlebar: drag + hide/close buttons
    const bar = document.createElement("div");
    bar.style.cssText = "padding:10px 14px;font-weight:700;cursor:move;border-bottom:1px solid var(--border-subtle,#333);display:flex;justify-content:space-between;align-items:center;user-select:none";
    const title = document.createElement("span");
    title.textContent = opts.title;
    const btns = document.createElement("span");
    const mk = (label: string, titleTxt: string, fn: () => void, danger = false) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = titleTxt;
        b.style.cssText = "margin-left:6px;width:26px;height:26px;border-radius:6px;border:1px solid var(--border-subtle,#444);"
            + "background:" + (danger ? "#c0392b" : "rgba(255,255,255,.08)") + ";color:#fff;font-size:14px;line-height:1;cursor:pointer";
        b.addEventListener("click", fn);
        btns.appendChild(b);
    };
    mk("–", "hide (the plugin's bar button brings it back; state is kept)", () => handle.toggle());
    mk("✕", "close (" + opts.storageKey.toLowerCase() + " keeps running in the background; double-click the title bar does this too)", () => handle.close(), true);
    bar.appendChild(title);
    bar.appendChild(btns);
    el.appendChild(bar);
    el.appendChild(content);
    contentRoot.render(opts.render(handle.close) as any);

    // right-edge width grip (visible pill straddling the border)
    const gripW = document.createElement("div");
    gripW.title = "drag to resize width";
    gripW.style.cssText = "position:absolute;top:50%;transform:translateY(-50%);right:-8px;"
        + "width:16px;height:52px;cursor:ew-resize;border-radius:8px;user-select:none;"
        + "background:var(--background-tertiary,#111214);border:1px solid var(--interactive-hover,#5865f2);"
        + "box-shadow:0 2px 8px rgba(0,0,0,.5);color:var(--header-primary,#dcddde);font-size:11px;"
        + "display:flex;align-items:center;justify-content:center;letter-spacing:-1px";
    gripW.textContent = "⋮⋮";
    el.appendChild(gripW);

    // bottom-edge height grip
    const gripH = document.createElement("div");
    gripH.title = "drag to resize height";
    gripH.style.cssText = "position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);"
        + "height:16px;width:52px;cursor:ns-resize;border-radius:8px;user-select:none;"
        + "background:var(--background-tertiary,#111214);border:1px solid var(--interactive-hover,#5865f2);"
        + "box-shadow:0 2px 8px rgba(0,0,0,.5);color:var(--header-primary,#dcddde);font-size:11px;"
        + "display:flex;align-items:center;justify-content:center;letter-spacing:-1px";
    gripH.textContent = "⋯";
    el.appendChild(gripH);

    // --- behavior wiring -----------------------------------------------------
    const clamps: Array<() => void> = [];

    const dragCleanup = makeDrag(el, bar, clamps);
    const wCleanup = makeSize(el, gripW, "width", widthKey, MIN_W, clamps);
    const hCleanup = makeSize(el, gripH, "height", heightKey, MIN_H, clamps);

    bar.addEventListener("dblclick", onDblClick);
    const origClose = handle.close;
    handle.close = () => {
        dragCleanup(); wCleanup(); hCleanup();
        bar.removeEventListener("dblclick", onDblClick);
        origClose();
    };

    return false;
}

function clampIntoView(el: HTMLElement) {
    // a partially off-screen titlebar = an unclosable panel — keep it fully inside
    const w = el.getBoundingClientRect().width || 460;
    const left = parseFloat(el.style.left || "0") || 0;
    const top = parseFloat(el.style.top || "0") || 0;
    el.style.left = Math.max(0, Math.min(window.innerWidth - w, left)) + "px";
    el.style.top = Math.max(0, Math.min(window.innerHeight - 44, top)) + "px";
}

function makeDrag(el: HTMLElement, handleEl: HTMLElement, clamps: Array<() => void>) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    const onDown = (e: MouseEvent) => {
        if ((e.target as HTMLElement)?.closest?.("button")) return;
        dragging = true;
        const rect = el.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
        el.style.left = ox + "px";
        el.style.top = oy + "px";
        el.style.right = "auto";
        e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
        if (!dragging) return;
        el.style.left = String(ox + e.clientX - sx) + "px";
        el.style.top = String(oy + e.clientY - sy) + "px";
        clampIntoView(el);
    };
    const onUp = () => { dragging = false; };
    const onResize = () => {
        if (window.innerWidth < 100 || window.innerHeight < 100) return; // minimizing: transient resize with a degenerate viewport — clamping now would strand the panel tiny
        clampIntoView(el);
    };
    clamps.push(onResize);
    handleEl.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    return () => {
        handleEl.removeEventListener("mousedown", onDown);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("resize", onResize);
    };
}

function makeSize(el: HTMLElement, handleEl: HTMLElement, axis: "width" | "height", key: string, min: number, clamps: Array<() => void>) {
    let startA = 0, startSize = 0, resizing = false;
    const off = (e: MouseEvent) => (axis === "width" ? e.clientX : e.clientY);
    const onDown = (e: MouseEvent) => {
        resizing = true;
        const rect = el.getBoundingClientRect();
        startA = off(e);
        startSize = axis === "width" ? rect.width : rect.height;
        if (axis === "width") {
            el.style.left = rect.left + "px";
            el.style.top = rect.top + "px";
            el.style.right = "auto";
        }
        e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
        if (!resizing) return;
        if (axis === "width") {
            const left = parseFloat(el.style.left) || 0;
            const max = Math.max(min, window.innerWidth - left - 8);
            el.style.width = Math.max(min, Math.min(max, startSize + off(e) - startA)) + "px";
        } else {
            const { top } = el.getBoundingClientRect();
            const max = Math.max(min, window.innerHeight - top - 8);
            el.style.height = Math.max(min, Math.min(max, startSize + off(e) - startA)) + "px";
        }
    };
    const onUp = () => {
        if (!resizing) return;
        resizing = false;
        const rect = el.getBoundingClientRect();
        store.setItem(key, String(Math.round(axis === "width" ? rect.width : rect.height)));
    };
    const onResize = () => {
        if (window.innerWidth < 100 || window.innerHeight < 100) return; // minimizing: transient resize with a degenerate viewport — clamping now would strand the panel tiny
        const rect = el.getBoundingClientRect();
        if (axis === "width") {
            const w = parseFloat(el.style.width);
            if (w && w > window.innerWidth) el.style.width = window.innerWidth + "px";
        } else {
            const h = parseFloat(el.style.height);
            if (h && rect.top + h > window.innerHeight) el.style.height = Math.max(min, window.innerHeight - rect.top - 8) + "px";
        }
    };
    clamps.push(onResize);
    handleEl.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    return () => {
        handleEl.removeEventListener("mousedown", onDown);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("resize", onResize);
    };
}
