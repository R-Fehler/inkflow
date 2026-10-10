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
| `inkflow render` | Writes PNGs of slides at any build step to `.inkflow/render/`, the editor's current slide by default (`--slide N`, `--all`, `--step S`). Claude looks at them to check its own work. |
| `inkflow verify` | Checks the deck for authoring mistakes. |
| `inkflow goto N` | Shows slide `N` in the editor open on this deck. |
| `inkflow select ID…` | Selects elements by id in the editor open on this deck, so Claude can point at what it means. |
| `inkflow slide …` | Adds, deletes, duplicates, moves, hides, shows, renames or retitles slides, with their files (below). |

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
