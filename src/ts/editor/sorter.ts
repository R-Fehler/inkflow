// The slide list on the left: thumbnails of every slide in deck order, hidden
// slides included (dimmed). Click to edit a slide, drag to reorder, and the
// context menu / "+" button add, duplicate, hide and delete slides. Every
// change is a structured edit of the Deck(slides=[...]) list in deck.py.

import { parseViewBox } from "../shared/viewbox";
import { clear, h, icon, toast } from "./dom";
import { edit } from "./net";
import { ed, emit, on } from "./state";
import type { SlideModel } from "./types";

const list = document.getElementById("sorter-list")!;
const addBtn = document.getElementById("sorter-add")!;
const menu = document.getElementById("context-menu")!;

let dragFrom: number | null = null;

export function gotoSlide(deckIndex: number): void {
    const n = ed.model?.slides.length ?? 0;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, deckIndex));
    if (i === ed.current) return;
    ed.current = i;
    ed.selection = [];
    ed.scope = null;
    emit("slide");
}

function thumb(slide: SlideModel): HTMLElement {
    const box = h("div", { class: "thumb" });
    if (slide.visibleIndex == null) {
        box.append(h("div", { class: "thumb-hidden" }, icon("eyeOff", 18)));
        return box;
    }
    const data = ed.slides[slide.visibleIndex];
    if (!data) return box;
    box.innerHTML = data.svg;
    const svg = box.querySelector("svg");
    if (svg) {
        const vb = parseViewBox(svg.getAttribute("viewBox"));
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.style.aspectRatio = `${vb.w} / ${vb.h}`;
        // Thumbnails show the slide's final state, not its first build step.
        svg.querySelectorAll(".anim-pending").forEach((el) => {
            el.classList.remove("anim-pending");
        });
        svg.querySelectorAll("video").forEach((v) => {
            v.removeAttribute("autoplay");
        });
        // Ids inside thumbnails would shadow the canvas's own for url(#…) lookups
        // only if they came first in the document; the canvas does (see editor.html).
    }
    return box;
}

export function renderSorter(): void {
    clear(list);
    const slides = ed.model?.slides ?? [];
    slides.forEach((slide, i) => {
        const item = h(
            "div",
            {
                class: `sorter-item${i === ed.current ? " active" : ""}${slide.visible ? "" : " hidden-slide"}`,
                draggable: ed.model?.deckEditable ? "true" : null,
                title: slide.title ?? slide.id ?? slide.src,
                "data-index": i,
            },
            h("span", { class: "sorter-num" }, String(i + 1)),
            thumb(slide),
        );
        item.addEventListener("click", () => gotoSlide(i));
        item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            gotoSlide(i);
            openMenu(e.clientX, e.clientY, i);
        });
        item.addEventListener("dragstart", (e) => {
            dragFrom = i;
            e.dataTransfer?.setData("text/plain", String(i));
            item.classList.add("dragging");
        });
        item.addEventListener("dragend", () => {
            dragFrom = null;
            item.classList.remove("dragging");
            list.querySelectorAll(".drop-before, .drop-after").forEach((el) => {
                el.classList.remove("drop-before", "drop-after");
            });
        });
        item.addEventListener("dragover", (e) => {
            if (dragFrom == null) return;
            e.preventDefault();
            const r = item.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            item.classList.toggle("drop-after", after);
            item.classList.toggle("drop-before", !after);
        });
        item.addEventListener("dragleave", () => {
            item.classList.remove("drop-before", "drop-after");
        });
        item.addEventListener("drop", (e) => {
            e.preventDefault();
            if (dragFrom == null) return;
            const r = item.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            let to = after ? i + 1 : i;
            if (dragFrom < to) to -= 1;
            void moveSlide(dragFrom, to);
        });
        list.append(item);
    });
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

