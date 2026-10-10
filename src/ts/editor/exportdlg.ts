// The Export dialog: the deck as a web page (a folder), a single HTML file or
// a PDF, the same builds as `inkflow build` and `inkflow export`. Each result
// is saved in the project and offered for download.

import { openDialog } from "./dialog";
import { h } from "./dom";
import { request } from "./net";
import { ed } from "./state";

const FORMATS: {
    format: "html" | "single" | "pdf";
    title: string;
    text: string;
    placeholder: (stem: string) => string;
}[] = [
    {
        format: "html",
        title: "Web page",
        text: "A folder with index.html and the deck's images and videos. Opens offline in any browser, or upload it to any web host.",
        placeholder: () => "build",
    },
    {
        format: "single",
        title: "Single HTML file",
        text: "Everything in one file, images included: easy to email or share. Larger than the folder.",
        placeholder: (stem) => `${stem}.html`,
    },
    {
        format: "pdf",
        title: "PDF",
        text: "One page per slide, every build step shown. Needs Chromium or Chrome on this computer.",
        placeholder: (stem) => `${stem}.pdf`,
    },
];

function size(bytes: number): string {
    if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function option(f: (typeof FORMATS)[number], stem: string): HTMLElement {
    const output = h("input", {
        type: "text",
        placeholder: f.placeholder(stem),
        spellcheck: "false",
        title: "Where to save it, relative to deck.py",
    });
    const status = h("div", { class: "export-status" });
    const go = h("button", { type: "button", class: "pbtn primary" }, "Export");
    go.addEventListener("click", async () => {
        go.disabled = true;
        status.textContent =
            f.format === "pdf" ? "Rendering pages…" : "Building…";
        status.className = "export-status busy";
        const result = await request({
            action: "export",
            format: f.format,
            output: output.value.trim() || null,
        });
        go.disabled = false;
        if (!result.ok) {
            status.className = "export-status error";
            status.textContent = result.error ?? "export failed";
            return;
        }
        const r = result as unknown as {
            rel: string;
            download: string;
            size: number;
        };
        status.className = "export-status done";
        status.replaceChildren(
            h("span", {}, `Saved to ${r.rel} · ${size(r.size)}`),
            h(
                "a",
                { href: r.download, class: "pbtn", download: "" },
                f.format === "html" ? "Download .zip" : "Download",
            ),
        );
    });
    return h(
        "div",
        { class: "export-option" },
        h(
            "div",
            { class: "export-text" },
            h("strong", {}, f.title),
            h("p", { class: "hint" }, f.text),
        ),
        h("div", { class: "export-row" }, output, go),
        status,
    );
}

export function openExport(): void {
    const stem =
        ed.model?.deckPath.split(/[\\/]/).pop()?.replace(/\.py$/, "") ?? "deck";
    openDialog(
        "Export",
        h(
            "div",
            { class: "export-body" },
            ...FORMATS.map((f) => option(f, stem)),
        ),
        { hint: "Saved next to deck.py; the paths can be changed" },
    );
}

export function initExport(): void {
    document
        .getElementById("btn-export")
        ?.addEventListener("click", openExport);
}
