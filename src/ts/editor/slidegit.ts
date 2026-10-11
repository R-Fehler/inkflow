// Slides and git: each slide's row in the slide list and its grid tile carry
// VS Code's mark for its changes since the last commit (U new, M changed, a
// dot when only a file it shares changed, such as its layout), its context
// menu shows those changes (side by side with the last commit in the compare
// view, element by element, or as git's diff text) and commits the picked
// slides alone: their own files and their Slide(...) entries of deck.py,
// the other slides' changes left uncommitted. The server reads it all off
// git and the last build (editor/slidegit.py); git.ts asks for it with the
// git status after every rebuild.

import { openCompare } from "./compare";
import { closeDialog, openDialog } from "./dialog";
import { h, toast } from "./dom";
import { gitStatus, runGit } from "./git";
import { request } from "./net";
import {
    type CommitPlan,
    changedAmong,
    changeTitle,
    deckWords,
    defaultMessage,
    diffLine,
    leftWords,
    letter,
    missingWords,
    removedName,
    type SlideChange,
    type SlideChanges,
    touchedWords,
    whyWords,
} from "./slidegittext";
import { ed, emit } from "./state";

let changes: SlideChanges | null = null;

/** The slides' changes (git.ts, after each git status). */
export function setSlideChanges(next: unknown): void {
    const value =
        next &&
        typeof next === "object" &&
        Array.isArray((next as SlideChanges).slides)
            ? (next as SlideChanges)
            : null;
    if (JSON.stringify(value) === JSON.stringify(changes)) return;
    changes = value;
    emit("slide-git");
}

export function slideChange(i: number): SlideChange | undefined {
    // A model with another slide count is newer than the changes: no marks
    // until git.ts has asked again.
    if (!changes || changes.slides.length !== (ed.model?.slides.length ?? 0))
        return undefined;
    return changes.slides[i];
}

/** The mark on a slide's row or tile (empty when it has no changes). */
export function changeBadge(i: number): HTMLElement {
    const badge = h("span", { class: "git-mark" });
    paint(badge, slideChange(i));
    return badge;
}

function paint(badge: Element, c: SlideChange | undefined): void {
    const state = c?.state ?? "";
    badge.textContent = letter(c?.state ?? null);
    badge.className = `git-mark${state ? ` m-${state}` : ""}`;
    if (state) badge.setAttribute("title", changeTitle(c));
    else badge.removeAttribute("title");
}

/** Bring a row's mark in line with the changes (rows are kept: sorter.ts). */
export function markChange(item: Element, i: number): void {
    const badge = item.querySelector(".git-mark");
    if (badge) paint(badge, slideChange(i));
}

// ── The slide menu ──

/** The slide menu's git entries for slide `i` (or the picked slides).
 * `item` makes a menu entry (sorter.ts's). */
export function slideGitItems(
    i: number,
    item: (label: string, fn: () => void, disabled?: boolean) => HTMLElement,
): HTMLElement[] {
    const status = gitStatus();
    if (!status.repo || !changes) return [];
    const picked = ed.slideSelection.size > 1 ? [...ed.slideSelection] : [i];
    const changed = changedAmong(changes, picked);
    const out: HTMLElement[] = [h("div", { class: "menu-sep" })];
    if (picked.length === 1) {
        const c = slideChange(i);
        const any = !!c?.state;
        out.push(
            item(
                "Compare with the last commit",
                () => compareSlide(i),
                !status.hasCommits,
            ),
            item("Show git diff", () => void diffDialog(i), !any),
        );
    }
    const n = changed.length;
    out.push(
        item(
            picked.length === 1
                ? "Commit this slide…"
                : `Commit ${n} changed slide${n === 1 ? "" : "s"}…`,
            () => void commitSlides(changed),
            n === 0,
        ),
    );
    return out;
}

/** Slide `i` beside its last committed version (compare.ts). */
export function compareSlide(i: number): void {
    openCompare(
        { kind: "commit", rev: "HEAD" },
        { kind: "live" },
        { focus: i },
    );
}

