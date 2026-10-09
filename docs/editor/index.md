# Visual editor

`inkflow edit` opens a slide editor in the browser: a slide list on the left, the
slide in the middle, its properties on the right and the speaker notes below.
You click, drag and type on the real slide, the same rendering the presenter shows,
and every change is written straight back into the deck's own files.

```bash
inkflow edit            # opens http://localhost:7777/edit
```

It is the same server as `inkflow serve`: the presenter stays at `/`, and
<kbd>e</kbd> in the terminal opens the editor again. There is no separate project
format and nothing to import. The editor, Inkscape, your text editor and an
agent such as [Claude Code](claude-code.md) can all work on a deck at the same time;
the file watcher shows each one the others' changes within a moment.

## Where an edit goes

| You change… | …and the editor writes |
|---|---|
| A shape, text, image, its position, size, rotation, colour | The slide's SVG, in place: only the attributes you touched |
| Text in a Markdown zone | That zone's section of the slide's `.md` file |
| Text in a zone filled from `deck.py` | The `zones={...}` entry in `deck.py` |
| Slide order, new / duplicate / hidden / deleted slides | The `Deck(slides=[...])` list in `deck.py` |
| Transition, animations, title, font size | That slide's `Slide(...)` call in `deck.py` |
| Speaker notes | The slide's notes file (created on first edit if it has none) |
| An inserted image | Copied into `assets/`, referenced relative to the SVG |
| An inserted video | Copied into `assets/`; a `zone-video` rect in the slide's SVG plus `zones={"video": Video(...)}` in `deck.py`, as one undo step |
| An image or video zone's settings | Its `Image(...)` / `Video(...)` call in `deck.py` |
| A new text box | A `zone-text` rect in the slide's SVG; its Markdown in the slide's `.md` file (or `zones={...}` when it has none) |
| A crop | The picture's SVG: the `<image>` goes into a nested `<svg>` frame |
| A link, alt text, hiding, locking | The object in the SVG: an `<a href>` around it, a `<title>`, `display:none`, `inkflow:locked` |
| Theme colours and fonts | One marked block in the project's `styles.css` |
| Colour mode, base font size | `Deck(mode=..., font_size=...)` in `deck.py` |

`deck.py` is edited structurally: comments and formatting are kept, and a comment
written above a slide moves with it. If your slide list is built in code (a loop, a
helper function), the editor shows those slides but leaves slide-level settings to
you, read-only.

Every edit is one undo step (<kbd>Ctrl</kbd>+<kbd>Z</kbd>). A burst of typing is
one step, not one per keystroke. Undo restores the exact bytes it replaced, and it
refuses rather than overwrite a file that was changed outside the editor since.

## Several decks, and copying between them

Run `inkflow edit` once per deck. Each instance takes the next free ports
(7777, then 7779, …), so the editors open side by side in your browser, like
two PowerPoint windows.

Slides copy between them through the system clipboard. Select slides in the
slide list (<kbd>Ctrl</kbd>+click adds one, <kbd>Shift</kbd>+click a range),
press <kbd>Ctrl</kbd>+<kbd>C</kbd> (or right-click → Copy), switch to the other
editor, pick the slide to paste after, and press <kbd>Ctrl</kbd>+<kbd>V</kbd>.
A copied slide takes everything it needs with it: its SVG, Markdown and notes,
the project's own layouts it is built on, and every image or video it shows.
In the receiving project:

- a file that is already there with the same contents is reused, so a shared
  layout or logo is not duplicated;
- anything else that would clash gets a new name (`intro-2.svg`), and every
  reference to it (in `deck.py`, in the SVGs that build on it, in Markdown
  image links) is rewritten to match;
- the pasted `Slide(...)` calls go into `Deck(slides=[...])` in one undoable
  step, with any `from inkflow import` names they need.

Pasting into the deck the slides came from makes independent copies.

Objects copy the same way: select shapes, <kbd>Ctrl</kbd>+<kbd>C</kbd>, and
<kbd>Ctrl</kbd>+<kbd>V</kbd> on a slide in either editor; images come along.

Two things cannot travel. Animation or transition types a deck defines in its
own `deck.py` are left out, and copying says which. Slide-specific overlays are
dropped too, since the receiving deck's own overlays apply. And because the
clipboard is shared with everything else on your computer, a paste only accepts
a plain `Slide(...)` built from inkflow's own types, never arbitrary Python.

## The canvas

- **Select** with a click; <kbd>Shift</kbd>+click adds to the selection; drag on
  an empty area to select everything inside a box. <kbd>Ctrl</kbd>+<kbd>A</kbd>
  selects all.
- **Move** by dragging or with the arrow keys (<kbd>Shift</kbd> moves 10 units).
  Smart guides snap to the slide's edges and centre and to other objects;
  hold <kbd>Alt</kbd> to drag freely, <kbd>Shift</kbd> to keep to one axis.
- **Resize** with the handles. Text, images and circles keep their proportions;
  <kbd>Shift</kbd> toggles that.
