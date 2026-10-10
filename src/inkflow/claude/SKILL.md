---
name: inkflow
description: Edit this inkflow presentation (slides drawn as SVG, content in Markdown, order/animations/transitions in deck.py). Use for any request about the slides, the deck, a slide's layout, text, images, animations, transitions or speaker notes, and whenever the author refers to "this", "these" or "the selected" thing in the inkflow editor.
---

# Editing an inkflow deck

The deck is plain files, edited by the author in the visual editor
(`inkflow edit`, served at `http://localhost:7777/edit`) and by you, at the
same time. The server watches every file: whatever you write shows up in the
author's editor within a moment, and whatever they change there is already on
disk when you read it. Re-read a file before editing it, since the author may
have just changed it.

## Start with `inkflow outline`

`inkflow outline` prints the whole deck in a few lines per slide: number, id,
position in deck.py (`slides[i]`), its SVG/layout chain, `.md` and notes
files, then each zone with where its text lives (`md` = the slide's `.md`,
`deck.py` = `zones={...}`, `empty`) and the animations and clicks.
`inkflow outline -s N` adds full zone texts, zone boxes and the canvas size
(to place shapes), the element ids animations can target, and each animation
as deck.py writes it. Read it instead of opening every file; open only the
files you change. `inkflow layouts` lists every layout with its zones.

To place or size something against text, use the boxes the browser actually
drew, not guesses: `inkflow render --boxes -s N` prints each element's box in
slide units (`id  x,y wxh  kind  "text"`), each zone with its content's extent
and free height, and each block of a zone's text (`zone-content/2  …  p`) with
the extent of its text.

## What the author is looking at

`inkflow context` prints the editor's current slide, build step and
selection: each selected object's id, tag, source file and position. A prompt
hook adds the same text to each message while the editor is open, so "align
these", "make this blue" or "animate the selected boxes" refer to that
selection. Run it again whenever you need the current state.

Point the author at something with `inkflow goto N` (1-based slide number)
and `inkflow select ID [ID…]` (selects elements on the current slide).

Add, delete, duplicate, move, hide/show or re-id slides with `inkflow slide …`
(`inkflow slide --help`), not by editing `slides=[...]` by hand: they move the
slide's Markdown, notes, drawing and ink files along, and with the editor open
each is a step the author can undo there.

To find or change wording across the deck, `inkflow find TEXT` lists every
match (slide, file, `#id` or Markdown line and zone) in SVG text, Markdown,
notes and deck.py's titles/zone text, and `inkflow replace TEXT NEW` changes
them all as one undoable step (`--regex`, `--case`, `--word`, `-s SLIDE`,
`--dry-run` first when unsure).

## Files

- `deck.py`: `main()` returns `Deck(slides=[Slide(...), ...])`. Slide order,
  each slide's source, its `md=` content, `zones={...}`, `animations=[...]`,
  `transition=`, `notes=`, `title=`, `visible=`.
- `slides/*.svg`: one-off slide drawings. `inkflow:parent="<layout>"` on the root
  builds the slide on a layout. Elements need an `id` to be animated or morphed.
- `layouts/*.svg`, `overlays/*.svg`: shared backgrounds and chrome. A change
  here changes every slide that uses it; say so before doing it.
- `slides/*.md`: Markdown routed into a layout's zones (`::zone::` markers;
  a leading `# Title` fills the title zone; `::step::` reveals on click).
- `notes/*.md`: speaker notes.
- `ink/<slide id>.svg`: what the author drew on that slide with a pen (the
  editor's pen tool, or the presenter's ink mode with "Keep"), painted on top
  of the slide. One filled `<path id="ink-…">` per stroke, directly under the
  root; `Slide(ink="…")` names another file. Leave the strokes' outlines alone
  (they are hand-drawn shapes, not something to tidy); deleting a stroke, or
  the whole file to clear the slide, is fine. To change a slide's id, use
  `inkflow slide rename`, which moves its ink file and `slide:` links along.

