# Editing with Claude Code

Because a deck is plain files, an agent can edit it as easily as you can. Inkflow
connects the two: run [Claude Code](https://claude.com/claude-code) in a terminal
next to the visual editor, select something on a slide, and ask for what you want.
Claude knows what "this" is, edits the same files, and the editor shows the result
live.

## Setup

Once per project:

```bash
inkflow setup-claude
```

This adds two things under `.claude/`:

- a **prompt hook** in `settings.json` that runs `inkflow context --hook` before
  each prompt, so Claude sees the editor's current slide and selection;
- an **`inkflow` skill** describing the deck's files, the Python DSL, the theme's
  colour classes and how to check results.

Existing settings are kept, and running it again changes nothing.

## Working together

```bash
inkflow edit        # the editor, in your browser
claude              # Claude Code, in a terminal in the same project
```

Select the objects you mean, then ask:

> make these the same width and align their tops

> reveal these one per click, sliding in from the left

> turn the bullet list on this slide into a three-step diagram

> write speaker notes for this slide, about a minute's worth

> split this slide in two at the second heading

Claude reads the selection (file, element ids, positions and text), edits the SVG,
Markdown or `deck.py`, and the editor re-renders. Anything it changes is an ordinary
file change: review it with `git diff`, undo it with `git`, or keep editing by hand
right away.

## The commands behind it

| Command | What it does |
|---|---|
| `inkflow outline` | Prints what is on every slide in a few lines each: its files and layout chain, each zone with where its text is written and how it starts, the animations and clicks. `--slide N` shows one slide in full (zone texts and boxes, canvas size, element ids to animate, animations as `deck.py` writes them); `--json` for the whole structure. Claude starts here instead of reading every file. |
| `inkflow context` | Prints what the editor has selected right now (`--json` for the raw data). |
| `inkflow render` | Writes PNGs of slides at any build step to `.inkflow/render/`, the editor's current slide by default (`--slide N`, `--all`, `--step S`), and reports layout problems. Claude looks at them to check its own work. `--sheet` puts the slides on one contact sheet; `--check` only measures (see below). |
| `inkflow verify` | Checks the deck for authoring mistakes. |
| `inkflow goto N` | Shows slide `N` in the editor open on this deck. |
| `inkflow select ID…` | Selects elements by id in the editor open on this deck, so Claude can point at what it means. |
| `inkflow slide …` | Adds, deletes, duplicates, moves, hides, shows, renames or retitles slides, with their files (below). |
| `inkflow worktree …` | A copy of the deck on a branch of its own for Claude to work in, merged when you like it ([below](#working-on-a-branch)). |
| `inkflow compare [LEFT] RIGHT` | Which slides differ between two versions: the working copy, a revision (`main`, `HEAD~2`) or a deck folder. One line per slide that differs (`~ 3 features: slides/features.md, notes`, `+ 4 compare`, `- 7 morph`, `↕ 5 → 6 media`); `--json` adds the changed elements; `--sheet` writes side-by-side images of only those slides (see [Comparing two versions](compare.md)). |

With several editors running, `goto` and `select` find the right one from the
deck's `.inkflow/context.json`.

## Changing the slide list

A slide is more than its `Slide(...)` line in `deck.py`: it has its own drawing,
Markdown, notes and saved ink, and some of those files are named after the
slide's id. `inkflow slide` makes each change the way the editor's slide list
does, so nothing is left behind or orphaned:

| Command | What it does |
|---|---|
| `inkflow slide add --layout content [--after N] [--id NAME] [--title T] [--md TEXT]` | A new slide with its own drawing on that layout (`--like N`: the layout of slide `N`), after slide `N` (`0`: first; default: last). `--title` and `--md` (`-` reads stdin) become its `slides/<id>.md`. |
| `inkflow slide delete N [N…]` | Removes the slides, with the drawing, Markdown, notes and ink only they use (`--keep-files` leaves those). |
| `inkflow slide duplicate N` | A copy right after it, with copies of its own files. |
| `inkflow slide move N --to M` | Moves slide `N` so it becomes slide `M`. |
| `inkflow slide hide N` / `show ID` | Sets or clears `visible=False`. |
| `inkflow slide rename N NEW_ID` | Sets `id=`; its ink file and every `slide:<old id>` link follow. |
| `inkflow slide title N TEXT` | Sets `title=` (`""` removes it). |

A slide is named by its number, counted as the presenter and `inkflow goto` count
(1-based, hidden slides left out), or by its id; a hidden slide goes by its id.
Each command prints the files it wrote, created, renamed or deleted, and
`deck.py` keeps its comments and formatting.

When the editor (or `inkflow serve`) has the deck open, the change is made by
that server, as one step in the editor's undo history: the editor shows
*Agent: Delete slide 3 (interface)* with an **Undo** button, and
<kbd>Ctrl</kbd>+<kbd>Z</kbd> takes it back like any of your own edits. Without a
server the files are changed directly, and `git` is the undo. The editor keeps its state in `.inkflow/` in the project, which ignores itself in
git and is not watched for changes. `render` needs Chromium or Chrome, like
`inkflow export`; one installed by Playwright is found too.

## Working on a branch

For a bigger change, a proposal you may not want, or two variants to choose
from, let Claude work on a branch in a separate folder, a
[git worktree](https://git-scm.com/docs/git-worktree), while your deck and
editor stay exactly as they are:

> make a version of this deck with a bolder colour scheme on a branch, so I can compare

1. Claude runs `inkflow worktree add bolder`: a new branch `deck/bolder` from
   the deck's last commit, checked out in `.inkflow/worktrees/bolder` at the
   top of the repository (ignored by git, and not watched by your editor's
   server, so nothing Claude writes there reaches your slides).
2. It works only there, passing `--deck .inkflow/worktrees/bolder/…/deck.py`
   to every `inkflow` command, and commits on that branch.
3. You review it: **Compare** in the editor's Git menu shows its slides next to
   yours (or `inkflow compare`), or open it in a second editor with
   `inkflow edit --deck <its deck.py>` (it takes the next free port).
4. **Merge** it into your branch, or **Remove** it.

You can also start it yourself: Git menu → **New worktree for an agent…** asks
for a name and shows what to tell Claude (with a Copy button), or the command to
start a new Claude Code session inside the worktree. Uncommitted changes to
your deck are not in a new worktree, which starts from the last commit, so
commit first if Claude should build on them.

| Command | What it does |
|---|---|
| `inkflow worktree add NAME [--base REV]` | Branch `deck/NAME` from `REV` (default: the deck's last commit) in `.inkflow/worktrees/NAME`; prints its `path:` and the `deck:` to pass as `--deck`. An existing `deck/NAME` branch is checked out as it is. |
| `inkflow worktree list` | Every worktree of the repository: branch, commits ahead of and behind your branch, uncommitted changes. |
| `inkflow worktree merge NAME` | Merges its branch into your deck's branch: a fast-forward when your branch has not moved, else a merge commit. Refused while your deck has uncommitted changes; a conflict is aborted (nothing merged) and the files named. |
| `inkflow worktree remove NAME [--force]` | Removes the folder, and the `deck/NAME` branch once merged. Uncommitted changes or unmerged commits there are refused unless `--force`. |

Claude does not merge or remove a worktree unless you ask it to.

## Reviewing a branch

An agent working on a branch (or in its own git worktree) can review what it
changed before handing over:

```bash
inkflow compare main .            # main on the left, this folder on the right
inkflow compare main . --sheet    # .inkflow/render/compare.png: before | after
```

The author sees the same in the editor's compare view
(**Git → Compare…**, or `inkflow edit --compare <branch or folder>`), takes
slides over one by one, or merges the branch.

## Checking the layout

`inkflow render` measures each slide in the browser while it renders it, and
prints a line for each layout problem it finds:

```text
slide 2 (features): #zone-content: text overflows its zone by 232px (bottom)
slide 3 (interface): #zone-content: code block is cut off by 528px (right)
slide 8 (morph): #logo: lies 40px outside the slide (right)
slide 8 (morph): #lost: lies entirely outside the slide (right), so it is not shown
slide 3 (interface): #zone-content: text 10px tall is likely too small to read (below 13.5px): "tiny footnote"
```

Lengths are in slide units, the numbers in the SVG. A zone's text is compared
with the zone's box; a drawn object with the slide's edges, except a background
or a band spanning the whole slide, and anything clipped on purpose (a crop, a
media zone). Small text (below 1/80 of the slide's height) is a hint, the rest
are problems.

```bash
inkflow render --check            # every slide, no images; exit 1 on a problem
inkflow render --sheet            # .inkflow/render/sheet.png: all slides in a grid
inkflow render --sheet -s 4 -s 5  # just these slides
```

A contact sheet labels each slide with its number and id, and flags the ones
with problems. It is at most 1600 px wide, with up to 16 slides per image
(`sheet-1.png`, `sheet-2.png`… for a longer deck), so one image shows the flow of
the deck. Every render runs in a single browser, so `--all`, `--sheet` and
`--check` take a few seconds for a whole deck.