async function moveSlide(from: number, to: number): Promise<void> {
    if (from === to) return;
    const result = await edit({ action: "slide", op: "move", from, to });
    if (result.ok) {
        ed.current = to;
        emit("slide");
    }
}

export async function newSlide(
    layout: string | null,
    after = ed.current,
): Promise<void> {
    const result = await edit({
        action: "slide",
        op: "new",
        after,
        layout,
        name: "slide",
    });
    if (result.ok && result.select != null) pendingSelect = result.select;
}

export async function duplicateSlide(i = ed.current): Promise<void> {
    const result = await edit({ action: "slide", op: "duplicate", slide: i });
    if (result.ok && result.select != null) pendingSelect = result.select;
}

export async function deleteSlide(i = ed.current): Promise<void> {
    const slide = ed.model?.slides[i];
    if (!slide) return;
    const name = slide.title ?? slide.id ?? `slide ${i + 1}`;
    if (
        !window.confirm(
            `Delete “${name}” from the deck? (Its files stay on disk.)`,
        )
    ) {
        return;
    }
    const result = await edit({ action: "slide", op: "delete", slide: i });
    if (result.ok) {
        ed.current = Math.max(0, i - 1);
        emit("slide");
    }
}

export async function toggleHidden(i = ed.current): Promise<void> {
    const slide = ed.model?.slides[i];
    if (!slide) return;
    await edit({
        action: "slide",
        op: "hide",
        slide: i,
        hidden: slide.visible,
    });
}

// After an insert, follow the new slide once the rebuild lists it.
let pendingSelect: number | null = null;

function closeMenu(): void {
    menu.classList.remove("open");
    clear(menu);
}

function menuItem(
    label: string,
    fn: () => void,
    disabled = false,
): HTMLElement {
    return h(
        "button",
        {
            type: "button",
            class: "menu-item",
            disabled,
            onclick: () => {
                closeMenu();
                fn();
            },
        },
        label,
    );
}

export function layoutMenu(x: number, y: number, after: number): void {
    clear(menu);
    menu.append(h("div", { class: "menu-title" }, "New slide"));
    menu.append(menuItem("Blank", () => void newSlide(null, after)));
    for (const layout of ed.model?.layouts ?? []) {
        menu.append(
            menuItem(
                `${layout.name}${layout.source === "local" ? "" : ` · ${layout.source}`}`,
                () => void newSlide(layout.name, after),
            ),
        );
    }
    showMenu(x, y);
}

function openMenu(x: number, y: number, i: number): void {
    const slide = ed.model?.slides[i];
    const editable = !!ed.model?.deckEditable;
    clear(menu);
    menu.append(
        menuItem("New slide after…", () => layoutMenu(x, y, i), !editable),
    );
    menu.append(menuItem("Duplicate", () => void duplicateSlide(i), !editable));
    menu.append(
        menuItem(
            slide?.visible ? "Hide (skip in presentation)" : "Show",
            () => void toggleHidden(i),
            !editable,
        ),
    );
    menu.append(menuItem("Delete", () => void deleteSlide(i), !editable));
    showMenu(x, y);
}

function showMenu(x: number, y: number): void {
    menu.classList.add("open");
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

export function initSorter(): void {
    on("model", () => {
        const n = ed.model?.slides.length ?? 0;
        if (pendingSelect != null && pendingSelect < n) {
            ed.current = pendingSelect;
            pendingSelect = null;
            emit("slide");
        }
        if (ed.current >= n) ed.current = Math.max(0, n - 1);
        renderSorter();
    });
    on("slide", renderSorter);
    addBtn.addEventListener("click", (e) => {
        if (!ed.model?.deckEditable) {
            toast(
                "deck.py builds its slides in code; add slides there",
                "error",
            );
            return;
        }
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        layoutMenu(r.left, r.bottom + 4, ed.current);
    });
    document.addEventListener("pointerdown", (e) => {
        if (!menu.contains(e.target as Node)) closeMenu();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
    });
}
