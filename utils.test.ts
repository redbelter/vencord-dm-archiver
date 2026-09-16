import { describe, it, expect } from "vitest";
import {
    isDiscordCdnUrl,
    getFileExtensionFromContentType,
    sanitizeFileName,
    getFileName,
    formatSkippedMediaReport,
    type SkippedMediaEntry,
} from "./utils";

describe("isDiscordCdnUrl", () => {
    it("returns true for Discord CDN domains", () => {
        expect(isDiscordCdnUrl("https://cdn.discordapp.com/attachments/123/file.png")).toBe(true);
        expect(isDiscordCdnUrl("https://media.discordapp.net/attachments/123/file.png")).toBe(true);
    });

    it("returns false for non-Discord domains", () => {
        expect(isDiscordCdnUrl("https://imgur.com/image.png")).toBe(false);
        expect(isDiscordCdnUrl("https://github.com/file.png")).toBe(false);
        expect(isDiscordCdnUrl("not-a-url")).toBe(false);
    });
});

describe("getFileExtensionFromContentType", () => {
    it("returns correct extension for images", () => {
        expect(getFileExtensionFromContentType("image/jpeg")).toBe(".jpg");
        expect(getFileExtensionFromContentType("image/png")).toBe(".png");
        expect(getFileExtensionFromContentType("image/gif")).toBe(".gif");
        expect(getFileExtensionFromContentType("image/webp")).toBe(".webp");
        expect(getFileExtensionFromContentType("image/avif")).toBe(".avif");
    });

    it("returns correct extension for videos", () => {
        expect(getFileExtensionFromContentType("video/mp4")).toBe(".mp4");
        expect(getFileExtensionFromContentType("video/webm")).toBe(".webm");
        expect(getFileExtensionFromContentType("video/quicktime")).toBe(".mov");
    });

    it("returns correct extension for audio", () => {
        expect(getFileExtensionFromContentType("audio/mpeg")).toBe(".mp3");
        expect(getFileExtensionFromContentType("audio/wav")).toBe(".wav");
        expect(getFileExtensionFromContentType("audio/ogg")).toBe(".ogg");
        expect(getFileExtensionFromContentType("audio/opus")).toBe(".opus");
    });

    it("returns undefined for unknown types", () => {
        expect(getFileExtensionFromContentType("application/json")).toBeUndefined();
        expect(getFileExtensionFromContentType(undefined)).toBeUndefined();
        expect(getFileExtensionFromContentType("")).toBeUndefined();
    });
});

describe("sanitizeFileName", () => {
    it("replaces invalid characters", () => {
        expect(sanitizeFileName('file<name>.txt')).toBe("file_name_.txt");
        expect(sanitizeFileName('file:name.txt')).toBe("file_name.txt");
        expect(sanitizeFileName('file"name.txt')).toBe("file_name.txt");
        expect(sanitizeFileName('file/name.txt')).toBe("file_name.txt");
        expect(sanitizeFileName('file\\name.txt')).toBe("file_name.txt");
        expect(sanitizeFileName('file|name.txt')).toBe("file_name.txt");
        expect(sanitizeFileName('file?name.txt')).toBe("file_name.txt");
        expect(sanitizeFileName('file*name.txt')).toBe("file_name.txt");
    });

    it("replaces whitespace with underscore", () => {
        expect(sanitizeFileName("file name.txt")).toBe("file_name.txt");
        expect(sanitizeFileName("file  name.txt")).toBe("file_name.txt");
        expect(sanitizeFileName("\tfile\nname.txt")).toBe("_file_name.txt");
    });

    it("trims trailing dots and spaces", () => {
        expect(sanitizeFileName("file...txt")).toBe("file...txt");
        expect(sanitizeFileName("file.txt ")).toBe("file.txt_");
        expect(sanitizeFileName("file.txt.")).toBe("file.txt");
    });

    it("handles reserved Windows names", () => {
        expect(sanitizeFileName("con")).toBe("_con");
        expect(sanitizeFileName("prn")).toBe("_prn");
        expect(sanitizeFileName("aux")).toBe("_aux");
        expect(sanitizeFileName("nul")).toBe("_nul");
        expect(sanitizeFileName("com1")).toBe("_com1");
        expect(sanitizeFileName("lpt1")).toBe("_lpt1");
    });

    it("returns 'attachment' for empty string", () => {
        expect(sanitizeFileName("")).toBe("attachment");
        expect(sanitizeFileName("   ")).toBe("_");
    });

    it("truncates to 240 chars", () => {
        const longName = "a".repeat(250) + ".txt";
        expect(sanitizeFileName(longName).length).toBeLessThanOrEqual(240);
    });
});

describe("getFileName", () => {
    it("extracts filename from URL", () => {
        expect(getFileName("https://cdn.discordapp.com/attachments/123/image.png", "fallback")).toBe("image.png");
        expect(getFileName("https://media.discordapp.net/files/video.mp4", "fallback")).toBe("video.mp4");
    });

    it("uses fallback when URL has no filename", () => {
        expect(getFileName("https://example.com/", "myfile.txt")).toBe("myfile.txt.jpg");
        expect(getFileName("https://example.com/.", "myfile.txt")).toBe("myfile.txt.jpg");
    });

    it("adds extension from contentType when missing", () => {
        expect(getFileName("https://example.com/file", "fallback", "image/jpeg")).toBe("file.jpg");
        expect(getFileName("https://example.com/file", "fallback", "video/mp4")).toBe("file.mp4");
    });

    it("handles URLs with query params", () => {
        expect(getFileName("https://example.com/file?size=123", "fallback")).toBe("file.jpg");
    });

    it("sanitizes the result", () => {
        expect(getFileName("https://example.com/file<name>.txt", "fallback")).toBe("file%3Cname%3E.txt.jpg");
    });
});

describe("formatSkippedMediaReport", () => {
    it("formats entries correctly", () => {
        const entries: SkippedMediaEntry[] = [
            { url: "https://cdn.discordapp.com/img.png", type: "discord", reason: "failed", user: "User1", messageId: "123" },
            { url: "https://imgur.com/img.png", type: "external", reason: "excluded", user: "User2", messageId: "456" },
        ];

        const report = formatSkippedMediaReport(entries);

        expect(report).toContain("User: User1");
        expect(report).toContain("Message ID: 123");
        expect(report).toContain("Type: discord");
        expect(report).toContain("URL: https://cdn.discordapp.com/img.png");
        expect(report).toContain("Reason: failed");
        expect(report).toContain("User: User2");
        expect(report).toContain("Type: external");
        expect(report).toContain("--- Summary ---");
        expect(report).toContain("Discord CDN (uploaded): 1");
        expect(report).toContain("External links: 1");
    });

    it("handles empty array", () => {
        const report = formatSkippedMediaReport([]);
        expect(report).toContain("Discord CDN (uploaded): 0");
        expect(report).toContain("External links: 0");
    });

    it("handles unknown type", () => {
        const entries: SkippedMediaEntry[] = [
            { url: "https://example.com/img.png", reason: "test", user: "User1", messageId: "123" },
        ];

        const report = formatSkippedMediaReport(entries);
        expect(report).toContain("Type: unknown");
    });
});