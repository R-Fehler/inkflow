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
import { on } from "./state";

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
    suggestedMessage?: string;
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
    badge.hidden = n === 0;
    badge.textContent = String(n);
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

/** Run one git operation; returns its result (status refreshed) or null. */
async function git(
    op: string,
    args: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
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
                        !confirm(
                            `Take back "${status.last?.subject}"? Its changes stay, uncommitted.`,
                        )
                    )
                        return;
                    if (await git("undo-commit"))
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
        if (!confirm(question)) return;
        if (await git(op, { sha: c.sha })) {
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