Colours: prefer the theme's classes over hex values so slides follow dark and
light mode: `class="inkflow-fill-accent"`, `inkflow-stroke-text`, and so on
for `bg surface border text text-muted accent accent-fg code-bg code-text red
orange yellow green teal blue purple pink grey`.

## Common tasks

- **Add a slide with text on a layout**: `inkflow slide add --layout two-cols
  --after 3 --id compare --md -` with the Markdown on stdin (it becomes
  `slides/compare.md`; the id names the files). A leading `# Title` fills the
  title zone, the text after it the default zone (`content`), and a
  `::<zone>::` line starts another zone:

  ```markdown
  # Before and after

  ::left::

  - Slides in a binary file

  ::right::

  - Plain text in git
  ```

  Layouts: `content`, `two-cols` (left, right), `three-cols`, `comparison`,
  `media-left`/`media-right` (content, media), `quote`, `section`, `center`,
  `cover`, `end`… (`inkflow layouts` for all of them and their zones).
- **Reorder, hide, remove**: `inkflow slide move compare --to 2`,
  `inkflow slide hide 9` (kept, not shown), `inkflow slide delete 9`. Slides
  are named by number or id; numbers (`outline`, `render -s`, `goto`) count
  visible slides only, so prefer ids across several commands.
- **Reveal on click**: in Markdown, a `::step::` line shows what follows on the
  next click; inside `::steps::` … `::steps end::` each list item comes on its
  own click. Drawn elements: `animations=[...]` (below).
- **Picture**: on a layout with a `media` zone,
  `zones={"media": Image("assets/photo.jpg")}`; in Markdown,
  `![alt](../assets/photo.jpg)` (relative to the `.md`).
- **Light/dark and colours**: `Deck(mode=ColorMode.LIGHT)` (or `DARK`). Token
  overrides go in `styles.css` between `/* inkflow:theme */` and
  `/* /inkflow:theme */` (add both lines if missing):
  `:root { --inkflow-accent: #e8590c; }` for dark mode,
  `:root[data-theme="light"] { --inkflow-accent: #c2410c; }` for light.
  After changing `mode`, run `inkflow sync` (refreshes Inkscape previews).

## Animations and transitions (deck.py)

```python
from inkflow import Direction, Slide, Trigger, animations, transitions

Slide(
    "diagram.svg",
    animations=[
        animations.FadeIn("box-a"),  # next click
        animations.SlideIn("box-b", Trigger.WITH_PREVIOUS, direction=Direction.UP),
        animations.ScaleIn("arrow", Trigger.AFTER_PREVIOUS, scale=0.6),
        animations.Highlight("box-a"),  # emphasis
        animations.FadeOut("box-b"),
    ],
    transition=transitions.Morph(),  # Cut, Crossfade, Fade, Push, Cover, Wipe, Zoom
)
```

Steps are inferred from triggers; never number them by hand unless pinning
with `Trigger.at(n)`. Morph pairs elements by `id` across consecutive slides.

`inkflow anim list -s N` prints the slide's whole click timeline (Markdown
reveals first, then `animations=[...]` with its `#` index). Prefer these to
editing the list by hand; they check types and target ids and are undoable
steps in the open editor: `inkflow anim add -s N FadeIn box-a --trigger with
--duration 300` (`--direction`, `--delay`, `--easing`, `--set scale=0.6`,
`--at INDEX`), `anim set -s N INDEX --trigger after`, `anim move -s N INDEX
--to 1`, `anim remove -s N INDEX…`.

## Images and video (deck.py)

A zone is a `<rect id="zone-NAME">` in an SVG; `zones={"NAME": ...}` fills it.
To place a video anywhere, add such a rect to the slide's own SVG and fill it:

```python
from inkflow import Image, MediaFit, Muted, Slide, Video, animations

Slide(
    "demo.svg",  # contains <rect id="zone-video" x="200" y="200" width="960" height="540"/>
    zones={
        "video": Video("assets/clip.mp4", autoplay=True, loop=True, muted=Muted.ON),
        "media": Image("assets/photo.jpg", fit=MediaFit.COVER),
    },
    animations=[animations.PlayVideo("video")],  # or: start it on a click
)
```

