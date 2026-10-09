// Decks as projects: the "deck ▾" menu in the toolbar creates a new deck,
// opens another one or a recent one. The server builds the new deck
// (editor/projects.py) and then serves it instead; the page reloads when the
// model of another deck arrives (net.ts).

import { closeDialog, openDialog } from "./dialog";
import { clear, h, toast } from "./dom";
import { request, whenConnected } from "./net";
import { menuItem, showMenu } from "./sorter";
import { ed, on } from "./state";

const menu = document.getElementById("context-menu")!;
const button = document.getElementById("btn-deck")!;

interface Look {
    id: string;
    label: string;
    description: string;
}

interface DeckInfo {
    repo: string | null;
    parent: string;
    name: string;
    home: string;
    current: string;
    themes: Look[];
    git: boolean;
    lfs: boolean;
    recent: string[];
}

interface Folder {
    path: string;
    parent: string | null;
    dirs: string[];
    files?: { name: string; size: number }[];
    isDeck: boolean;
    repo: string | null;
    home: string;
}

export function megabytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function baseName(path: string): string {
    return (
        path
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .pop() ?? path
    );
}

function join(dir: string, name: string): string {
    return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

function slug(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48) || "my-deck"
    );
}

function renderButton(): void {
    const dir = ed.model?.projectDir;
    button.textContent = `${dir ? baseName(dir) : "deck"} ▾`;
    button.title = dir ? `${dir}\nDecks: new, open, recent` : "Decks";
}

async function info(): Promise<DeckInfo | null> {
    const res = await request({ action: "project-info" });
    if (!res.ok) {
        toast(res.error ?? "Cannot read the deck's folder", "error");
        return null;
    }
    return res as unknown as DeckInfo;
}

async function openMenu(): Promise<void> {
    const data = await info();
    if (!data) return;
    clear(menu);
    menu.append(
        menuItem("New deck…", () => newDeckDialog(data)),
        menuItem("Open deck…", () => openDeckDialog(data)),
    );
    if (data.recent.length) {
        menu.append(h("div", { class: "menu-title" }, "Recent decks"));
        for (const path of data.recent) {
            const dir = path.replace(/[\\/]deck\.py$/, "");
            const item = menuItem(baseName(dir), () => void openDeck(path));
            item.title = dir;
            menu.append(item);
        }
    }
    const r = button.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4);
}

async function openDeck(path: string): Promise<boolean> {
    const res = await request({ action: "open-deck", path });
    if (!res.ok) {
        toast(res.error ?? "Cannot open that deck", "error");
        return false;
    }
    closeDialog();
    toast(
        `Opening ${baseName(String(res.deck ?? path).replace(/[\\/]deck\.py$/, ""))}…`,
    );
    return true;
}

// ── Folder picker ──

// Browses the server's folders (a browser cannot name a path on disk).
export function folderPicker(
    start: string,
    onChange: (folder: Folder) => void,
    // Also list files of a kind ("video", "media"), each picked with onFile.
    files?: { kind: string; onFile: (path: string) => void },
): { el: HTMLElement; current: () => Folder | null } {
    let folder: Folder | null = null;
    const path = h("input", {
        type: "text",
        class: "folder-path",
        spellcheck: "false",
    }) as HTMLInputElement;
    const list = h("div", { class: "folder-list" });
    const where = h("div", { class: "hint folder-where" });
    const go = async (target: string) => {
        const res = await request({
            action: "browse",
            path: target,
            files: files?.kind,
        });
        if (!res.ok) {
            where.textContent = res.error ?? "Cannot open that folder";
            return;
        }
        folder = res as unknown as Folder;
        path.value = folder.path;
        clear(list);
        if (folder.parent) {
            list.append(
                h(
                    "button",
                    {
                        type: "button",
                        class: "folder up",
                        onclick: () => void go(folder?.parent ?? ""),
                    },
                    "↑ ..",
                ),
            );
        }
        for (const name of folder.dirs) {
            list.append(
                h(
                    "button",
                    {
                        type: "button",
                        class: "folder",
                        onclick: () => void go(join(folder?.path ?? "", name)),
                    },
                    `📁 ${name}`,
                ),
            );
        }
        for (const f of folder.files ?? []) {
            list.append(
                h(
                    "button",
                    {
                        type: "button",
                        class: "folder file",
                        onclick: () =>
                            files?.onFile(join(folder?.path ?? "", f.name)),
                    },
                    `🎞 ${f.name}`,
                    h("span", { class: "hint file-size" }, megabytes(f.size)),
                ),
            );
        }
        if (!folder.dirs.length && !folder.parent && !folder.files?.length) {
            list.append(h("p", { class: "hint" }, "No folders here."));
        }
        where.textContent = folder.repo
            ? `In the git repository at ${folder.repo}`
            : "Not in a git repository";
        onChange(folder);
    };
    path.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void go(path.value);
        }
    });
    const el = h(
        "div",
        { class: "folder-picker" },
        h(
            "div",
            { class: "folder-bar" },
            path,
            h(
                "button",
                {
                    type: "button",
                    class: "pbtn",
                    title: "Your home folder",
                    onclick: () => void go(folder?.home ?? "~"),
                },
                "Home",
            ),
        ),
        list,
        where,
    );
    void go(start);
    return { el, current: () => folder };
}