// ── git diff ──

function slideName(i: number): string {
    const slide = ed.model?.slides[i];
    return slide?.title ?? slide?.id ?? `slide ${i + 1}`;
}

async function diffDialog(i: number): Promise<void> {
    const res = await request({ action: "git", op: "slide-diff", slide: i });
    if (!res.ok) {
        toast(res.error ?? "Cannot read the slide's changes", "error");
        return;
    }
    const text = String(res.diff ?? "");
    const pre = h("pre", { class: "git-diff" });
    for (const line of text.split("\n")) {
        const kind = diffLine(line);
        pre.append(h("span", { class: kind ? `d-${kind}` : null }, line), "\n");
    }
    openDialog(
        `Changes to slide ${i + 1}: ${slideName(i)}`,
        h(
            "div",
            { class: "git-form" },
            text.trim()
                ? pre
                : h(
                      "p",
                      { class: "hint" },
                      "No changes since the last commit.",
                  ),
            h(
                "div",
                { class: "btn-row end" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: () => {
                            closeDialog();
                            compareSlide(i);
                        },
                    },
                    "Compare with the last commit",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "pbtn",
                        onclick: async () => {
                            await navigator.clipboard?.writeText(text);
                            toast("Diff copied", "ok");
                        },
                    },
                    "Copy",
                ),
                changedAmong(changes, [i]).length
                    ? h(
                          "button",
                          {
                              type: "button",
                              class: "pbtn primary",
                              onclick: () => void commitSlides([i]),
                          },
                          "Commit this slide…",
                      )
                    : null,
            ),
        ),
        { large: true },
    );
}

// ── Committing slides ──

async function plan(
    slides: number[],
    removed: boolean,
): Promise<CommitPlan | null> {
    const res = await request({
        action: "git",
        op: "commit-slides",
        slides,
        removed,
        dryRun: true,
    });
    if (!res.ok) {
        toast(res.error ?? "Cannot commit these slides", "error");
        return null;
    }
    return res.plan as CommitPlan;
}

function fileLine(path: string, status: string, why = ""): HTMLElement {
    return h(
        "div",
        { class: "git-file" },
        h("span", { class: `git-status s-${status}` }, status),
        h("code", { class: "git-path" }, path),
        why ? h("span", { class: "hint" }, why) : null,
    );
}

