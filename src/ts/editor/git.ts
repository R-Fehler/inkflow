// Version control from the editor: the toolbar's git button shows the branch
// and how many files changed; its menu commits (with a dated message to
// change), pushes, pulls, discards changes, takes back the last commit,
// switches or creates branches and browses the deck's history (view an old
// version, revert a commit, restore the deck to it). The server runs git
// (editor/gitops.py); files it changes reach the editor through the usual
// rebuild.

import { closeDialog, openDialog } from "./dialog";
import { clear, h, toast } from "./dom";
import { connected, request } from "./net";
import { menuItem, showMenu } from "./sorter";
import { ed, emit, on } from "./state";

const menu = document.getElementById("context-menu")!;
const button = document.getElementById("btn-git") as HTMLButtonElement;
const label = button.querySelector(".git-label") as HTMLElement;
const badge = button.querySelector(".git-badge") as HTMLElement;

interface Change {
    path: string;
    status: string;
    inDeck: boolean;
}

interface Status {
    repo: boolean;
    git: boolean;
    root?: string;
    scope?: string;
    branch?: string | null;
    detached?: string | null;
    hasCommits?: boolean;
    upstream?: string | null;
    ahead?: number;
    behind?: number;
    remotes?: string[];
    changes?: Change[];
    last?: { sha: string; subject: string; when: string } | null;
    identity?: boolean;
    canUndoCommit?: boolean;
    lfs?: Lfs;
    suggestedMessage?: string;
}

interface LfsFile {
    path: string;
    size: number;
    kind: string;
}

interface Lfs {
    installed: boolean;
    // "on": LFS rules apply to the deck; "off": it opted out (git only).
    mode: "on" | "off" | "none";
    uncovered: LfsFile[];
    unconverted: LfsFile[];
}

interface Commit {
    sha: string;
    short: string;
    author: string;
    when: string;
    subject: string;
    refs: string[];
    head: boolean;
}

let status: Status = { repo: false, git: false };

function render(): void {
    button.hidden = !status.git;
    if (!status.repo) {
        label.textContent = "Git";
        badge.hidden = true;
        button.title = "Not versioned: create a git repository for this deck";
        return;
    }
    label.textContent = status.branch ?? `@${status.detached ?? "?"}`;
    const n = status.changes?.length ?? 0;
    const lfsIssues = lfsFiles().length;
    button.classList.toggle("warn", lfsIssues > 0);
    badge.hidden = n === 0 && lfsIssues === 0;
    badge.textContent = n ? String(n) : "!";
    const sync = [
        status.ahead ? `${status.ahead} to push` : "",
        status.behind ? `${status.behind} to pull` : "",
    ]
        .filter(Boolean)
        .join(", ");
    button.title = [
        status.branch
            ? `Branch ${status.branch}`
            : `Viewing ${status.detached}`,
        n ? `${n} changed file${n === 1 ? "" : "s"}` : "No changes",
        sync,
        lfsIssues
            ? `${lfsIssues} media file${lfsIssues === 1 ? "" : "s"} not in Git LFS`
            : "",
    ]
        .filter(Boolean)
        .join(" · ");
}

export async function refreshGit(): Promise<Status> {
    // Asked again once connected: the server sends a model then.
    if (!connected()) return status;
    const res = await request({ action: "git", op: "status" });
    if (res.ok && res.git) status = res.git as Status;
    render();
    return status;
}

// Operations that change the deck's files on disk: afterwards the editor's
// undo/redo history no longer matches them and starts over (the server says
// so with `historyCleared`). The first one in a session says so first.
const REWRITES = new Set([
    "discard",
    "pull",
    "switch",
    "view",
    "revert",
    "restore",
    "create-branch",
]);
const NOTICE_KEY = "inkflow-git-undo-notice";
let noticeShown = false;

function undoNoticeDue(): boolean {
    try {
        return sessionStorage.getItem(NOTICE_KEY) !== "1" && !noticeShown;
    } catch {
        return !noticeShown;
    }
}

