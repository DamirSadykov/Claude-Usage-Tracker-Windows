import { describe, it, expect } from "vitest";
import { parseReleases, cleanNotes, renderNotes } from "./changelog";

describe("parseReleases", () => {
    it("strips the leading v, trims body, drops drafts and pre-releases", () => {
        const raw = [
            {
                tag_name: "v0.4.7",
                name: "  Release 0.4.7  ",
                body: "  notes  ",
                published_at: "2026-06-11T00:00:00Z",
                html_url: "https://github.com/x/y/releases/tag/v0.4.7",
                draft: false,
                prerelease: false,
            },
            {
                tag_name: "v0.5.0-rc1",
                name: "rc",
                body: "x",
                published_at: null,
                html_url: "u",
                draft: false,
                prerelease: true,
            },
            {
                tag_name: "v0.4.8",
                name: "draft",
                body: "x",
                published_at: null,
                html_url: "u",
                draft: true,
                prerelease: false,
            },
        ];
        const out = parseReleases(raw as any);
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual({
            version: "0.4.7",
            name: "Release 0.4.7",
            body: "notes",
            date: "2026-06-11T00:00:00Z",
            url: "https://github.com/x/y/releases/tag/v0.4.7",
        });
    });

    it("falls back the name to the tag and tolerates missing fields", () => {
        const out = parseReleases([
            {
                tag_name: "v1.0.0",
                name: null,
                body: null,
                published_at: null,
                html_url: "u",
                draft: false,
                prerelease: false,
            },
        ] as any);
        expect(out[0].name).toBe("v1.0.0");
        expect(out[0].body).toBe("");
        expect(out[0].date).toBe("");
    });

    it("returns [] for a non-array payload", () => {
        expect(parseReleases({ message: "Not Found" } as any)).toEqual([]);
    });
});

describe("cleanNotes", () => {
    it("strips the version heading and the installer footer git-cliff appends", () => {
        const body = [
            "## 0.4.7 — 2026-06-11",
            "",
            "### 🚀 Новое",
            "",
            "- Фича (#54)",
            "",
            "---",
            "",
            "Установщик для Windows:",
            "- `.exe` — NSIS installer",
        ].join("\n");
        expect(cleanNotes(body)).toBe(
            ["### 🚀 Новое", "", "- Фича (#54)"].join("\n"),
        );
    });

    it("leaves a plain body untouched apart from trimming", () => {
        expect(cleanNotes("  just text  ")).toBe("just text");
    });
});

describe("renderNotes", () => {
    it("renders headings, bullets, bold and code", () => {
        const html = renderNotes(
            "### Новое\n\n- Пункт с `кодом`\n- **Жирный** пункт",
        );
        expect(html).toContain("<h5>Новое</h5>");
        expect(html).toContain("<li>Пункт с <code>кодом</code></li>");
        expect(html).toContain("<strong>Жирный</strong>");
        expect(html).toContain("<ul>");
    });

    it("escapes HTML before adding markup (no injection)", () => {
        const html = renderNotes("- <script>alert(1)</script>");
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;");
    });

    it("groups consecutive bullets into a single list", () => {
        const html = renderNotes("- a\n- b\n- c");
        expect(html.match(/<ul>/g)).toHaveLength(1);
        expect(html.match(/<li>/g)).toHaveLength(3);
    });
});
