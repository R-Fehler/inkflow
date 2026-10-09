import { describe, expect, test } from "vitest";
import {
    endpointsOf,
    nearestSite,
    parseConnection,
    pathData,
    route,
    sitesFromCorners,
} from "./connectors";

const square = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
    { x: 0, y: 50 },
];

describe("sites", () => {
    test("one per edge, facing outward", () => {
        const s = sitesFromCorners(square);
        expect(s.map((x) => [x.name, x.x, x.y, x.dx, x.dy])).toEqual([
            ["top", 50, 0, 0, -1],
            ["right", 100, 25, 1, 0],
            ["bottom", 50, 50, 0, 1],
            ["left", 0, 25, -1, 0],
        ]);
    });

    test("follow rotation", () => {
        // The square turned 90° about the origin.
        const turned = square.map((p) => ({ x: -p.y, y: p.x }));
        const right = sitesFromCorners(turned)[1];
        expect(right.x).toBeCloseTo(-25);
        expect(right.y).toBeCloseTo(100);
        expect(right.dy).toBeCloseTo(1);
    });

    test("nearest within a distance", () => {
        const s = sitesFromCorners(square);
        expect(nearestSite(s, { x: 96, y: 30 }, 10)?.name).toBe("right");
        expect(nearestSite(s, { x: 50, y: 25 }, 10)).toBeNull();
    });
});

describe("routes", () => {
    const a = { x: 100, y: 25, dx: 1, dy: 0 }; // right side of one box
    const b = { x: 300, y: 125, dx: -1, dy: 0 }; // left side of another

    test("straight", () => {
        expect(pathData(route("straight", a, b))).toBe("M100,25 L300,125");
    });

    test("elbow between facing sides turns twice, halfway", () => {
        expect(pathData(route("elbow", a, b))).toBe(
            "M100,25 L200,25 L200,125 L300,125",
        );
    });

    test("elbow from a side to a top turns once", () => {
        const top = { x: 300, y: 125, dx: 0, dy: -1 };
        expect(pathData(route("elbow", a, top))).toBe(
            "M100,25 L300,25 L300,125",
        );
    });

    test("elbow between aligned ends is straight", () => {
        const level = { x: 300, y: 25, dx: -1, dy: 0 };
        expect(pathData(route("elbow", a, level))).toBe("M100,25 L300,25");
    });

    test("curved leaves and enters along the sites", () => {
        const d = pathData(route("curved", a, b));
        expect(d.startsWith("M100,25 C")).toBe(true);
        expect(d.endsWith(" 300,125")).toBe(true);
        const r = route("curved", a, b);
        expect(r.points[1].y).toBe(25); // leaves to the right
        expect(r.points[2].x).toBeLessThan(300); // enters from the left
    });

    test("a free end routes too", () => {
        expect(
            pathData(route("elbow", { x: 0, y: 0 }, { x: 100, y: 40 })),
        ).toBe("M0,0 L50,0 L50,40 L100,40");
    });
});

describe("paths and connections", () => {
    test("endpoints come back from the path data", () => {
        expect(endpointsOf("M1.5,2 C3,4 5,6 7,-8.25")).toEqual({
            start: { x: 1.5, y: 2 },
            end: { x: 7, y: -8.25 },
        });
        expect(endpointsOf("M1,2")).toBeNull();
    });

    test("connection values", () => {
        expect(parseConnection("box-1:right")).toEqual({
            id: "box-1",
            site: "right",
        });
        expect(parseConnection("box:middle")).toBeNull();
        expect(parseConnection(null)).toBeNull();
    });
});
