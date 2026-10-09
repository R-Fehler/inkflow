// In-place text editing.
//
// SVG <text> has no editable state of its own, so double-clicking one lays a
// borderless textarea over it in the same font and size; committing writes the
// lines back (one tspan per line, as Inkscape does).
//
// A zone filled with Markdown is edited where it stands: its rendered HTML
// becomes contenteditable, with a formatting bar (bold, italics, colours, links,
// lists, tables…), and is written back as Markdown when editing ends (see
// richtext.ts). A zone whose Markdown cannot make that round trip (math, code,
// images, step reveals) opens its source in a pane under the slide instead,
// where the slide re-renders live as you type.

import { clear, h, icon, toast } from "./dom";
import { edit } from "./net";
import { htmlToMarkdown, sameMarkdown, Unsupported } from "./richtext";
import { currentSlide, ed, emit } from "./state";

const layer = document.getElementById("text-layer")!;
const dock = document.getElementById("zone-dock")!;

function closeDock(): void {
    clear(dock);
    document.body.classList.remove("editing-zone");
}

let active: { commit: () => Promise<void>; cancel: () => void } | null = null;

export function isEditingText(): boolean {
    return active !== null;
}

export async function finishTextEdit(): Promise<void> {
    const a = active;
    if (!a) return;
    // Cleared before committing: removing the textarea blurs it, and that blur
    // must find nothing left to finish.
    active = null;
    clear(layer);
    closeDock();
    await a.commit();
}

function cancel(): void {
    const a = active;
    if (!a) return;
    active = null;
    clear(layer);
    closeDock();
    a.cancel();
}

function linesOf(el: Element): string[] {
    const spans = [...el.children].filter((c) => c.localName === "tspan");
    // Text beside the spans means they are inline runs (a bold word), not
    // lines: show it all as one line, as the server will write it.
    const loose = [...el.childNodes].some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim(),
    );
    if (!spans.length || loose) return [el.textContent ?? ""];
    return spans.map((s) => s.textContent ?? "");
}

export function editSvgText(
    el: SVGGraphicsElement,
    sourcePath: string,
    hash: () => string,
    loc: string,
): void {
    void finishTextEdit();
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const ctm = el.getScreenCTM();
    const fontPx =
        parseFloat(style.fontSize) * (ctm ? Math.hypot(ctm.a, ctm.b) : 1);
    const original = linesOf(el);
    const area = h("textarea", {
        class: "svg-text-editor",
        spellcheck: "true",
    });
    area.value = original.join("\n");
    const anchor = style.textAnchor;
    Object.assign(area.style, {
        left: `${rect.left - 6}px`,
        top: `${rect.top - 4}px`,
        minWidth: `${Math.max(rect.width + 24, 80)}px`,
        minHeight: `${rect.height + 8}px`,
        fontSize: `${fontPx}px`,
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        lineHeight: "1.2",
        color: style.fill.startsWith("rgb") ? style.fill : "inherit",
        textAlign:
            anchor === "middle"
                ? "center"
                : anchor === "end"
                  ? "right"
                  : "left",
    });
    const autosize = () => {
        area.style.height = "auto";
        area.style.height = `${area.scrollHeight}px`;
        area.style.width = "auto";
        area.style.width = `${Math.max(area.scrollWidth + 8, rect.width + 24)}px`;
    };
    area.addEventListener("input", autosize);
    el.style.visibility = "hidden";
    layer.append(area);
    autosize();
    area.focus();
    area.select();
    active = {
        commit: async () => {
            el.style.visibility = "";
            const lines = area.value.replace(/\r/g, "").split("\n");
            if (lines.join("\n") === original.join("\n")) return;
            // Preview immediately; the rebuild then replaces it with the real render.
            if (lines.length === 1 && !el.querySelector("tspan")) {
                el.textContent = lines[0];
            }
            await edit({
                action: "svg",
                file: sourcePath,
                hash: hash(),
                ops: [{ kind: "text", loc, lines }],
                label: "Edit text",
            });
        },
        cancel: () => {
            el.style.visibility = "";
        },
    };
    area.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            cancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void finishTextEdit();
        }
    });
    area.addEventListener("blur", () => void finishTextEdit());
}

