// Each slide's changes since the last commit, in words (slidegit.ts shows
// them; the server reads them off git: editor/slidegit.py). Pure, tested.

/** VS Code's marks: U a slide not in the last commit, M a changed one, and
 * a dot for one only its layout, an overlay or another shared file changed. */
export type SlideState = "new" | "modified" | "shared" | null;

export interface SlideFile {
    path: string; // relative to the repository root
    status: string; // git's: modified, new, deleted, renamed…
    role: string; // slide, layout, overlay, md, notes, ink, data, asset…
    shared: boolean; // other slides use it too
}

export interface SlideChange {
    state: SlideState;
    entry: "new" | "modified" | null; // its Slide(...) in deck.py
    files: SlideFile[];
}

export interface RemovedSlide {
    index: number;
    key: string | null; // "md:c.md", "id:intro", "src:x.svg"
    code: string;
}

export interface SlideChanges {
    slides: SlideChange[];
    removed: RemovedSlide[];
    deck: {
        path: string;
        status: string | null;
        readable: boolean;
        other: boolean; // deck.py changed besides its slides
    };
}

export interface CommitPlan {
    paths: { path: string; status: string }[];
    offered: { path: string; status: string; why: string }[];
    deck: "none" | "whole" | "partial";
    deckPath: string;
    other: boolean;
    removed: RemovedSlide[];
    left: number;
}

export function letter(state: SlideState): string {
    if (state === "new") return "U";
    if (state === "modified") return "M";
    if (state === "shared") return "•";
    return "";
}

const STATE_WORDS: Record<string, string> = {
    new: "New since the last commit",
    modified: "Changed since the last commit",
    shared: "Only files it shares with other slides changed",
};

const ROLE_WORDS: Record<string, string> = {
    layout: "its layout",
    overlay: "an overlay",
    md: "its Markdown",
    notes: "its notes",
    ink: "its ink",
    data: "chart data",
    asset: "a picture",
    diagram: "a diagram",
    slide: "its SVG",
};

/** The tooltip of a slide's mark: what changed, file by file. */
export function changeTitle(c: SlideChange | undefined): string {
    if (!c?.state) return "";
    const lines = [STATE_WORDS[c.state] ?? ""];
    if (c.entry === "new") lines.push("  its Slide(...) in deck.py is new");
    else if (c.entry === "modified")
        lines.push("  its Slide(...) in deck.py changed");
    for (const f of c.files) {
        const what = ROLE_WORDS[f.role] ?? f.role;
        const shared = f.shared ? ", shared with other slides" : "";
        lines.push(`  ${f.path} (${what}, ${f.status}${shared})`);
    }
    return lines.join("\n");
}

/** The slides among `indices` (deck order) that have changes to commit. */
export function changedAmong(
    changes: SlideChanges | null,
    indices: Iterable<number>,
): number[] {
    if (!changes) return [];
    return [...indices]
        .filter((i) => {
            const s = changes.slides[i]?.state;
            return s === "new" || s === "modified";
        })
        .sort((a, b) => a - b);
}

export function countChanged(changes: SlideChanges | null): number {
    return (changes?.slides ?? []).filter(
        (s) => s.state === "new" || s.state === "modified",
    ).length;
}

/** A first commit message naming the slides. */
export function defaultMessage(titles: string[]): string {
    const named = titles.map((t) => `"${t.trim() || "untitled"}"`);
    if (named.length === 1) return `Update slide ${named[0]}`;
    if (named.length <= 3) {
        const last = named.pop();
        return `Update slides ${named.join(", ")} and ${last}`;
    }
    return `Update ${named.length} slides`;
}

/** What a removed slide is called: what names it in deck.py. */
export function removedName(r: RemovedSlide): string {
    if (!r.key) return `slide ${r.index + 1}`;
    return r.key.replace(/^(id|md|src):/, "");
}

/** How deck.py goes into the commit, in words. */
export function deckWords(plan: CommitPlan): string {
    if (plan.deck === "none") return "";
    const whole = plan.deck === "whole";
    const base = whole
        ? `${plan.deckPath}: all its changes`
        : `${plan.deckPath}: these slides' Slide(...) entries only`;
    return plan.other
        ? `${base}, with its imports, settings, sections and order as they are now`
        : base;
}

/** The note under the files: what stays out of the commit. */
export function leftWords(plan: CommitPlan): string {
    if (!plan.left) return "";
    return `${plan.left} other changed slide${plan.left === 1 ? "" : "s"} stay${plan.left === 1 ? "s" : ""} uncommitted.`;
}

/** An offered file is ticked when the slides need it: a new shared file
 * (a layout made for them) or a deleted one whose slides go too. */
export function tickedOffer(
    offer: { status: string; why: string },
    withRemoved: boolean,
): boolean {
    if (offer.why === "deleted") return withRemoved;
    return offer.status === "new";
}

export type DiffLine = "add" | "del" | "hunk" | "meta" | "";

/** How one line of diff text is shown. */
export function diffLine(line: string): DiffLine {
    if (
        line.startsWith("diff ") ||
        line.startsWith("index ") ||
        line.startsWith("+++ ") ||
        line.startsWith("--- ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("Binary files")
    )
        return "meta";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "";
}