/** Commit the slides `slides` (deck indices) and nothing else. */
export async function commitSlides(slides: number[]): Promise<void> {
    if (!slides.length) {
        toast("These slides have no changes to commit");
        return;
    }
    let withRemoved = false;
    let current = await plan(slides, withRemoved);
    if (!current) return;
    const status = gitStatus();
    const message = h("textarea", {
        class: "git-message",
        rows: "3",
    }) as HTMLTextAreaElement;
    message.value = defaultMessage(slides.map(slideName));
    const files = h("div", { class: "git-files" });
    const offers = h("div", { class: "git-files" });
    const notes = h("div", {});
    const ticked = new Set<string>();
    const draw = (p: CommitPlan) => {
        files.replaceChildren(
            ...p.paths.map((f) => fileLine(f.path, f.status, whyWords(f.why))),
            ...(p.deck !== "none"
                ? [
                      h(
                          "div",
                          { class: "git-file" },
                          h(
                              "span",
                              { class: "git-status s-modified" },
                              p.deck === "whole" ? "modified" : "part",
                          ),
                          h("span", { class: "git-path" }, deckWords(p)),
                      ),
                  ]
                : []),
        );
        offers.replaceChildren(
            ...p.offered.map((o) => {
                const box = h("input", {
                    type: "checkbox",
                    value: o.path,
                }) as HTMLInputElement;
                box.checked = ticked.has(o.path);
                box.addEventListener("change", () => {
                    if (box.checked) ticked.add(o.path);
                    else ticked.delete(o.path);
                });
                return h(
                    "label",
                    { class: "git-file" },
                    box,
                    h("span", { class: `git-status s-${o.status}` }, o.status),
                    h("code", { class: "git-path" }, o.path),
                );
            }),
        );
        offers.hidden = !p.offered.length;
        offersLabel.hidden = !p.offered.length;
        notes.replaceChildren(
            ...[touchedWords(p), leftWords(p)]
                .filter(Boolean)
                .map((t) => h("p", { class: "hint" }, t)),
        );
        // What a fresh clone would lack, whatever this commit holds.
        const lacking = missingWords(p);
        missing.replaceChildren(
            ...(lacking.length
                ? [
                      h(
                          "p",
                          { class: "hint warn" },
                          "A clone of this commit will not show these slides as they look here:",
                      ),
                      h(
                          "ul",
                          { class: "pack-list" },
                          ...lacking.map((t) => h("li", {}, t)),
                      ),
                  ]
                : []),
        );
    };
    const offersLabel = h(
        "span",
        { class: "field-label" },
        "Also commit (deleted files no slide uses)",
    );
    const missing = h("div", {});
    const removed = changes?.removed ?? [];
    const removedBox = h("input", { type: "checkbox" }) as HTMLInputElement;
    removedBox.addEventListener("change", async () => {
        withRemoved = removedBox.checked;
        const next = await plan(slides, withRemoved);
        if (!next) {
            removedBox.checked = !removedBox.checked;
            withRemoved = removedBox.checked;
            return;
        }
        // The deleted files follow the removals.
        for (const o of next.offered) {
            if (o.why === "deleted") {
                if (withRemoved) ticked.add(o.path);
                else ticked.delete(o.path);
            }
        }
        current = next;
        draw(next);
    });
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
    const commit = async (push: boolean) => {
        if (!current) return;
        const res = await runGit("commit-slides", {
            slides,
            message: message.value,
            removed: withRemoved,
            paths: current.offered
                .map((o) => o.path)
                .filter((p) => ticked.has(p)),
            ...(identity ? { name: name.value, email: email.value } : {}),
        });
        if (!res) return;
        closeDialog();
        if (push) await runGit("push");
    };
    const run = (push: boolean) => commit(push);
    message.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void run(false);
        }
    });
    const list = h(
        "div",
        { class: "git-slides" },
        ...slides.map((i) =>
            h(
                "div",
                { class: "git-file" },
                changeBadge(i),
                h("span", { class: "git-slide-num" }, String(i + 1)),
                h("span", {}, slideName(i)),
            ),
        ),
    );
    openDialog(
        slides.length === 1
            ? "Commit this slide"
            : `Commit ${slides.length} slides`,
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
                h("span", { class: "field-label" }, "Slides"),
                list,
            ),
            h(
                "div",
                { class: "field" },
                h("span", { class: "field-label" }, "Goes in"),
                h("div", {}, files, notes, missing),
            ),
            h("div", { class: "field" }, offersLabel, offers),
            removed.length
                ? h(
                      "label",
                      { class: "field inline" },
                      removedBox,
                      h(
                          "span",
                          {},
                          `Also commit the removal of ${removed.length} slide${removed.length === 1 ? "" : "s"} (${removed.map(removedName).join(", ")})`,
                      ),
                  )
                : null,
            identity,
            h(
                "div",
                { class: "btn-row end" },
                status.remotes?.length
                    ? h(
                          "button",
                          {
                              type: "button",
                              class: "pbtn",
                              onclick: () => void run(true),
                          },
                          "Commit and push",
                      )
                    : null,
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
        {
            wide: true,
            hint: status.branch ? `on ${status.branch}` : undefined,
        },
    );
    draw(current);
    message.focus();
    message.select();
}

/** Git menu: commit the picked slides, else the one being edited. */
export function commitPicked(): void {
    const picked = ed.slideSelection.size
        ? [...ed.slideSelection]
        : [ed.current];
    void commitSlides(changedAmong(changes, picked));
}

export function changedSlideCount(): number {
    return changedAmong(changes, ed.model?.slides.keys() ?? []).length;
}