// ── New deck ──

function newDeckDialog(data: DeckInfo): void {
    const title = h("input", {
        type: "text",
        value: "My presentation",
    }) as HTMLInputElement;
    const name = h("input", {
        type: "text",
        value: data.name,
    }) as HTMLInputElement;
    let nameEdited = false;
    name.addEventListener("input", () => {
        nameEdited = true;
        update();
    });
    title.addEventListener("input", () => {
        if (!nameEdited) name.value = slug(title.value);
        update();
    });

    let look = data.themes.some((t) => t.id === "current")
        ? "current"
        : "starter";
    const looks = h(
        "div",
        { class: "look-list" },
        ...data.themes.map((t) => {
            const radio = h("input", {
                type: "radio",
                name: "deck-look",
                value: t.id,
            }) as HTMLInputElement;
            radio.checked = t.id === look;
            radio.addEventListener("change", () => {
                look = t.id;
            });
            return h(
                "label",
                { class: "look" },
                radio,
                h(
                    "span",
                    { class: "look-text" },
                    h("strong", {}, t.label),
                    h("span", { class: "hint" }, t.description),
                ),
            );
        }),
    );

    const git = h("input", { type: "checkbox" }) as HTMLInputElement;
    git.checked = true;
    git.addEventListener("change", () => update());
    const gitRow = h(
        "label",
        { class: "check-row" },
        git,
        "Create a git repository for this deck",
    );
    const gitNote = h("p", { class: "hint" });
    // Git LFS for videos, images and fonts, or git only (a small repository).
    const lfs = h("input", { type: "checkbox" }) as HTMLInputElement;
    lfs.checked = data.lfs;
    const lfsRow = h(
        "label",
        { class: "check-row" },
        lfs,
        "Store videos, images and fonts with Git LFS",
    );
    const lfsNote = h(
        "p",
        { class: "hint" },
        data.lfs
            ? "Untick for git only: media is kept in git itself, fine for a small repository."
            : "git-lfs is not installed, so this deck uses git only (its .gitattributes says so; install git-lfs to switch later).",
    );
    const full = h("p", { class: "hint full-path" });
    const picker = folderPicker(data.parent, () => update());

    function update(): void {
        const folder = picker.current();
        const parent = folder?.path ?? data.parent;
        full.textContent = `New deck: ${join(parent, name.value || "…")}`;
        const inRepo = !!folder?.repo;
        gitRow.hidden = inRepo || !data.git;
        lfsRow.hidden = !data.git || (!inRepo && !git.checked);
        lfsNote.hidden = lfsRow.hidden;
        gitNote.textContent = inRepo
            ? `It becomes a new folder of the git repository at ${folder?.repo}, versioned with it.`
            : data.git
              ? ""
              : "git is not installed, so the deck gets no repository.";
    }

    const create = h(
        "button",
        { type: "button", class: "pbtn primary" },
        "Create and open",
    ) as HTMLButtonElement;
    create.addEventListener("click", async () => {
        const folder = picker.current();
        if (!folder || !name.value.trim()) {
            toast("Choose a folder and a name for the deck", "error");
            return;
        }
        create.disabled = true;
        create.textContent = "Creating…";
        const res = await request({
            action: "new-deck",
            path: join(folder.path, name.value.trim()),
            title: title.value,
            theme: look,
            git: !folder.repo && git.checked,
            lfs: lfs.checked,
        });
        create.disabled = false;
        create.textContent = "Create and open";
        if (!res.ok) {
            toast(res.error ?? "Could not create the deck", "error");
            return;
        }
        closeDialog();
        toast(`Created ${name.value.trim()}; opening it…`, "ok");
    });

    openDialog(
        "New deck",
        h(
            "div",
            { class: "deck-form" },
            h(
                "label",
                { class: "field" },
                h("span", { class: "field-label" }, "Title"),
                title,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Look"),
                looks,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Where"),
                h(
                    "div",
                    {},
                    picker.el,
                    h(
                        "label",
                        { class: "field inline" },
                        h("span", { class: "field-label" }, "Folder name"),
                        name,
                    ),
                    full,
                    gitRow,
                    gitNote,
                    lfsRow,
                    lfsNote,
                ),
            ),
            h("div", { class: "btn-row end" }, create),
        ),
        { wide: true },
    );
    update();
    title.select();
}