// ── Markdown zones ──

function wrapSelection(
    area: HTMLTextAreaElement,
    before: string,
    after = before,
): void {
    const { selectionStart: s, selectionEnd: e, value } = area;
    const inner = value.slice(s, e) || "text";
    area.value = value.slice(0, s) + before + inner + after + value.slice(e);
    area.selectionStart = s + before.length;
    area.selectionEnd = s + before.length + inner.length;
    area.dispatchEvent(new Event("input"));
    area.focus();
}

function prefixLines(area: HTMLTextAreaElement, prefix: string): void {
    const { selectionStart: s, selectionEnd: e, value } = area;
    const start = value.lastIndexOf("\n", s - 1) + 1;
    const end = value.indexOf("\n", e);
    const stop = end === -1 ? value.length : end;
    const block = value
        .slice(start, stop)
        .split("\n")
        .map((line) =>
            line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line,
        )
        .join("\n");
    area.value = value.slice(0, start) + block + value.slice(stop);
    area.selectionStart = start;
    area.selectionEnd = start + block.length;
    area.dispatchEvent(new Event("input"));
    area.focus();
}

export function editZoneText(zone: string): void {
    void finishTextEdit();
    const slide = currentSlide();
    if (!slide) return;
    const origin = slide.zoneOrigins?.[zone];
    const original = slide.zoneText?.[zone] ?? "";
    const deckIndex = slide.deckIndex;
    if (!ed.model?.deckEditable && (origin === "deck" || !slide.md)) {
        toast(
            "deck.py builds its slides in code; edit this zone there",
            "error",
        );
        return;
    }
    const area = h("textarea", { class: "zone-editor", spellcheck: "true" });
    area.value = original;
    let sent = original;
    let timer = 0;
    const coalesce = `zone-${deckIndex}-${zone}-${Date.now()}`;
    const send = async () => {
        window.clearTimeout(timer);
        if (area.value === sent) return;
        const before = sent;
        sent = area.value;
        const result = await edit(
            {
                action: "zone-text",
                slide: deckIndex,
                zone,
                text: area.value,
                origin,
                coalesce,
            },
            { retrying: true },
        );
        if (!result.ok) {
            sent = before;
            timer = window.setTimeout(() => void send(), 800);
        }
    };
    area.addEventListener("input", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void send(), 450);
    });
    const button = (name: string, title: string, fn: () => void) =>
        h(
            "button",
            {
                type: "button",
                class: "fmt-btn",
                title,
                onmousedown: (e: Event) => {
                    e.preventDefault();
                    fn();
                },
            },
            name,
        );
    const bar = h(
        "div",
        { class: "zone-toolbar" },
        h("span", { class: "zone-label" }, `${zone} · Markdown`),
        button("B", "Bold (Ctrl+B)", () => wrapSelection(area, "**")),
        button("I", "Italic (Ctrl+I)", () => wrapSelection(area, "*")),
        button("H", "Heading", () => prefixLines(area, "## ")),
        button("•", "Bullet list", () => prefixLines(area, "- ")),
        button("1.", "Numbered list", () => prefixLines(area, "1. ")),
        button("`", "Code", () => wrapSelection(area, "`")),
        button("∑", "Math", () => wrapSelection(area, "$")),
        button("⏵", "Reveal on click: insert a ::step:: marker", () => {
            const pos = area.selectionStart;
            area.value = `${area.value.slice(0, pos)}\n::step::\n${area.value.slice(pos)}`;
            area.dispatchEvent(new Event("input"));
        }),
        h(
            "button",
            {
                type: "button",
                class: "fmt-btn done",
                title: "Done (Ctrl+Enter)",
                onmousedown: (e: Event) => {
                    e.preventDefault();
                    void finishTextEdit();
                },
            },
            icon("select", 13),
            " Done",
        ),
    );
    // Docked under the slide (in place of the notes), so the zone itself stays
    // in view and re-renders live as you type.
    const wrap = h("div", { class: "zone-edit-wrap" }, bar, area);
    dock.append(wrap);
    document.body.classList.add("editing-zone");
    area.focus();
    active = {
        commit: async () => {
            await send();
        },
        cancel: () => {
            window.clearTimeout(timer);
            if (sent !== original) {
                // Escape restores what the zone said when editing began.
                area.value = original;
                void send();
            }
        },
    };
    area.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
            e.preventDefault();
            cancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void finishTextEdit();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
            e.preventDefault();
            wrapSelection(area, "**");
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
            e.preventDefault();
            wrapSelection(area, "*");
        }
    });
    area.addEventListener("blur", (e) => {
        const next = (e as FocusEvent).relatedTarget as Node | null;
        if (next && wrap.contains(next)) return;
        void finishTextEdit();
    });
}

