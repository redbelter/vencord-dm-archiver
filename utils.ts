/*
 * DMArchiver - Pure utility functions for unit testing
 * These functions have no Discord dependencies
 */

export const DISCORD_CDN_DOMAINS = ["cdn.discordapp.com", "media.discordapp.net"] as const;

export const URL_IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|mp4|mov|webm|avif|bmp|svg|ogg|mp3|wav|m4a|aac|flac|opus)(?:[?#]|$)/i;

export type UrlCandidate = { url: string; filename?: string; type: "discord" | "external" };

export type SkippedMediaEntry = {
    url: string;
    type?: "discord" | "external";
    reason: string;
    user: string;
    messageId: string;
};

export function isDiscordCdnUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return DISCORD_CDN_DOMAINS.includes(u.hostname as any);
    } catch {
        return false;
    }
}

export function getFileExtensionFromContentType(contentType?: string): string | undefined {
    if (!contentType) return undefined;

    const mime = contentType.split(";")[0].trim().toLowerCase();
    switch (mime) {
        case "image/jpeg": return ".jpg";
        case "image/png": return ".png";
        case "image/gif": return ".gif";
        case "image/webp": return ".webp";
        case "image/avif": return ".avif";
        case "image/bmp": return ".bmp";
        case "image/svg+xml": return ".svg";
        case "image/x-icon":
        case "image/vnd.microsoft.icon":
            return ".ico";
        case "video/mp4": return ".mp4";
        case "video/webm": return ".webm";
        case "video/ogg": return ".ogv";
        case "video/quicktime": return ".mov";
        case "video/x-msvideo": return ".avi";
        case "video/x-matroska": return ".mkv";
        case "audio/mpeg": return ".mp3";
        case "audio/wav": return ".wav";
        case "audio/mp4": return ".m4a";
        case "audio/aac": return ".aac";
        case "audio/flac": return ".flac";
        case "audio/ogg": return ".ogg";
        case "audio/opus": return ".opus";
        default:
            return undefined;
    }
}

export function sanitizeFileName(name: string): string {
    const sanitized = name
        .replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_")
        .replace(/[\s]+/g, "_")
        .replace(/[. ]+$/, "");

    if (!sanitized) return "attachment";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)) return `_${sanitized}`;
    return sanitized.slice(0, 240);
}

export function getFileName(url: string, fallback: string, contentType?: string): string {
    const allowedExt = /\.(?:png|jpe?g|gif|webp|mp4|mov|webm|avif|bmp|svg|ogg|mp3|wav|m4a|aac|flac|opus)$/i;
    const fallbackHasExt = fallback && /\.[^./\\?]+$/.test(fallback);

    try {
        const u = new URL(url);
        let pathName = u.pathname.split("/").filter(Boolean).pop() ?? "";
        if (!pathName || pathName === "." || pathName === "..") {
            pathName = fallback || "attachment";
        }

        let name = pathName || fallback || "attachment";
        if (!allowedExt.test(name)) {
            const extMatch = u.search.match(/(?:png|jpe?g|gif|webp|mp4|mov|webm|avif|bmp|svg|ogg|mp3|wav|m4a|aac|flac|opus)/i);
            const contentExt = getFileExtensionFromContentType(contentType);
            const ext = extMatch?.[0] || contentExt || (fallbackHasExt ? fallback.replace(/^.*[\\/]/, "") : ".jpg");
            if (allowedExt.test(ext)) {
                if (name.endsWith(".")) {
                    name += ext.slice(1);
                } else {
                    name += ext.startsWith(".") ? ext : `.${ext}`;
                }
            } else if (!allowedExt.test(name)) {
                name += contentExt || ".jpg";
            }
        }

        return sanitizeFileName(name);
    } catch {
        return sanitizeFileName(fallback || "attachment");
    }
}

export function formatSkippedMediaReport(entries: SkippedMediaEntry[]): string {
    const discordCount = entries.filter(e => e.type === "discord").length;
    const externalCount = entries.filter(e => e.type === "external").length;

    return entries.map(entry => {
        return [
            `User: ${entry.user}`,
            `Message ID: ${entry.messageId}`,
            `Type: ${entry.type || "unknown"}`,
            `URL: ${entry.url}`,
            `Reason: ${entry.reason}`,
            ""
        ].join("\n");
    }).join("\n") + "\n\n--- Summary ---\nDiscord CDN (uploaded): " + discordCount + "\nExternal links: " + externalCount;
}