function undoNoticeShown(): void {
    noticeShown = true;
    try {
        sessionStorage.setItem(NOTICE_KEY, "1");
    } catch {
        // private mode: remembered for this page only
    }
}

const UNDO_NOTICE =
    "Note: git changes the deck's files on disk, so the editor's undo and redo history is cleared afterwards (Ctrl+Z cannot go back past this point). You are told this once per session.";

/** Run one git operation; returns its result (status refreshed) or null.
 * `question` is asked first (with the undo notice, when due). */
async function git(
    op: string,
    args: Record<string, unknown> = {},
    question = "",
): Promise<Record<string, unknown> | null> {
    const notice = REWRITES.has(op) && undoNoticeDue();
    if (question || notice) {
        const text = [question, notice ? UNDO_NOTICE : ""]
            .filter(Boolean)
            .join("\n\n");
        if (!confirm(question ? text : `${text}\n\nContinue?`)) return null;
        if (notice) undoNoticeShown();
    }
    button.classList.add("busy");
    const res = await request({ action: "git", op, ...args });
    button.classList.remove("busy");
    if (res.git) {
        status = res.git as Status;
        render();
    }
    if (!res.ok) {
        toast(res.error ?? `git ${op} failed`, "error");
        return null;
    }
    if (typeof res.message === "string") toast(res.message, "ok");
    if (res.historyCleared) {
        ed.canUndo = false;
        ed.canRedo = false;
        emit("history");
    }
    return res;
}

// ── Menu ──

async function openMenu(): Promise<void> {
    await refreshGit();
    clear(menu);
    if (!status.repo) {
        menu.append(
            h("div", { class: "menu-title" }, "Not versioned"),
            menuItem("Create a git repository", async () => {
                if (await git("init"))
                    toast("This deck is now versioned with git", "ok");
            }),
            menuItem("Create a git repository (git only, no LFS)", async () => {
                if (await git("init", { lfs: false }))
                    toast("This deck is now versioned with git", "ok");
            }),
        );
    } else {
        const n = status.changes?.length ?? 0;
        const deckChanges = (status.changes ?? []).filter((c) => c.inDeck);
        const where = status.branch
            ? `On ${status.branch}`
            : `Viewing ${status.detached} (no branch)`;
        menu.append(
            h(
                "div",
                { class: "menu-title" },
                `${where} · ${n ? `${n} change${n === 1 ? "" : "s"}` : "no changes"}`,
            ),
        );
        if (status.last) {
            menu.append(
                h(
                    "div",
                    { class: "menu-note" },
                    `Last: ${status.last.subject} (${status.last.when})`,
                ),
            );
        }
        const lfsCount = lfsFiles().length;
        if (lfsCount) {
            const item = menuItem(
                `⚠ ${lfsCount} media file${lfsCount === 1 ? "" : "s"} not in Git LFS…`,
                () => lfsDialog(),
            );
            item.classList.add("warn");
            menu.append(item);
        } else if (status.lfs?.mode === "on" && !status.lfs.installed) {
            menu.append(
                h(
                    "div",
                    { class: "menu-note warn" },
                    "git-lfs is not installed: this deck's media needs it",
                ),
            );
        }
        menu.append(
            menuItem(
                "Commit…",
                () => commitDialog(),
                n === 0 || !status.branch,
            ),
            menuItem(
                status.ahead ? `Push (${status.ahead})` : "Push",
                () => void git("push"),
                !status.remotes?.length || !status.branch,
            ),
            menuItem(
                status.behind ? `Pull (${status.behind})` : "Pull",
                () => void git("pull"),
                !status.upstream,
            ),
            menuItem(
                "Discard changes…",
                () => discardDialog(),
                deckChanges.length === 0,
            ),
            menuItem(
                "Undo last commit",
                async () => {
                    if (
                        await git(
                            "undo-commit",
                            {},
                            `Take back "${status.last?.subject}"? Its changes stay, uncommitted.`,
                        )
                    )
                        toast(
                            "Last commit taken back; its changes are kept",
                            "ok",
                        );
                },
                !status.canUndoCommit,
            ),
            h("div", { class: "menu-sep" }),
            menuItem(
                status.branch ? "Branches…" : "Back to a branch…",
                () => void branchesDialog(),
                !status.hasCommits,
            ),
            menuItem(
                "History…",
                () => void historyDialog(),
                !status.hasCommits,
            ),
        );
    }
    const r = button.getBoundingClientRect();
    showMenu(Math.max(8, r.right - 260), r.bottom + 4);
}

