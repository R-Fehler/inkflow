// Measuring SVG elements on screen.
//
// Measurements go through getScreenCTM() rather than getCTM(). getCTM()'s reference frame
// depends on where the nearest SVG viewport is in the tree, so a child's getCTM() and the
// root's are not in the same space and cannot be directly compared. getScreenCTM() always
// uses the screen origin, so every element's measurement is directly comparable regardless
// of nesting depth.

// The element's screen matrix, or null when it has no layout box.
//
// getScreenCTM() returns a legacy SVGMatrix whose scale() is uniform-only — it keeps the
// first factor and silently drops the second (non-uniform scaling lived on the separate
// scaleNonUniform()). So calling scale(width, height) on it would square a box to
// width × width and leak the box's aspect ratio into every measurement as a vertical
// stretch on any non-square element (square shapes are unaffected, which is how it once
// went unnoticed). Re-wrapping it in a real DOMMatrix makes scale(width, height) genuinely
// non-uniform.
export function screenMatrix(element: SVGGraphicsElement): DOMMatrix | null {
    const ctm = element.getScreenCTM();
    return ctm ? DOMMatrix.fromMatrix(ctm) : null;
}

// The affine map that takes a box, as the unit square, through `screen`:
// screen · translate(box) · scale(box).
export function boxFrame(screen: DOMMatrix, box: DOMRect): DOMMatrix {
    return screen.translate(box.x, box.y).scale(box.width, box.height);
}
