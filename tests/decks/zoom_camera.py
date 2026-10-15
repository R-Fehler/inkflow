"""Feature-test deck for authored camera moves (``animations.Zoom``).

Serve it with ``uv run inkflow serve -d tests/decks/zoom_camera.py`` and step
through with the arrow keys, forwards and backwards. Press an arrow again while a
camera move is still running: same direction snaps it, opposite direction reverses it.

1. pipeline: arrives already framed on "ingest" (zero-length step-0 zoom), then walks
   queue → workers (the note fades in with the move) → storage → full slide. The
   frames sit on a hidden layer with a pink stroke: none of them may ever show.
   Ctrl-zoom inside a frame stays inside it, and ``0`` returns to the frame, not the
   full slide. Stepping while Ctrl-zoomed eases back to the frame first.
2. dive: arrives at the full slide and dives into the corner after the transition
   (timed step-0 zoom). The corner touches the canvas edge, so the view stays inside
   the slide. The next step reads note a, then note b, as one chained step.
3. framing: a wide strip, a tall column, a small text label with a margin, a card
   rotated inside nested transforms, and a frame hanging off the top-left corner.
   Every view keeps the slide's shape. The slide ends zoomed in.
4. layout: pushes in from that zoomed view. The camera targets ``zone-content``,
   a zone that lives in the built-in ``content`` layout.
5-6. morph: both slides arrive zoomed on opposite sides; the morph carries the shapes
   from one zoomed view into the other.

Also check the presenter panel (``p``): its next preview shows the next step's
framing. The overview thumbnails show each slide's last step.

Also built (not served) by ``tests/test_decks.py`` as a compilation smoke test.
"""

from inkflow import Deck, Inline, Slide, Trigger, animations, transitions


def main() -> Deck:
    return Deck(
        transition=transitions.Crossfade(),
        slides=[
            Slide(
                "slides/zoom-pipeline.svg",
                id="pipeline",
                animations=[
                    animations.Zoom("frame-ingest", Trigger.WITH_PREVIOUS, duration=0),
                    animations.Zoom("frame-queue"),
                    animations.Zoom("frame-workers"),
                    animations.FadeIn("workers-note", Trigger.WITH_PREVIOUS, delay=0.5),
                    animations.Zoom("frame-storage"),
                    animations.Zoom(),
                ],
            ),
            Slide(
                "slides/zoom-dive.svg",
                id="dive",
                animations=[
                    animations.Zoom("corner", Trigger.WITH_PREVIOUS, duration=1.2),
                    animations.Zoom("note-a", margin=20),
                    animations.Zoom("note-b", Trigger.AFTER_PREVIOUS, margin=20),
                ],
            ),
            Slide(
                "slides/zoom-framing.svg",
                id="framing",
                animations=[
                    animations.Zoom("timeline", margin=20),
                    animations.Zoom("column", margin=20),
                    animations.Zoom("tiny-label", margin=30),
                    animations.Zoom("rotated-card", margin=20),
                    animations.Zoom("frame-corner"),
                ],
            ),
            Slide(
                "content",
                id="layout",
                transition=transitions.Push(),
                md=Inline(
                    "# Zones are targets too\n\n"
                    + "- the camera frames `zone-content`\n"
                    + "- which the built-in layout declares\n"
                ),
                animations=[
                    animations.Zoom("zone-content", margin=20),
                    animations.Zoom(),
                ],
            ),
            Slide(
                "slides/zoom-morph-a.svg",
                id="morph-a",
                transition=transitions.Cut(),
                animations=[
                    animations.Zoom("frame-left", Trigger.WITH_PREVIOUS, duration=0),
                ],
            ),
            Slide(
                "slides/zoom-morph-b.svg",
                id="morph-b",
                transition=transitions.Morph(duration=2.0),
                animations=[
                    animations.Zoom("frame-right", Trigger.WITH_PREVIOUS, duration=0),
                ],
            ),
        ],
    )