// ── Git LFS ──

function lfsFiles(): LfsFile[] {
    const l = status.lfs;
    return l ? [...l.uncovered, ...l.unconverted] : [];
}

function size(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

function lfsList(files: LfsFile[]): HTMLElement {
    return h(
        "div",
        { class: "git-files" },
        ...files.map((f) =>
            h(
                "div",
                { class: "git-file" },
                h("span", { class: "git-status" }, f.kind),
                h("code", { class: "git-path" }, f.path),
                h("span", { class: "hint git-size" }, size(f.size)),
            ),
        ),
    );
}

// Videos, images and other large files git would keep whole in every version:
// track them with Git LFS, or say this deck uses git alone.
function lfsDialog(): void {
    const l = status.lfs;
    if (!l) return;
    const paths = lfsFiles().map((f) => f.path);
    openDialog(
        "Large files and Git LFS",
        h(
            "div",
            { class: "git-form" },
            h(
                "p",
                { class: "hint" },
                "Git keeps a full copy of a video or image in every version, so the repository grows with each change. Git LFS stores them outside the history; a small repository can do without it.",
            ),
            l.uncovered.length > 0 &&
                h("h3", {}, "No Git LFS rule covers these"),
            l.uncovered.length > 0 && lfsList(l.uncovered),
            l.unconverted.length > 0 &&
                h("h3", {}, "Committed before Git LFS was set up"),
            l.unconverted.length > 0 && lfsList(l.unconverted),
            !l.installed &&
                h(
                    "p",
                    { class: "hint warn" },
                    "git-lfs is not installed on this computer: install it (git-lfs.com) to track files with it.",
                ),
            h(
                "p",
                { class: "hint" },
                "Tracking adds rules to the deck's .gitattributes and stages the files again as LFS files; commit to keep it. Earlier commits keep their full copies (git lfs migrate rewrites history, for everyone with a clone).",
            ),
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        title: "Record in .gitattributes that this deck stores media in git itself; no more warnings",
                        onclick: async () => {
                            if (await git("lfs-off")) closeDialog();
                        },
                    },
                    "Use git without LFS",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn primary",
                        disabled: !l.installed,
                        onclick: async () => {
                            if (await git("lfs-track", { paths }))
                                closeDialog();
                        },
                    },
                    "Track with Git LFS",
                ),
            ),
        ),
        { wide: true },
    );
}

// ── Commit ──

function fileRow(change: Change, checked: boolean): HTMLElement {
    const box = h("input", {
        type: "checkbox",
        value: change.path,
    }) as HTMLInputElement;
    box.checked = checked;
    return h(
        "label",
        { class: `git-file${change.inDeck ? "" : " outside"}` },
        box,
        h("span", { class: `git-status s-${change.status}` }, change.status),
        h("code", { class: "git-path" }, change.path),
    );
}

function checkedPaths(list: HTMLElement): string[] {
    return [...list.querySelectorAll<HTMLInputElement>("input:checked")].map(
        (b) => b.value,
    );
}