- **Rotate** with the round handle above the selection; <kbd>Shift</kbd> snaps to
  15°.
- **Reach an object under another** with a middle-click (or <kbd>Alt</kbd>+click):
  each click selects the next object under the pointer, topmost first.
- **Edit text** by double-clicking it. Text inside a group is edited directly.
- **Enter a group** by double-clicking it; <kbd>Esc</kbd> leaves it.
- **Zoom** with <kbd>Ctrl</kbd>+scroll or <kbd>+</kbd> / <kbd>−</kbd>;
  <kbd>0</kbd> fits the slide to the window.

The editor shows every object by default. To see what the audience sees at a given
click, pick a build step in the toolbar; editing pauses while you preview.

## Text boxes and Markdown zones

Text in a layout's zones, and in text boxes, is Markdown: double-click it and you
edit the text right where it is on the slide, with a formatting bar above it:

- paragraph style (text, title, heading, subheading, quote);
- **bold**, *italic*, ~~strikethrough~~ and `code` for the selected words
  (<kbd>Ctrl</kbd>+<kbd>B</kbd>, <kbd>Ctrl</kbd>+<kbd>I</kbd> work too);
- a text colour from the theme's palette, so coloured words follow dark and light
  mode;
- links (<kbd>Ctrl</kbd>+<kbd>K</kbd>): a web address, or `slide:<id>` to jump to
  another slide;
- bulleted and numbered lists (<kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd>
  indent and outdent);
- tables: insert one, then <kbd>Tab</kbd> moves from cell to cell (and adds a row
  at the end), and the bar gains buttons to add or delete rows and columns and to
  align a column.

Click outside the text (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>) to finish; it is saved
as ordinary Markdown in the same file it came from, as one undo step;
<kbd>Esc</kbd> cancels. Pasting brings plain text only.

Some Markdown has no in-place form: math, code blocks, images, `::step::` reveals.
A zone that contains any of them opens its Markdown source in a pane under the
slide instead, where the slide re-renders as you type; the **M↓** button switches
to that pane at any time. Nothing is ever dropped: the editor only edits in place
when it can write back exactly what the zone holds.

Empty zones show a small **+ zone** label; click it to start writing (or to pick an
image or video, for zones named like `media`, `image` or `video`).

## Drawing

The toolbar's rectangle, ellipse, line and arrow tools draw new objects. Click to
drop one at a default size, or drag to size it. New shapes use the theme's colour
classes (`inkflow-fill-surface`, `inkflow-stroke-accent`, …), so they follow dark
and light mode like everything else. Images can be picked from the toolbar,
dropped onto the slide or pasted from the clipboard.

The **text** tool draws a text box: drag out its width (or click for a default
one) and start typing. The text wraps inside the box, takes every formatting
above, and the box grows to fit what you type. A text box you empty is deleted.
Under the hood it is a zone of its own (a `zone-text` rect), so its Markdown lives
with the slide's other text. Where there is nowhere to keep Markdown (a slide list
built in code, or while editing a layout), the tool places a plain SVG text line.

Many slides are drawn directly by a shared layout (`Slide("content", md=...)`).
The first time you draw on one, the editor gives it its own SVG in `slides/`, built
on that same layout, and points the slide at it. Nothing changes visually, and the
layout itself is left alone.

## Pictures

Select a picture and the panel offers:

- **Crop**, or double-click the picture: the handles now trim its edges while the
  picture stays put, and the part cut away shows faded around it. <kbd>Enter</kbd>
  or <kbd>Esc</kbd> ends cropping, **Reset crop** shows the whole picture again.
  In the SVG a cropped picture is a small `<svg>` frame around the `<image>`, which
  Inkscape and browsers show the same way.
- **Replace…** swaps in another file at the same size and place.
- **Fit**: fit inside its box, fill it (cropping the edges), or stretch.
- **Alt text**, for screen readers (any object has it, see below).

## Video

Pick a video with the toolbar's **Video** button (<kbd>Shift</kbd>+<kbd>I</kbd>) or
drop one onto the slide. It lands where you dropped it, sized to its own aspect
ratio, and can be moved and resized like any shape. Under the hood it is an
ordinary zone: the editor adds a `zone-video` rect to the slide's SVG and fills it
from `deck.py` with `Video("assets/clip.mp4")`, so it plays in the presenter, the
static build and the PDF exactly like a hand-written one.

Dropping an image or video **onto a media zone** (an empty one, or one already
showing media) fills that zone instead. Replacing a file keeps the zone's settings
(fit, loop, autoplay…) and drops only what belonged to the old file: its poster,
trim and light-mode alternative.

Select a video zone and the panel shows its settings: fit and anchor, controls,
autoplay, loop, when to mute, a poster image and trim start / end in seconds. An
image zone gets fit and anchor. To start a clip on a click rather than when the
slide appears, add a **PlayVideo** animation to it.

## Layouts and overlays

Objects that come from a layout or an overlay are shared by every slide built on
them, so a normal click passes through them. **Edit layout** in the toolbar makes
them selectable; changes then go to the layout or overlay file, and the editor
reminds you how many slides that affects. Built-in and theme layouts are not part
of your project and stay read-only.