// ── Rich text, in place ──

let richHost: HTMLElement | null = null;

export function editingHost(): Element | null {
    return richHost;
}

/** Edit a zone: in place when its Markdown allows, else in the source pane. */
export function editZone(
    zone: string,
    el: Element | null,
    opts: { at?: { x: number; y: number }; selectAll?: boolean } = {},
): void {
    void finishTextEdit();
    if (el && editZoneRich(zone, el, opts)) return;
    editZoneText(zone);
}

const COLORS = [
    "text",
    "text-muted",
    "accent",
    "red",
    "orange",
    "yellow",
    "green",
    "teal",
    "blue",
    "purple",
    "pink",
    "grey",
];

function editZoneRich(
    zone: string,
    el: Element,
    opts: { at?: { x: number; y: number }; selectAll?: boolean },
): boolean {
    const slide = currentSlide();
    const content = el.querySelector<HTMLElement>(".inkflow-content");
    if (!slide || !content || ed.step != null) return false;
    const origin = slide.zoneOrigins?.[zone];
    if (!ed.model?.deckEditable && (origin === "deck" || !slide.md)) {
        return false;
    }
    let start: string;
    try {
        start = htmlToMarkdown(content);
    } catch {
        return false;
    }
    if (!sameMarkdown(start, slide.zoneText?.[zone] ?? "")) return false;

    const fo = el as SVGGraphicsElement;
    const deckIndex = slide.deckIndex;
    ed.richEditing = true;
    richHost = content;
    fo.classList.add("rich-editing");
    fo.style.overflow = "visible";
    content.contentEditable = "true";
    content.spellcheck = true;
    document.execCommand("defaultParagraphSeparator", false, "p");
    content.focus();
    placeCaret(content, opts);

    const bar = richToolbar(content, () => {
        // Switch to the Markdown source (math, code, reveals…).
        void finishTextEdit().then(() => editZoneText(zone));
    });
    layer.append(bar);
    positionBar(bar, fo);

    const cleanup = () => {
        richHost = null;
        content.contentEditable = "false";
        fo.classList.remove("rich-editing");
        fo.style.overflow = "";
        bar.remove();
        document.removeEventListener("selectionchange", onSelection);
    };
    const onSelection = () => syncToolbar(bar, content);
    document.addEventListener("selectionchange", onSelection);
    syncToolbar(bar, content);

    active = {
        commit: async () => {
            let md: string;
            try {
                md = htmlToMarkdown(content);
            } catch (err) {
                cleanup();
                ed.richEditing = false;
                emit("rerender");
                toast(
                    `Not saved: ${err instanceof Unsupported ? `<${err.message}>` : "this content"} cannot be written as Markdown`,
                    "error",
                );
                return;
            }
            const grow = growOp(fo, content);
            cleanup();
            ed.richEditing = false;
            if (md === start && !grow) {
                emit("rerender");
                return;
            }
            if (!md.trim() && removeEmptyBox(fo, zone, deckIndex)) return;
            const result = await edit({
                action: "zone-text",
                slide: deckIndex,
                zone,
                text: md,
                origin,
                svg: grow,
            });
            if (!result.ok) emit("rerender");
        },
        cancel: () => {
            cleanup();
            ed.richEditing = false;
            // Re-rendering restores what the zone said before editing.
            emit("rerender");
        },
    };

    content.addEventListener("keydown", (e) => {
        e.stopPropagation();
        const mod = e.ctrlKey || e.metaKey;
        if (e.key === "Escape") {
            e.preventDefault();
            cancel();
        } else if (e.key === "Enter" && mod) {
            e.preventDefault();
            void finishTextEdit();
        } else if (mod && e.key.toLowerCase() === "k") {
            e.preventDefault();
            editLink(content);
        } else if (e.key === "Tab") {
            e.preventDefault();
            const cell = caretElement(content)?.closest("td, th");
            if (cell) moveCell(cell, e.shiftKey ? -1 : 1);
            else if (caretElement(content)?.closest("li")) {
                document.execCommand(e.shiftKey ? "outdent" : "indent");
            }
        }
    });
    content.addEventListener("paste", (e) => {
        // Plain text only: pasted HTML would bring markup Markdown cannot hold.
        e.preventDefault();
        const text = e.clipboardData?.getData("text/plain") ?? "";
        document.execCommand("insertText", false, text);
    });
    content.addEventListener("focusout", (e) => {
        const next = e.relatedTarget as Node | null;
        if (next && (bar.contains(next) || content.contains(next))) return;
        if (bar.matches(":hover")) return;
        void finishTextEdit();
    });
    return true;
}

