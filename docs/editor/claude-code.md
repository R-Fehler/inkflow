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
| `inkflow context` | Prints what the editor has selected right now (`--json` for the raw data). |
| `inkflow render` | Writes PNGs of slides at any build step to `.inkflow/render/`, the editor's current slide by default (`--slide N`, `--all`, `--step S`), and reports layout problems. Claude looks at them to check its own work. `--sheet` puts the slides on one contact sheet; `--check` only measures (see below). |
| `inkflow verify` | Checks the deck for authoring mistakes. |
| `inkflow goto N` | Shows slide `N` in the editor open on this deck. |
| `inkflow select ID…` | Selects elements by id in the editor open on this deck, so Claude can point at what it means. |

With several editors running, `goto` and `select` find the right one from the
deck's `.inkflow/context.json`. The editor keeps its state in `.inkflow/` in the project, which ignores itself in
git and is not watched for changes. `render` needs Chromium or Chrome, like
`inkflow export`; one installed by Playwright is found too.

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
