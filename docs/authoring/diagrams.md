# draw.io diagrams

For diagrams beyond a few boxes and arrows (flowcharts, architecture, UML,
network maps), draw them in [draw.io](https://www.drawio.com) and save them as
*editable SVG*: `diagrams/flow.drawio.svg`. That is a normal picture of the
diagram with the diagram's source stored inside it, so it is
version-controlled like any other file, GitHub and GitLab show it as a picture,
and draw.io desktop, the VS Code draw.io extension or
[app.diagrams.net](https://app.diagrams.net) open the same file again.

A slide shows one like any picture, an `<image>` in its SVG (or an
`Image("diagrams/flow.drawio.svg")` zone, or `![](…)` in Markdown):

```xml
<image id="flow" href="../diagrams/flow.drawio.svg"
       x="200" y="240" width="1520" height="700"/>
```

## Picture or drawing

On a slide's `<image>`, `inkflow:drawio` chooses how the diagram is shown:

| `inkflow:drawio` | On the slide | Font | Colours |
|---|---|---|---|
| *(none)* | the picture draw.io saved | draw.io's | draw.io's |
| `"inline"` | the diagram's shapes, drawn into the slide | the deck's body font instead of draw.io's default (Helvetica); a font you pick in draw.io stays | draw.io's, in their dark or light version to match the deck's mode |
| `"themed"` | the same | the deck's fonts (body, or code for monospaced text) | the theme's: draw.io's palette maps to the theme's colours by name (its blue to the theme's blue, pale fills to tints), any other colour by hue; black text becomes the theme's text colour |

```xml
<image id="flow" inkflow:drawio="themed" href="../diagrams/flow.drawio.svg"
       x="200" y="240" width="1520" height="700"/>
```

The file keeps the `<image>`, so Inkscape and other SVG viewers still show the
picture; the diagram file itself is never changed. The build puts the
diagram's own SVG in the picture's place, at the picture's position and size.

## Animating its shapes

A drawn diagram's shapes are elements of the slide. Each one is named
`<picture id>-<draw.io id>` (`flow-client`; a picture without an id is named
after the file), so in `deck.py` it is targeted like any other element:

```python
from inkflow import Slide, animations

Slide(
    "architecture.svg",
    animations=[
        animations.FadeIn("flow-client"),
        animations.FadeIn("flow-server"),
    ],
)
```

draw.io keeps a shape's id when you edit the diagram, and shows it (and lets
you change it) in **Edit Data** (<kbd>Ctrl</kbd>+<kbd>M</kbd>), so its
animations stay attached. Every other id inside the diagram is prefixed the
same way, so a diagram shown twice, or beside the slide's own shapes, never
clashes.

## A background behind it

A diagram drawn for a white page has dark lines on nothing, and disappears on
a dark slide. `inkflow:background="paper"` on the `<image>` paints white
behind it, picture or drawing; see
[PDF figures](pdf-figures.md) for the other values.

## In git

`inkflow clean` and the pre-commit hook leave draw.io files alone. draw.io
usually compresses the source inside the file, which makes every change one
unreadable line; after [`inkflow setup-git`](inkscape.md#keeping-svgs-clean-in-git)
`git diff` shows the source as XML, one shape a line, compressed or not.