function commitDialog(): void {
    const changes = status.changes ?? [];
    const message = h("textarea", {
        class: "git-message",
        rows: "3",
    }) as HTMLTextAreaElement;
    message.value = status.suggestedMessage ?? "Update slides";
    const files = h(
        "div",
        { class: "git-files" },
        ...changes.map((c) => fileRow(c, c.inDeck)),
    );
    const outside = changes.some((c) => !c.inDeck);
    const name = h("input", {
        type: "text",
        placeholder: "Your name",
    }) as HTMLInputElement;
    const email = h("input", {
        type: "email",
        placeholder: "you@example.com",
    }) as HTMLInputElement;
    const identity = status.identity
        ? null
        : h(
              "div",
              { class: "git-identity" },
              h(
                  "p",
                  { class: "hint" },
                  "git needs to know who commits (kept in this repository only):",
              ),
              h("div", { class: "btn-row" }, name, email),
          );
    const run = async (push: boolean) => {
        const paths = checkedPaths(files);
        const res = await git("commit", {
            message: message.value,
            paths,
            ...(identity ? { name: name.value, email: email.value } : {}),
        });
        if (!res) return;
        closeDialog();
        if (push) await git("push");
    };
    const canPush = !!status.remotes?.length;
    const changed = new Set(changes.map((c) => c.path));
    const heavy = lfsFiles().filter((f) => changed.has(f.path));
    const lfsNote =
        heavy.length > 0 &&
        h(
            "p",
            { class: "hint warn" },
            `${heavy.length} of these ${heavy.length === 1 ? "is a media file" : "are media files"} git would store whole, not in Git LFS. `,
            h(
                "button",
                {
                    type: "button",
                    class: "link-btn",
                    onclick: () => lfsDialog(),
                },
                "Review…",
            ),
        );
    message.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void run(false);
        }
    });
    openDialog(
        "Commit",
        h(
            "div",
            { class: "git-form" },
            h(
                "label",
                { class: "field" },
                h("span", { class: "field-label" }, "Message"),
                message,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Files"),
                h(
                    "div",
                    {},
                    files,
                    outside &&
                        h(
                            "p",
                            { class: "hint" },
                            "Files outside this deck are left out unless you tick them.",
                        ),
                ),
            ),
            lfsNote,
            identity,
            h(
                "div",
                { class: "btn-row end" },
                canPush &&
                    h(
                        "button",
                        {
                            type: "button",
                            class: "pbtn",
                            onclick: () => void run(true),
                        },
                        "Commit and push",
                    ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn primary",
                        title: "Ctrl+Enter",
                        onclick: () => void run(false),
                    },
                    "Commit",
                ),
            ),
        ),
        { wide: true, hint: status.branch ? `on ${status.branch}` : undefined },
    );
    message.focus();
    message.select();
}

// ── Discard ──

function discardDialog(): void {
    const changes = (status.changes ?? []).filter((c) => c.inDeck);
    const files = h(
        "div",
        { class: "git-files" },
        ...changes.map((c) => fileRow(c, true)),
    );
    openDialog(
        "Discard changes",
        h(
            "div",
            { class: "git-form" },
            h(
                "p",
                { class: "hint warn" },
                "The ticked files go back to how they were in the last commit; new files are deleted. This cannot be undone.",
            ),
            files,
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn danger",
                        onclick: async () => {
                            const paths = checkedPaths(files);
                            if (!paths.length) return;
                            if (await git("discard", { paths })) {
                                closeDialog();
                                toast(
                                    `Discarded changes to ${paths.length} file${paths.length === 1 ? "" : "s"}`,
                                    "ok",
                                );
                            }
                        },
                    },
                    "Discard",
                ),
            ),
        ),
        { wide: true },
    );
}

// ── Branches ──

async function branchesDialog(): Promise<void> {
    const res = await git("branches");
    if (!res) return;
    const branches = res.branches as {
        name: string;
        current: boolean;
        when: string;
    }[];
    const name = h("input", {
        type: "text",
        placeholder: "new-branch-name",
    }) as HTMLInputElement;
    const create = async () => {
        if (!name.value.trim()) return;
        if (await git("create-branch", { name: name.value.trim() })) {
            closeDialog();
            toast(`Created and switched to ${name.value.trim()}`, "ok");
        }
    };
    name.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void create();
        }
    });
    openDialog(
        "Branches",
        h(
            "div",
            { class: "git-form" },
            h(
                "div",
                { class: "git-list" },
                ...branches.map((b) =>
                    h(
                        "div",
                        { class: `git-row${b.current ? " current" : ""}` },
                        h("strong", {}, b.name),
                        h(
                            "span",
                            { class: "hint" },
                            b.current ? "current" : b.when,
                        ),
                        !b.current &&
                            h(
                                "button",
                                {
                                    type: "button",
                                    class: "pbtn",
                                    onclick: async () => {
                                        if (
                                            await git("switch", {
                                                name: b.name,
                                            })
                                        ) {
                                            closeDialog();
                                            toast(
                                                `Switched to ${b.name}`,
                                                "ok",
                                            );
                                        }
                                    },
                                },
                                "Switch",
                            ),
                    ),
                ),
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "New branch"),
                h(
                    "div",
                    { class: "btn-row" },
                    name,
                    h(
                        "button",
                        {
                            type: "button",
                            class: "pbtn primary",
                            onclick: create,
                        },
                        "Create and switch",
                    ),
                ),
            ),
            h(
                "p",
                { class: "hint" },
                "Uncommitted changes come along to the branch you switch to; git refuses a switch that would overwrite them.",
            ),
        ),
        { wide: true },
    );
}

