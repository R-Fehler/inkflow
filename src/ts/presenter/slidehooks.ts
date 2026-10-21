// What happens around a slide change besides the slide itself. A module that
// works on the mounted slide (shrink-to-fit: presenter/fit.ts) registers
// here, so transitions.ts, which calls these, needs none of those modules,
// nor its unit tests their part of the page.

const mounted: (() => void)[] = [];

// Run after a slide's markup is put on the stage, whichever way it got there.
export function onSlideMounted(fn: () => void): void {
    mounted.push(fn);
}

export function slideMounted(): void {
    for (const fn of mounted) fn();
}
