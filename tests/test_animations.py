from __future__ import annotations

from inkflow.animations import (
    Animation,
    Bounce,
    FadeIn,
    FadeOut,
    Highlight,
    ScaleIn,
    ScaleOut,
    SlideIn,
    SlideOut,
    TimedCue,
    Zoom,
)
from inkflow.enums import Direction, Easing, Trigger, ZoomTarget


def test_shared_params_concrete_defaults() -> None:
    # Defaults live in Python now (single source of truth), not in CSS.
    fade = FadeIn("a")
    assert fade.element == "a"
    assert fade.trigger == Trigger.ON_CLICK
    assert fade.duration == 0.4
    assert fade.easing == Easing.EASE
    assert fade.delay == 0.0


def test_trigger_is_second_positional() -> None:
    # element then trigger are the base positional slots; timing params are
    # kw_only, so the second positional is always the trigger.
    fade = FadeIn("a", Trigger.WITH_PREVIOUS)
    assert fade.trigger == Trigger.WITH_PREVIOUS
    assert fade.duration == 0.4


def test_shared_params_stored() -> None:
    fade = FadeIn("a", duration=0.8, easing=Easing.EASE_IN, delay=0.2)
    assert (fade.duration, fade.easing, fade.delay) == (0.8, "ease-in", 0.2)


def test_slide_in_defaults_and_fields() -> None:
    s = SlideIn("a")
    assert s.direction == Direction.LEFT
    assert s.distance == 60.0
    s2 = SlideIn("a", direction=Direction.RIGHT, distance=120)
    assert (s2.direction, s2.distance) == (Direction.RIGHT, 120)


def test_slide_out_defaults() -> None:
    assert SlideOut("a").direction == "left"


def test_scale_field() -> None:
    assert ScaleIn("a").scale == 0.8
    assert ScaleOut("a", scale=0.5).scale == 0.5


def test_bounce_defaults() -> None:
    b = Bounce("a")
    assert b.duration == 0.35  # overrides the base 0.4
    assert b.easing == Easing.cubic_bezier(0.34, 1.56, 0.64, 1)  # spring default
    assert isinstance(b.easing, Easing)
    assert b.distance == 14.0


def test_highlight_fields() -> None:
    h = Highlight("a", color="#f00", iterations=3)
    assert (h.color, h.iterations) == ("#f00", 3)
    assert Highlight("a").duration == 0.6  # overrides the base 0.4
    assert Highlight("a").color == "var(--accent)"


def test_all_types_are_animations() -> None:
    for cls in (
        FadeIn,
        FadeOut,
        Bounce,
        SlideIn,
        SlideOut,
        ScaleIn,
        ScaleOut,
        Highlight,
    ):
        assert isinstance(cls("a"), Animation)


def test_zoom_defaults_to_the_full_slide() -> None:
    zoom = Zoom()
    assert zoom.element == ZoomTarget.FULL_SLIDE
    assert (zoom.margin, zoom.duration, zoom.easing, zoom.delay) == (
        0.0,
        0.8,
        Easing.EASE_IN_OUT,
        0.0,
    )


def test_zoom_takes_a_positional_trigger() -> None:
    zoom = Zoom("frame", Trigger.WITH_PREVIOUS, margin=40, duration=0)
    assert (zoom.element, zoom.trigger) == ("frame", Trigger.WITH_PREVIOUS)
    assert (zoom.margin, zoom.duration) == (40, 0)


def test_zoom_is_timed_but_not_an_animation() -> None:
    assert isinstance(Zoom(), TimedCue)
    assert not isinstance(Zoom(), Animation)
    assert isinstance(FadeIn("a"), TimedCue)