// ── Open deck ──

function openDeckDialog(data: DeckInfo): void {
    const open = h(
        "button",
        { type: "button", class: "pbtn primary", disabled: true },
        "Open this deck",
    ) as HTMLButtonElement;
    const picker = folderPicker(
        data.current.replace(/[\\/][^\\/]*$/, ""),
        (f) => {
            open.disabled = !f.isDeck;
            open.textContent = f.isDeck
                ? `Open ${baseName(f.path)}`
                : "No deck.py in this folder";
        },
    );
    open.addEventListener("click", () => {
        const f = picker.current();
        if (f?.isDeck) void openDeck(join(f.path, "deck.py"));
    });
    openDialog(
        "Open deck",
        h(
            "div",
            { class: "deck-form" },
            h("p", { class: "hint" }, "Go to a folder with a deck.py in it."),
            picker.el,
            h("div", { class: "btn-row end" }, open),
        ),
        { wide: true },
    );
}

// ── Start page ──
//
// The editor without a deck (`inkflow edit --start`, the desktop launcher):
// a new deck, another one from a folder, or a recent one. The server then
// serves that deck and the page reloads into it (net.ts).

export async function showStart(): Promise<void> {
    document.body.classList.add("start-mode");
    await whenConnected();
    const data = await info();
    const recent = h("div", { class: "start-recent" });
    if (data?.recent.length) {
        recent.append(h("h2", {}, "Recent decks"));
        for (const path of data.recent) {
            const dir = path.replace(/[\\/]deck\.py$/, "");
            recent.append(
                h(
                    "button",
                    {
                        type: "button",
                        class: "start-deck",
                        title: dir,
                        onclick: () => void openDeck(path),
                    },
                    h("span", { class: "start-deck-name" }, baseName(dir)),
                    h("span", { class: "start-deck-path" }, dir),
                ),
            );
        }
    }
    const action = (label: string, hint: string, fn: () => void) =>
        h(
            "button",
            { type: "button", class: "start-action", onclick: fn },
            h("span", { class: "start-action-label" }, label),
            h("span", { class: "start-action-hint" }, hint),
        );
    const page = h(
        "div",
        { id: "start", class: "start" },
        h(
            "div",
            { class: "start-card" },
            h("div", { class: "start-logo" }, "ink", h("b", {}, "flow")),
            h(
                "p",
                { class: "start-lead" },
                "Slides you draw, write and version.",
            ),
            h(
                "div",
                { class: "start-actions" },
                action("New deck…", "Start from one of four looks", () => {
                    if (data) newDeckDialog(data);
                }),
                action("Open deck…", "A folder with a deck.py", () => {
                    if (data) openDeckDialog(data);
                }),
            ),
            recent,
        ),
    );
    document.body.append(page);
}

export function initDecks(): void {
    button.addEventListener("click", () => void openMenu());
    on("model", renderButton);
    renderButton();
}
