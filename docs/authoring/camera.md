# Camera

A slide is a vector drawing, so it can be shown at any magnification.
A `Frame` cue moves the slide's camera to frame one part of it on a step.
That turns a dense diagram into a guided tour,
lays out a whole talk on one canvas,
or reveals detail too small to see at full size:

```python
from inkflow import Slide, animations

Slide(
    "architecture",
    animations=[
        animations.Frame("ingest"),
        animations.Frame("queue"),
        animations.Frame("storage"),
        animations.Frame(),  # back to the whole slide
    ],
)
```

Each `Frame` takes one keypress, like any other cue.
Stepping backward flies the camera back the way it came.

## Targets

A `Frame` targets an element by its `id`, the same way an animation does,
and fits that element on screen.
Any element works: a group, a shape, a line of text.

The target can also be hidden.
A rectangle on a hidden Inkscape layer marks a region without ever showing,
and the camera still frames it.

The slide's shape never changes,
so a target that is wider or taller than the slide shows a little more around it.
A target near the edge of the slide is shifted to stay inside it.

`margin` keeps some space around the target, in SVG user units:

```python
animations.Frame("total", margin=40)
```

`Frame()` with no target returns to the whole slide.
It is shorthand for `Frame(FrameTarget.FULL_SLIDE)`.

## Timing

`Frame` takes the same [timing parameters](../reference/animations.md#timedcue-base)
as an animation, and a [trigger](steps.md#animation-triggers) like any other cue,
so other animations can play along with it:

```python
from inkflow import Trigger

animations = [
    animations.Frame("workers"),
    animations.FadeIn("workers-note", Trigger.WITH_PREVIOUS),
]
```

## Starting framed

A `Frame` on step 0 (the first cue, with `Trigger.WITH_PREVIOUS`)
sets how the slide opens.
With a duration, the slide arrives whole and the camera dives in once it is on screen.
With `duration=0`, the slide arrives already framed:

```python
animations.Frame("ingest", Trigger.WITH_PREVIOUS)  # dives in on arrival
animations.Frame("ingest", Trigger.WITH_PREVIOUS, duration=0)  # arrives framed
```

A whole talk can live on one large canvas this way:
one slide, a starting view, and a `Frame` for every stop along the way.

## With transitions

A slide leaves from whatever view it is showing.
A [`Push`](transitions.md#push) slides the framed view away,
and a [`Morph`](morph.md) carries each shape from where it appears on screen
to where it appears on the next slide.

## While presenting

The step decides the view.
[Zooming by hand](../presenting/index.md#drawing-attention) with <kbd>Ctrl</kbd>
works inside it, and <kbd>0</kbd> returns to the step's view.
Moving to another step or slide first eases back to that view.
