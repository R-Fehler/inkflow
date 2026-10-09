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
format and nothing to import or export. The editor, Inkscape, your text editor and an
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

`deck.py` is edited structurally: comments and formatting are kept, and a comment
written above a slide moves with it. If your slide list is built in code (a loop, a
helper function), the editor shows those slides but leaves slide-level settings to
you, read-only.

Every edit is one undo step (<kbd>Ctrl</kbd>+<kbd>Z</kbd>). A burst of typing is
one step, not one per keystroke. Undo restores the exact bytes it replaced, and it
refuses rather than overwrite a file that was changed outside the editor since.

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
- **Edit text** by double-clicking it. Text inside a group is edited directly.
- **Enter a group** by double-clicking it; <kbd>Esc</kbd> leaves it.
- **Zoom** with <kbd>Ctrl</kbd>+scroll or <kbd>+</kbd> / <kbd>−</kbd>;
  <kbd>0</kbd> fits the slide to the window.

The editor shows every object by default. To see what the audience sees at a given
click, pick a build step in the toolbar; editing pauses while you preview.

## Markdown zones

A layout's zones show their content as on the slide. Double-click one and its
Markdown opens in a pane under the slide, in place of the notes. The slide
re-renders as you type, and the bar above the text has buttons for bold, italics,
headings, lists, code, math and `::step::` reveals. Empty zones show a small
**+ zone** label; click it to start writing (or to pick an image, for zones named
like `media` or `image`).

## Drawing

The toolbar's text, rectangle, ellipse, line and arrow tools draw new objects.
Click to drop one at a default size, or drag to size it. New shapes use the theme's
colour classes (`inkflow-fill-surface`, `inkflow-stroke-accent`, …), so they follow
dark and light mode like everything else. Images can be picked from the toolbar,
dropped onto the slide or pasted from the clipboard.

Many slides are drawn directly by a shared layout (`Slide("content", md=...)`).
The first time you draw on one, the editor gives it its own SVG in `slides/`, built
on that same layout, and points the slide at it. Nothing changes visually, and the
layout itself is left alone.

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
- **Several objects:** align, distribute, a common size and style, group.

Renaming an object keeps the slide's animations pointing at it.

## Keyboard

| Key | Action |
|---|---|
| <kbd>V</kbd> <kbd>T</kbd> <kbd>R</kbd> <kbd>O</kbd> <kbd>L</kbd> <kbd>A</kbd> <kbd>I</kbd> | Select, text, rectangle, ellipse, line, arrow, image |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>Ctrl</kbd>+<kbd>C</kbd> <kbd>X</kbd> <kbd>V</kbd> <kbd>D</kbd> | Copy, cut, paste, duplicate |
| <kbd>Delete</kbd> | Delete the selection (or clear a zone) |
| <kbd>Ctrl</kbd>+<kbd>G</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> | Group / ungroup |
| <kbd>Ctrl</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> (+<kbd>Shift</kbd>) | Forward / backward (to front / back) |
| <kbd>Enter</kbd> | Edit the selected text or zone |
| <kbd>PageUp</kbd> <kbd>PageDown</kbd> | Previous / next slide |
| <kbd>Ctrl</kbd>+<kbd>M</kbd> | New slide |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> | Present from this slide |

## What stays in Inkscape

The editor covers the everyday slide work. Path and node editing, gradients,
filters, masks and anything else a vector editor is for stay with Inkscape (or
your editor of choice); open the same file there, and the editor picks up the
result when you save.