Paths are relative to `deck.py`; keep media files in `assets/`.

A **PDF figure** (a plot or drawing from a paper) is used as it is, wherever a
picture goes: `<image href="../figures/plot.pdf#page=2" .../>` in an SVG,
`Image("figures/plot.pdf", page=2)` in `zones=`, `![](plot.pdf)` in Markdown.
No fragment means page 1. Always write the PDF's own path: the build converts
the page to SVG in `.inkflow/cache/pdf/` and the served slide shows it under
`_pdf/…` (with `data-inkflow-pdf` naming the PDF), but that cache is never a
source to reference or edit. A figure drawn for paper (black on transparent)
vanishes on a dark deck: give it `background="paper"` (`Image(...)`) or
`inkflow:background="paper"` (an SVG `<image>`) for a white card behind it.
A dashed placeholder box means no converter is installed
(`pip install "inkflow[pdf]"`, or poppler's `pdftocairo`).

A **chart** fills a zone the same way, plotted from a data file at build time
(keep data in `data/`; the first CSV row names the columns):

```python
from inkflow import Chart, ChartKind, Slide, animations

Slide(
    "demo.svg",  # contains <rect id="zone-sales" x="200" y="200" width="960" height="540"/>
    zones={
        "sales": Chart(
            "data/sales.csv",
            kind=ChartKind.LINE,
            x="quarter",
            y=["revenue", "cost"],
            title="Sales",
            labels=True,
        )
    },
    animations=[animations.FadeIn("sales-series-revenue")],  # one series at a time
)
```

Kinds: `BAR` (`stacked=`, `horizontal=`), `LINE`, `AREA` (`stacked=`),
`SCATTER`, `PIE` (`donut=`). `y_min=`/`y_max=` fix the value axis's ends;
`y2=["col"]` measures those columns on a second axis on the right (`y2_min=`,
`y2_max=`; not for stacked or horizontal bars). `Chart(data={"col": [...], ...})` writes the data
inline; `.tsv` and `.json` (records or columns) work too. Each series is the
group `<zone>-series-<column>` (pie slices `<zone>-slice-<category>`). In
Markdown, a ```` ```chart ```` block takes `key: value` lines (`kind`, `x`,
`y: a, b`, `title`, `stacked`, `horizontal`, `labels`, `legend`, `donut`,
`y_min`, `y_max`, `y2: c`, `y2_min`, `y2_max`, `id`, `aspect: 4:3`) and either `data: ../data/x.csv` (relative to the `.md`)
or a Markdown table. To change a chart, edit its data file; never edit the
drawn SVG.

A **draw.io diagram** is `diagrams/<name>.drawio.svg` (draw.io's editable SVG:
a picture with the diagram's `<mxfile>` source in the root's `content`
attribute, stored uncompressed), shown on a slide as an `<image href>`. To
change one, edit the `<mxGraphModel>` inside `content` *and* the drawing, or
better ask the author to open it in draw.io (double-click it in the editor).
`inkflow clean --stdout FILE` prints its source readably. With
`inkflow:drawio="inline"` (or `"themed"`: the deck's colours and fonts) on that
`<image>`, the build draws the diagram into the slide instead of its picture;
each draw.io cell is then an element named `<image id>-<cell id>` that
`animations=[...]` can target (`FadeIn("flow-client")`) and a connector can
attach to (`inkflow:connect-end="flow-client:left"`). Change a diagram's
shapes in its `<mxGraphModel>` (geometry, `value`, `style`), never in the
picture alone: draw.io redraws the picture from the source.

## Text boxes, colours and links

- A free text box is a zone too: a `<rect id="zone-text">` (or `zone-text-2`, …) in
  the slide's own SVG, filled by a `::text::` section in the slide's `.md` (or
  `zones={"text": "..."}`). Its text wraps; SVG `<text>` does not.
- Slide text belongs in the slide's `.md` file, not in `deck.py`: give a slide
  without one `md="<slide-id>.md"` in `slides/` (the editor does the same on the
  first text typed into it); keep `zones={...}` for images, videos and `TextBox`.
- Text inside a drawn shape: give the zone rect (or ellipse) its own fill/stroke and
  `inkflow:show-shape="true"`; the shape is then painted as the text box's
  background and border (otherwise a zone shape is only a placeholder). Padding and
  alignment are `--inkflow-padding` / `--inkflow-align` / `--inkflow-valign` in its
  `style`.
- Colour a few words with the theme palette:
  `<span class="inkflow-color-accent">words</span>` (any colour token).
- Link to another slide with `[label](slide:<id>)` in Markdown, or wrap an SVG
  object in `<a href="slide:<id>">`; web links open in a new tab.
- Deck-wide colours and fonts: override `--inkflow-*` tokens in the project's
  `styles.css` (the editor's Theme dialog keeps them in one marked
  `/* inkflow:theme */` block; leave that block's markers intact).
- `inkflow:locked="true"` on an object keeps the visual editor from selecting it.
- An arrow attached to shapes is a `<path inkflow:connector="straight|elbow|curved"
  inkflow:connect-start="<id>:right" inkflow:connect-end="<id>:left" d="…">` (sides:
  top, right, bottom, left, or a point along a side: `top@0.25`, clockwise from the
  side's first corner; a shape's `inkflow:sites="3"` offers three per side). An
  elbow's moved middle segment is `inkflow:bend="x:640"` (or `y:`) in slide units.
  Keep its `d` roughly right; the author's "Re-route all"
  in the editor snaps it to the shapes. Rename an id and update `connect-*` too.

## Working on a branch

When the author asks for a proposal, a variant, an alternative, or to "work on
a branch", don't touch their deck:

1. `inkflow worktree add <name>` (short, kebab-case). It makes branch
   `deck/<name>` in `.inkflow/worktrees/<name>` and prints `path:` and `deck:`.
2. Work only there: `--deck <that deck.py>` on every inkflow command
   (`outline`, `slide`, `verify`, `render`…), edit only files under `path:`,
   and commit there (`git -C <path> add -A`, `git -C <path> commit -m …`).
   `inkflow context` still describes the author's editor on their own deck.
3. Commit when done and tell the author to review it with **Compare** in the
   editor's Git menu (or `inkflow compare`). They merge it themselves (Git
   menu, or `inkflow worktree merge <name>`); don't merge or remove a
   worktree unless asked.

## Check your work

1. `inkflow verify` for authoring mistakes (missing ids, zones, layouts).
2. `inkflow render --check` measures every slide in a browser, without images,
   and prints one line per layout problem (`slide 3 (intro): #zone-content:
   text overflows its zone by 120px (bottom)`; also code blocks cut off,
   objects outside the slide, text too small to read, and text whose
   contrast with the pixels behind it is too low: `contrast 2.3:1 against
   its background (needs 4.5:1): #9ca0b0 on #eff1f5`), exit 1 on a problem.
   Fix what it reports: shorten text, enlarge the zone, move the object, or
   use a theme colour that stands out from what is behind the text (check
   both `mode`s if the deck may be shown in either).
3. `inkflow render --sheet` writes one contact-sheet PNG of all slides
   (labelled with number and id) to `.inkflow/render/sheet.png`: read it to
   check flow and consistency. `inkflow render` writes one PNG per slide (the
   editor's current slide by default; `--slide N`, `--all`, `--step S`) and
   prints the same findings. Overlapping objects are only visible in the
   images: look before you report back.
4. On a branch or in a worktree, `inkflow compare main .` lists the slides
   your work changed compared with main (`~` changed, with the files; `+`
   added; `-` removed; `↕` moved); `--sheet` writes them side by side
   (`.inkflow/render/compare.png`). Check it lists only what you meant to change.

Keep edits small and in the author's style: the files are diffed and committed
like code. SVGs are XML; keep existing ids and structure, and change only what
was asked.