// ── History ──

async function historyDialog(): Promise<void> {
    const res = await git("log");
    if (!res) return;
    const log = res.log as Commit[];
    const act = async (
        op: string,
        c: Commit,
        question: string,
        done: string,
    ) => {
        if (await git(op, { sha: c.sha }, question)) {
            closeDialog();
            toast(done, "ok");
        }
    };
    openDialog(
        "History",
        h(
            "div",
            { class: "git-form" },
            log.length
                ? h(
                      "div",
                      { class: "git-list history" },
                      ...log.map((c) =>
                          h(
                              "div",
                              { class: `git-row${c.head ? " current" : ""}` },
                              h(
                                  "div",
                                  { class: "git-commit" },
                                  h("strong", {}, c.subject),
                                  h(
                                      "span",
                                      { class: "hint" },
                                      `${c.short} · ${c.author} · ${c.when}${c.refs.length ? ` · ${c.refs.join(", ")}` : ""}`,
                                  ),
                              ),
                              h(
                                  "div",
                                  { class: "btn-row" },
                                  h(
                                      "button",
                                      {
                                          type: "button",
                                          class: "pbtn",
                                          title: "Show the deck as it was then (switch back with Branches)",
                                          onclick: () =>
                                              void act(
                                                  "view",
                                                  c,
                                                  `Show the deck as it was at "${c.subject}"? Edits there are not on any branch until you create one.`,
                                                  `Viewing ${c.short}; switch back to a branch from the git menu`,
                                              ),
                                      },
                                      "View",
                                  ),
                                  h(
                                      "button",
                                      {
                                          type: "button",
                                          class: "pbtn",
                                          title: "Make the deck's files what they were then, as uncommitted changes",
                                          onclick: () =>
                                              void act(
                                                  "restore",
                                                  c,
                                                  `Restore the deck's files to "${c.subject}"? Your current files are replaced (commit first to keep them).`,
                                                  `Restored the deck to ${c.short}; commit to keep it`,
                                              ),
                                      },
                                      "Restore",
                                  ),
                                  h(
                                      "button",
                                      {
                                          type: "button",
                                          class: "pbtn",
                                          title: "A new commit that undoes this one",
                                          onclick: () =>
                                              void act(
                                                  "revert",
                                                  c,
                                                  `Undo "${c.subject}" with a new commit?`,
                                                  `Reverted ${c.short}`,
                                              ),
                                      },
                                      "Revert",
                                  ),
                              ),
                          ),
                      ),
                  )
                : h("p", { class: "hint" }, "No commits touch this deck yet."),
            h(
                "p",
                { class: "hint" },
                "View: look at an old version (no branch). Restore: bring the deck back to it as changes you can commit. Revert: undo one commit with a new one.",
            ),
        ),
        {
            wide: true,
            hint: status.scope ? `changes to ${status.scope}/` : undefined,
        },
    );
}

let timer = 0;

export function initGit(): void {
    button.addEventListener("click", () => void openMenu());
    // Files changed (an edit, a save in Inkscape, a git operation): the
    // rebuild that follows refreshes the count.
    on("model", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void refreshGit(), 600);
    });
}
