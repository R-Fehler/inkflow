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

## What the author is looking at

`inkflow context` prints the editor's current slide, build step and
selection: each selected object's id, tag, source file and position. A prompt
hook adds the same text to each message while the editor is open, so "align
these", "make this blue" or "animate the selected boxes" refer to that
selection. Run it again whenever you need the current state.

Point the author at something with `inkflow goto N` (1-based slide number)
and `inkflow select ID [ID…]` (selects elements on the current slide).

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

Colours: prefer the theme's classes over hex values so slides follow dark and
light mode: `class="inkflow-fill-accent"`, `inkflow-stroke-text`, and so on
for `bg surface border text text-muted accent accent-fg code-bg code-text red
orange yellow green teal blue purple pink grey`.

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

## Check your work

1. `inkflow verify` for authoring mistakes (missing ids, zones, layouts).
2. `inkflow render` writes PNGs of slides (the editor's current slide by
   default; `--slide N`, `--all`, `--step S`) to `.inkflow/render/`. Read the
   image to see the result before you report back. Overlapping text, content
   running out of its zone and low contrast are only visible there.

Keep edits small and in the author's style: the files are diffed and committed
like code. SVGs are XML; keep existing ids and structure, and change only what
was asked.