## The properties panel

- **Nothing selected:** the slide's title, layout, font size, visibility, its
  transition (with all of its settings) and the order of its animations, plus the
  files it is made of.
- **One object:** its id, position, size and rotation; fill and stroke as theme
  colours or any colour; stroke width, opacity, corner radius; font, size, weight
  and alignment for text; arrangement; and its animations, each with every setting
  its type has. Adding an animation to an object without an id gives it one.
- **An image or video zone:** its file, plus the settings above.
- **Several objects:** align, distribute, a common size and style, group.

Every object also has a **link** and **alt text**. A link is a web address or
`slide:<id>` (the field suggests every slide; a slide number works too). In the
presentation, clicking a linked object jumps to that slide, or opens the web page
in a new tab. The editor writes the link as an SVG `<a>` around the object and
keeps it with the object when it is moved, duplicated, reordered or deleted. Alt
text is the object's `<title>`, which screen readers read and browsers show as a
tooltip.

Renaming an object keeps the slide's animations pointing at it.

## Objects

The **Objects** tab next to Properties lists every object on the slide, topmost
first, like PowerPoint's selection pane: layers and groups fold open, and objects
from layouts and overlays are listed dimmed. Click a name to select it (also one
hidden under others), double-click to rename it, and use the two buttons on each
row to:

- **hide** it: `display:none` in the SVG, so it is hidden in the presentation too;
- **lock** it: `inkflow:locked="true"`, which only the editor reads. A locked
  object, or anything in a locked layer or group, cannot be selected on the slide,
  so a background stays put while you work on top of it.

## Theme

**Theme** in the toolbar sets the look of the whole deck: every colour of the
active theme, for dark and for light mode, the body, heading and code fonts, the
base font size and whether the deck shows in dark or light mode. Colours preview
while you drag the picker; the open presenter windows restyle as soon as the change
is saved. ↺ returns a colour or font to the theme's own.

Colours and fonts are written as one marked block in the project's `styles.css`,
which overrides the theme without changing it, and the rest of that file is left
alone. Fonts found in `fonts/`, in the theme or on your computer are embedded in
the deck, so a build carries them.

## Find and replace

<kbd>Ctrl</kbd>+<kbd>F</kbd> (or <kbd>Ctrl</kbd>+<kbd>H</kbd> to start in the
replace field) searches the whole deck: text on the slides, their Markdown and
speaker notes, and the text in `deck.py` (titles and zone text, never code).
Matches are listed by slide; click one to go there. Match case, whole words and
regular expressions are toggles, and the search can be limited to the current
slide. **Replace** changes the chosen match, **All** every match, as one undo step.

## Export

**Export** in the toolbar builds the deck the way the command line does, and saves
the result next to `deck.py` (the path can be changed):

| Format | Like | Result |
|---|---|---|
| Web page | `inkflow build` | `build/`, a folder with `index.html` and the deck's media; opens offline |
| Single HTML file | `inkflow build --inline-assets` | one `.html` file with everything inside, easy to send |
| PDF | `inkflow export` | one page per slide (needs Chromium or Chrome) |

Each result can also be downloaded straight from the dialog (the web page as a
`.zip`).

## Keyboard

| Key | Action |
|---|---|
| <kbd>V</kbd> <kbd>T</kbd> <kbd>R</kbd> <kbd>O</kbd> <kbd>L</kbd> <kbd>A</kbd> <kbd>I</kbd> | Select, text, rectangle, ellipse, line, arrow, image |
| <kbd>Shift</kbd>+<kbd>I</kbd> | Insert a video |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> <kbd>X</kbd> <kbd>V</kbd> <kbd>D</kbd> | Copy, cut, paste, duplicate (objects, or slides in the slide list) |
| <kbd>Delete</kbd> | Delete the selection (or clear a zone; in the slide list, the selected slides) |
| <kbd>Ctrl</kbd>+<kbd>G</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Group / ungroup |
| <kbd>Ctrl</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> (+<kbd>Shift</kbd>) | Forward / backward (to front / back) |
| <kbd>Enter</kbd> | Edit the selected text or zone (when cropping: done) |
| Middle-click, <kbd>Alt</kbd>+click | Select the next object under the pointer |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> / <kbd>Ctrl</kbd>+<kbd>H</kbd> | Find / replace |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> <kbd>I</kbd> <kbd>K</kbd> (in text) | Bold, italic, link |
| <kbd>Tab</kbd> (in a table) | Next cell |
| <kbd>PageUp</kbd> <kbd>PageDown</kbd> | Previous / next slide |
| <kbd>Ctrl</kbd>+<kbd>M</kbd> | New slide |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Present from this slide |

## What stays in Inkscape

The editor covers the everyday slide work. Path and node editing, gradients,
filters, masks and anything else a vector editor is for stay with Inkscape (or
your editor of choice); open the same file there, and the editor picks up the
result when you save.