function placeCaret(
    content: HTMLElement,
    opts: { at?: { x: number; y: number }; selectAll?: boolean },
): void {
    const sel = window.getSelection();
    if (!sel) return;
    let range: Range | null = null;
    if (opts.at && !opts.selectAll) {
        range = document.caretRangeFromPoint?.(opts.at.x, opts.at.y) ?? null;
        if (range && !content.contains(range.startContainer)) range = null;
    }
    if (!range) {
        range = document.createRange();
        range.selectNodeContents(content);
        if (!opts.selectAll) range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
}

function positionBar(bar: HTMLElement, fo: Element): void {
    const r = fo.getBoundingClientRect();
    const top = r.top - 44 < 52 ? r.bottom + 8 : r.top - 44;
    bar.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 640))}px`;
    bar.style.top = `${top}px`;
}

// A text box whose text was all deleted goes away, as in any slide editor.
function removeEmptyBox(fo: Element, zone: string, deckIndex: number): boolean {
    const slide = currentSlide();
    const loc = fo.getAttribute("data-ink");
    if (!slide || !loc || !/^text(-\d+)?$/.test(zone)) return false;
    const src = slide.sources?.[parseInt(loc.split(":")[0] ?? "", 10)];
    if (src?.role !== "slide" || slide.srcShared || !src.writable) return false;
    void edit({
        action: "svg",
        file: src.path,
        hash: src.hash,
        zoneSlide: deckIndex,
        ops: [{ kind: "delete", loc }],
        label: "Delete text box",
    });
    return true;
}

// The frame grows to fit text typed past its bottom (the slide's own boxes).
function growOp(
    fo: Element,
    content: HTMLElement,
): Record<string, unknown> | undefined {
    const slide = currentSlide();
    const loc = fo.getAttribute("data-ink");
    if (!slide || !loc || fo.getAttribute("data-ink-tag") !== "rect") return;
    const src = slide.sources?.[parseInt(loc.split(":")[0] ?? "", 10)];
    if (!src?.writable || (src.role === "slide" && slide.srcShared)) return;
    if (src.role !== "slide" && !ed.layoutMode) return;
    const wrapper = content.parentElement;
    const have = parseFloat(fo.getAttribute("height") ?? "0");
    const need = wrapper ? wrapper.scrollHeight : 0;
    if (!have || need <= have + 2) return;
    return {
        file: src.path,
        hash: src.hash,
        ops: [{ kind: "attrs", loc, set: { height: String(Math.ceil(need)) } }],
    };
}

function caretElement(content: HTMLElement): Element | null {
    const sel = window.getSelection();
    const node = sel?.anchorNode ?? null;
    if (!node || !content.contains(node)) return null;
    return node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
}

// ── Formatting commands ──

function changed(content: HTMLElement): void {
    content.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectionRange(content: HTMLElement): Range | null {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    const range = sel.getRangeAt(0);
    return content.contains(range.commonAncestorContainer) ? range : null;
}

function unwrap(el: Element): void {
    el.replaceWith(...el.childNodes);
}

// Wrap the selection in a new element (a colour span, inline code), first
// removing the same kind of wrapper inside it so they never nest.
function wrapRange(
    content: HTMLElement,
    make: (() => HTMLElement) | null,
    same: string,
): void {
    const range = selectionRange(content);
    if (!range || range.collapsed) return;
    const frag = range.extractContents();
    frag.querySelectorAll(same).forEach(unwrap);
    const sel = window.getSelection();
    if (make) {
        const el = make();
        el.append(frag);
        range.insertNode(el);
        range.selectNodeContents(el);
    } else {
        const first = frag.firstChild;
        const last = frag.lastChild;
        range.insertNode(frag);
        if (first && last) {
            range.setStartBefore(first);
            range.setEndAfter(last);
        }
    }
    sel?.removeAllRanges();
    sel?.addRange(range);
    // Remove now-empty wrappers left behind by the split.
    content.querySelectorAll(same).forEach((el) => {
        if (!el.textContent) el.remove();
    });
    changed(content);
}

function setColor(content: HTMLElement, token: string | null): void {
    wrapRange(
        content,
        token ? () => h("span", { class: `inkflow-color-${token}` }) : null,
        'span[class^="inkflow-color-"]',
    );
}

function toggleCode(content: HTMLElement): void {
    const inCode = caretElement(content)?.closest("code");
    if (inCode && content.contains(inCode)) {
        unwrap(inCode);
        changed(content);
        return;
    }
    wrapRange(content, () => h("code", {}), "code");
}

function editLink(content: HTMLElement): void {
    const a = caretElement(content)?.closest("a");
    const range = selectionRange(content);
    const current = a?.getAttribute("href") ?? "";
    const url = window.prompt(
        a
            ? "Link address: https://… or slide:<id> (empty removes the link)"
            : "Link address: https://… or slide:<id>",
        current || "https://",
    );
    if (url == null) return;
    const sel = window.getSelection();
    if (range) {
        sel?.removeAllRanges();
        sel?.addRange(range);
    }
    if (a && !url.trim()) {
        unwrap(a);
    } else if (a) {
        a.setAttribute("href", url.trim());
    } else if (url.trim() && range && !range.collapsed) {
        document.execCommand("createLink", false, url.trim());
    } else if (url.trim()) {
        document.execCommand(
            "insertHTML",
            false,
            `<a href="${encodeURI(url.trim())}">${url.trim().replace(/</g, "&lt;")}</a>`,
        );
    }
    changed(content);
}

// ── Tables ──

function cellOf(content: HTMLElement): HTMLTableCellElement | null {
    const cell = caretElement(content)?.closest("td, th");
    return cell && content.contains(cell)
        ? (cell as HTMLTableCellElement)
        : null;
}

// Tab selects the next cell's text, so typing replaces it.
function focusCell(cell: Element): void {
    const range = document.createRange();
    range.selectNodeContents(cell);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
}

function moveCell(cell: Element, by: number): void {
    const table = cell.closest("table");
    if (!table) return;
    const cells = [...table.querySelectorAll("th, td")];
    const next = cells[cells.indexOf(cell) + by];
    if (next) focusCell(next);
    else if (by > 0) {
        addRow(cell as HTMLTableCellElement);
        const after = [...table.querySelectorAll("th, td")];
        focusCell(after[cells.length]);
    }
}

function newCell(tag: "td" | "th", like?: Element): HTMLTableCellElement {
    const cell = document.createElement(tag);
    const align = (like as HTMLElement | undefined)?.style.textAlign;
    if (align) cell.style.textAlign = align;
    cell.append(document.createElement("br"));
    return cell;
}

function addRow(cell: HTMLTableCellElement): void {
    const row = cell.parentElement as HTMLTableRowElement;
    const table = row.closest("table")!;
    let body = table.tBodies[0];
    if (!body) {
        body = document.createElement("tbody");
        table.append(body);
    }
    const tr = document.createElement("tr");
    for (const c of row.children) tr.append(newCell("td", c));
    if (row.parentElement?.localName === "thead") body.prepend(tr);
    else row.after(tr);
}

function addColumn(cell: HTMLTableCellElement): void {
    const table = cell.closest("table")!;
    const index = cell.cellIndex;
    for (const row of table.rows) {
        const ref = row.cells[index];
        const tag = row.parentElement?.localName === "thead" ? "th" : "td";
        const c = newCell(tag, ref);
        if (ref) ref.after(c);
        else row.append(c);
    }
}

function deleteRow(cell: HTMLTableCellElement): void {
    const row = cell.parentElement as HTMLTableRowElement;
    const table = row.closest("table")!;
    if (table.rows.length <= 1) {
        table.remove();
        return;
    }
    if (row.parentElement?.localName === "thead") {
        // The header row goes: the first body row becomes the header.
        const next = table.tBodies[0]?.rows[0];
        if (!next) return;
        const head = document.createElement("tr");
        for (const c of next.cells) {
            const th = newCell("th", c);
            th.replaceChildren(...c.childNodes);
            head.append(th);
        }
        row.replaceWith(head);
        next.remove();
        return;
    }
    row.remove();
}

function deleteColumn(cell: HTMLTableCellElement): void {
    const table = cell.closest("table")!;
    const index = cell.cellIndex;
    if (table.rows[0]?.cells.length <= 1) {
        table.remove();
        return;
    }
    for (const row of [...table.rows]) row.cells[index]?.remove();
}

function alignColumn(cell: HTMLTableCellElement, align: string): void {
    const table = cell.closest("table")!;
    for (const row of table.rows) {
        const c = row.cells[cell.cellIndex];
        if (c) c.style.textAlign = align;
    }
}

function insertTable(content: HTMLElement): void {
    const head = "<th>Header</th><th>Header</th><th>Header</th>";
    const row = "<td><br></td><td><br></td><td><br></td>";
    document.execCommand(
        "insertHTML",
        false,
        `<table><thead><tr>${head}</tr></thead><tbody><tr>${row}</tr><tr>${row}</tr></tbody></table><p><br></p>`,
    );
    // Start in the new table's first header cell, its placeholder selected.
    // The caret sits in the paragraph inserted after the table.
    const after = caretElement(content)?.closest("p");
    const table = after?.previousElementSibling;
    const first =
        table?.localName === "table" ? table.querySelector("th") : null;
    if (first) {
        const range = document.createRange();
        range.selectNodeContents(first);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
    }
    changed(content);
}

function tableCommand(
    content: HTMLElement,
    fn: (c: HTMLTableCellElement) => void,
): void {
    const cell = cellOf(content);
    if (!cell) return;
    fn(cell);
    changed(content);
    syncToolbar(document.querySelector(".rich-bar") as HTMLElement, content);
}

// ── The formatting bar ──

function richToolbar(content: HTMLElement, toSource: () => void): HTMLElement {
    const btn = (
        label: string | Node,
        title: string,
        fn: () => void,
        cls = "",
    ) =>
        h(
            "button",
            {
                type: "button",
                class: `fmt-btn ${cls}`,
                title,
                onmousedown: (e: Event) => {
                    // Keep the text selection: the bar never takes focus.
                    e.preventDefault();
                    fn();
                    syncToolbar(bar, content);
                },
            },
            label,
        );
    const exec = (cmd: string, value?: string) => () => {
        document.execCommand(cmd, false, value);
        changed(content);
    };
    const block = h("select", { class: "fmt-block", title: "Paragraph style" });
    for (const [v, l] of [
        ["p", "Text"],
        ["h1", "Title"],
        ["h2", "Heading"],
        ["h3", "Subheading"],
        ["blockquote", "Quote"],
    ]) {
        block.append(h("option", { value: v }, l));
    }
    block.addEventListener("mousedown", (e) => e.stopPropagation());
    block.addEventListener("change", () => {
        content.focus();
        document.execCommand("formatBlock", false, `<${block.value}>`);
        changed(content);
    });

    const swatches = h("div", { class: "fmt-colors" });
    const host = content.closest("svg");
    const css = host ? getComputedStyle(host) : null;
    swatches.append(
        btn(
            "A",
            "Default colour",
            () => setColor(content, null),
            "swatch none",
        ),
    );
    for (const t of COLORS) {
        const b = btn("", t, () => setColor(content, t), "swatch");
        b.style.background =
            css?.getPropertyValue(`--inkflow-${t}`).trim() || "currentColor";
        swatches.append(b);
    }
    const colorBtn = btn(
        h("span", { class: "fmt-color-a" }, "A"),
        "Text colour",
        () => swatches.classList.toggle("open"),
    );

    const tableTools = h(
        "span",
        { class: "fmt-table" },
        h("span", { class: "fmt-sep" }),
        btn("+row", "Add a row below", () => tableCommand(content, addRow)),
        btn("+col", "Add a column to the right", () =>
            tableCommand(content, addColumn),
        ),
        btn("−row", "Delete this row", () => tableCommand(content, deleteRow)),
        btn("−col", "Delete this column", () =>
            tableCommand(content, deleteColumn),
        ),
        btn("⇤", "Align column left", () =>
            tableCommand(content, (c) => alignColumn(c, "left")),
        ),
        btn("⇔", "Centre column", () =>
            tableCommand(content, (c) => alignColumn(c, "center")),
        ),
        btn("⇥", "Align column right", () =>
            tableCommand(content, (c) => alignColumn(c, "right")),
        ),
    );

    const bar: HTMLElement = h(
        "div",
        { class: "rich-bar" },
        block,
        h("span", { class: "fmt-sep" }),
        btn(h("b", {}, "B"), "Bold (Ctrl+B)", exec("bold"), "fmt-bold"),
        btn(h("i", {}, "I"), "Italic (Ctrl+I)", exec("italic"), "fmt-italic"),
        btn(
            h("s", {}, "S"),
            "Strikethrough",
            exec("strikeThrough"),
            "fmt-strike",
        ),
        btn("</>", "Inline code", () => toggleCode(content), "fmt-code"),
        h("span", { class: "fmt-color-wrap" }, colorBtn, swatches),
        btn("🔗", "Link (Ctrl+K)", () => editLink(content), "fmt-link"),
        h("span", { class: "fmt-sep" }),
        btn("•", "Bullet list", exec("insertUnorderedList"), "fmt-ul"),
        btn("1.", "Numbered list", exec("insertOrderedList"), "fmt-ol"),
        btn("▦", "Insert a table", () => insertTable(content)),
        tableTools,
        h("span", { class: "fmt-sep" }),
        btn("Tx", "Clear formatting", exec("removeFormat")),
        btn("M↓", "Edit the Markdown source (math, code, reveals…)", toSource),
        btn(
            h("span", {}, icon("select", 13), " Done"),
            "Done (Ctrl+Enter)",
            () => void finishTextEdit(),
            "done",
        ),
    );
    return bar;
}

function syncToolbar(bar: HTMLElement | null, content: HTMLElement): void {
    if (!bar) return;
    const el = caretElement(content);
    const state = (cmd: string) => {
        try {
            return document.queryCommandState(cmd);
        } catch {
            return false;
        }
    };
    const on = (cls: string, v: boolean) =>
        bar.querySelector(`.${cls}`)?.classList.toggle("on", v);
    on("fmt-bold", state("bold"));
    on("fmt-italic", state("italic"));
    on("fmt-strike", state("strikeThrough"));
    on("fmt-code", !!el?.closest("code"));
    on("fmt-link", !!el?.closest("a"));
    on("fmt-ul", !!el?.closest("ul"));
    on("fmt-ol", !!el?.closest("ol"));
    const blockEl = el?.closest("p, h1, h2, h3, h4, h5, h6, blockquote, li");
    const select = bar.querySelector<HTMLSelectElement>(".fmt-block");
    if (select && blockEl) {
        const tag = blockEl.closest("blockquote")
            ? "blockquote"
            : blockEl.localName;
        select.value = ["p", "h1", "h2", "h3", "blockquote"].includes(tag)
            ? tag
            : "p";
    }
    bar.querySelector(".fmt-table")?.classList.toggle(
        "show",
        !!el?.closest("td, th"),
    );
}
