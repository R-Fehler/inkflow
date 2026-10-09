// The canvas's right-click menu, in place of the browser's: on an object, what
// you can do with it (edit, clipboard, arrange, group, crop, hide, lock, open
// its file elsewhere); on the empty slide, paste and the slide's own actions.
// Text being edited and the form fields keep the browser's menu (spelling,
// paste as plain text), and Shift + right-click always gives it.

import {
    canTransform,
    canTypeInto,
    clearSelection,
    enterGroup,
    isZone,
    pick,
    select,
    selectAll,
} from "./canvas";
import { copy, cut, pasteFromClipboard } from "./clipboard";
import { pictureOf, startCrop } from "./crop";
import { clear, h } from "./dom";
import { openGallery } from "./gallery";
import { typeInto } from "./insert";
import { edit } from "./net";
import { isHidden, toggleHidden, toggleLocked } from "./objects";
import { openMenu as openWithMenu } from "./openwith";
import { alignSelection } from "./props";
import { deleteSlide, duplicateSlide, menuItem, showMenu } from "./sorter";
import { currentSlide, ed, emit, sourceOf } from "./state";
import {
    deleteSelection,
    duplicateSelection,
    groupSelection,
    order,
    ungroupSelection,
} from "./toolbar";

const menu = document.getElementById("context-menu")!;
// Where the menu was opened (a follow-up menu opens there too).
let at = { x: 0, y: 0 };

function sep(): HTMLElement {
    return h("div", { class: "menu-sep" });
}

function title(text: string): HTMLElement {
    return h("div", { class: "menu-title" }, text);
}

function objectMenu(): HTMLElement[] {
    const sels = ed.selection.filter((s) => canTransform(s.el));
    const one = sels.length === 1 ? sels[0] : null;
    const el = one?.el ?? null;
    const items: HTMLElement[] = [];
    if (el) {
        if (canTypeInto(el)) {
            items.push(menuItem("Type text into it", () => void typeInto(el)));
        } else if (isZone(el)) {
            items.push(menuItem("Edit text", () => emit("edit-zone")));
        } else if (el.localName === "text") {
            items.push(menuItem("Edit text", () => emit("edit-text")));
        } else if (el.localName === "g") {
            items.push(
                menuItem("Enter group", () =>
                    enterGroup(el as unknown as SVGGElement),
                ),
            );
        }
        if (pictureOf(el)) {
            items.push(menuItem("Crop", () => void startCrop(one!)));
        }
        if (items.length) items.push(sep());
    }
    items.push(
        menuItem("Cut", () => cut()),
        menuItem("Copy", () => copy()),
        menuItem("Paste", () => void pasteFromClipboard()),
        menuItem("Duplicate", () => void duplicateSelection(), !sels.length),
        menuItem("Delete", () => void deleteSelection()),
        sep(),
        menuItem("Bring to front", () => void order("front"), !sels.length),
        menuItem("Bring forward", () => void order("forward"), !sels.length),
        menuItem("Send backward", () => void order("backward"), !sels.length),
        menuItem("Send to back", () => void order("back"), !sels.length),
    );
    if (sels.length > 1) {
        items.push(
            sep(),
            menuItem("Group", () => void groupSelection()),
            title("Align"),
            ...(
                [
                    ["left", "Left edges"],
                    ["center", "Centres (horizontally)"],
                    ["right", "Right edges"],
                    ["top", "Top edges"],
                    ["middle", "Middles (vertically)"],
                    ["bottom", "Bottom edges"],
                ] as const
            ).map(([how, label]) => menuItem(label, () => alignSelection(how))),
        );
    } else if (el?.localName === "g") {
        items.push(
            sep(),
            menuItem("Ungroup", () => void ungroupSelection()),
        );
    }
    if (el && one) {
        const src = sourceOf(one.key);
        items.push(
            sep(),
            menuItem(
                isHidden(el) ? "Show" : "Hide",
                () => void toggleHidden(el),
            ),
            menuItem(
                el.hasAttribute("data-ink-locked") ? "Unlock" : "Lock",
                () => void toggleLocked(el),
            ),
        );
        if (src) {
            const name = src.rel.split("/").pop() ?? src.rel;
            items.push(
                menuItem(`Open ${name} in…`, () => {
                    void openWithMenu(src.path, at.x, at.y);
                }),
            );
        }
    }
    return items;
}

function slideMenu(): HTMLElement[] {
    const slide = currentSlide();
    const editable = !!ed.model?.deckEditable;
    const i = slide?.deckIndex ?? ed.current;
    return [
        menuItem("Paste", () => void pasteFromClipboard()),
        menuItem("Select all", () => selectAll()),
        sep(),
        title("Slide"),
        menuItem(
            "New slide after…",
            () => void openGallery({ mode: "insert", after: ed.current }),
            !editable,
        ),
        menuItem(
            "Change layout…",
            () => {
                const parent =
                    document
                        .querySelector("#slide-host svg")
                        ?.getAttribute("inkflow:parent") ?? null;
                void openGallery({ mode: "change", current: parent });
            },
            !editable,
        ),
        menuItem(
            "Duplicate slide",
            () => void duplicateSlide(ed.current),
            !editable,
        ),
        menuItem(
            slide?.visible === false ? "Show slide" : "Hide slide",
            () =>
                void edit({
                    action: "slide",
                    op: "hide",
                    slide: i,
                    hidden: slide?.visible !== false,
                }),
            !editable,
        ),
        menuItem("Delete slide", () => void deleteSlide(ed.current), !editable),
    ];
}

function onContextMenu(e: MouseEvent): void {
    const target = e.target as Element;
    // The browser's own menu where it is the useful one, or when asked for.
    if (
        e.shiftKey ||
        target.closest("input, textarea, select, [contenteditable]")
    ) {
        return;
    }
    e.preventDefault();
    ed.focus = "canvas";
    at = { x: e.clientX, y: e.clientY };
    const hit = pick(e.clientX, e.clientY);
    if (hit) {
        if (!ed.selection.some((s) => s.el === hit)) select([hit]);
    } else {
        clearSelection();
    }
    clear(menu);
    menu.append(...(hit ? objectMenu() : slideMenu()));
    showMenu(e.clientX, e.clientY);
}

export function initCanvasMenu(): void {
    document
        .getElementById("canvas")
        ?.addEventListener("contextmenu", onContextMenu);
}
