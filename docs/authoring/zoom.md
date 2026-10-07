# Zooming

A slide is a vector drawing, so it can be shown at any magnification.
A `Zoom` cue moves the slide's camera to frame one part of it on a step,
which turns a dense diagram into a guided tour:

```python
from inkflow import Slide, animations

Slide(
    "architecture",
    animations=[
        animations.Zoom("frame-ingest"),
        animations.Zoom("frame-queue"),
        animations.Zoom("frame-storage"),
        animations.Zoom(),  # back to the whole slide
    ],
)
```

Each `Zoom` takes one keypress, like any other cue.
Stepping backward flies the camera back the way it came.

## Frames

A `Zoom` targets an element by its `id`, the same way an animation does.
Any element works: a group, a shape, a line of text.
The camera fits the element's bounding box on screen.

The most flexible target is a **frame**,
a rectangle drawn only to mark a region:

1. Draw a rectangle around the part of the slide you want to show.
2. Give it an id, for example `frame-ingest`
   (`inkflow label2id` [turns Inkscape labels into ids](inkscape.md#naming-elements-label2id)).
3. Keep it on its own layer, and hide that layer before saving.

A hidden frame never shows during the talk, but the camera still finds it.
Showing the layer again in Inkscape brings every frame back for editing,
so a stroke that stands out makes them easy to work with.

The slide's shape never changes,
so a frame that is wider or taller than the slide shows a little more around it:
a long, flat timeline also shows some of what sits above and below.
A frame near the edge of the slide is shifted to stay inside it.

`margin` keeps some space around the target, in SVG user units:

```python
animations.Zoom("total", margin=40)
```

## Back to the whole slide

`Zoom()` with no target returns to the whole slide.
It is shorthand for `Zoom(ZoomTarget.FULL_SLIDE)`.

## Timing

`Zoom` accepts `duration`, `easing` and `delay` like an animation,
and defaults to a 0.8 second `Easing.EASE_IN_OUT`.
The camera pulls back while it travels between distant frames
and moves almost directly between neighbouring ones.

A `Zoom` takes a [trigger](steps.md#animation-triggers) like any other cue,
so other animations can play along with it:

```python
from inkflow import Trigger

animations = [
    animations.Zoom("frame-workers"),
    animations.FadeIn("workers-note", Trigger.WITH_PREVIOUS, delay=0.5),
]
```

Two zooms on one step play one after the other with `Trigger.AFTER_PREVIOUS`.

## Starting zoomed

A `Zoom` on step 0 (the first cue, with `Trigger.WITH_PREVIOUS`)
sets how the slide opens.
With a duration, the slide arrives whole and the camera dives in once it is on screen.
With `duration=0`, the slide arrives already framed:

```python
animations.Zoom("frame-ingest", Trigger.WITH_PREVIOUS)  # dives in on arrival
animations.Zoom("frame-ingest", Trigger.WITH_PREVIOUS, duration=0)  # arrives framed
```

A whole talk can live on one large canvas this way:
one slide, a starting frame, and a `Zoom` for every stop along the way.

## With transitions

A slide leaves from whatever view it is showing.
A [`Push`](transitions.md#push) slides the zoomed view away,
and a [`Morph`](morph.md) carries each shape from where it appears on screen
to where it appears on the next slide, including that slide's starting frame.

The [`Zoom` transition](transitions.md#zoom) is a separate effect
that scales whole slides in and out.

## While presenting

The step decides the view.
[Zooming by hand](../presenting/index.md#drawing-attention) with <kbd>Ctrl</kbd>
works inside it, and <kbd>0</kbd> returns to the step's frame.
Moving to another step or slide first eases back to that frame.

The presenter panel's preview shows the next step's view,
and the overview shows each slide at its last step.
