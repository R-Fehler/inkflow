// Connector geometry: where a shape's connection sites are, and the path an
// arrow takes between two points (straight, elbow or curved). Pure, so the
// routing is unit-tested; canvas.ts supplies the shapes' corners.
//
// A connector is a <path> carrying inkflow:connector="straight|elbow|curved"
// and, for each connected end, inkflow:connect-start / -end = "<id>:<site>".
// Its `d` always starts with "M x y" and ends with the end point's own
// coordinates, so a free end is read back from the path itself.

export interface Pt {
    x: number;
    y: number;
}

export type SiteName = "top" | "right" | "bottom" | "left";

export interface Site extends Pt {
    name: SiteName;
    // Outward direction (unit vector): where the line leaves the shape.
    dx: number;
    dy: number;
}

export type ConnectorStyle = "straight" | "elbow" | "curved";

export const SITE_NAMES: SiteName[] = ["top", "right", "bottom", "left"];

/**
 * The four sites of a shape from its corners (top-left, top-right,
 * bottom-right, bottom-left, as transformed): the middle of each edge, facing
 * away from the centre, so they follow rotation.
 */
export function sitesFromCorners(c: Pt[]): Site[] {
    const centre = {
        x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
        y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
    };
    const edges: [SiteName, Pt, Pt][] = [
        ["top", c[0], c[1]],
        ["right", c[1], c[2]],
        ["bottom", c[2], c[3]],
        ["left", c[3], c[0]],
    ];
    return edges.map(([name, a, b]) => {
        const x = (a.x + b.x) / 2;
        const y = (a.y + b.y) / 2;
        const len = Math.hypot(x - centre.x, y - centre.y) || 1;
        return {
            name,
            x,
            y,
            dx: (x - centre.x) / len,
            dy: (y - centre.y) / len,
        };
    });
}

export function nearestSite(sites: Site[], p: Pt, within: number): Site | null {
    let best: Site | null = null;
    let bestD = within;
    for (const s of sites) {
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d <= bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}

export interface End extends Pt {
    // Outward direction at a connected site; absent at a free end.
    dx?: number;
    dy?: number;
}

// A free end's direction: back toward the other end, along its main axis.
function direction(end: End, other: Pt): Pt {
    if (end.dx !== undefined && end.dy !== undefined) {
        return { x: end.dx, y: end.dy };
    }
    const dx = other.x - end.x;
    const dy = other.y - end.y;
    return Math.abs(dx) >= Math.abs(dy)
        ? { x: Math.sign(dx) || 1, y: 0 }
        : { x: 0, y: Math.sign(dy) || 1 };
}

function horizontal(d: Pt): boolean {
    return Math.abs(d.x) >= Math.abs(d.y);
}

export interface Route {
    // Points of a polyline, or [start, c1, c2, end] of one cubic curve.
    points: Pt[];
    curve: boolean;
}

/** The route between two ends, in the coordinates the ends are given in. */
export function route(style: ConnectorStyle, a: End, b: End): Route {
    if (style === "curved") {
        const da = direction(a, b);
        const db = direction(b, a);
        const k = Math.max(30, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
        return {
            curve: true,
            points: [
                { x: a.x, y: a.y },
                { x: a.x + da.x * k, y: a.y + da.y * k },
                { x: b.x + db.x * k, y: b.y + db.y * k },
                { x: b.x, y: b.y },
            ],
        };
    }
    if (style === "straight") {
        return {
            curve: false,
            points: [a, b].map((p) => ({ x: p.x, y: p.y })),
        };
    }
    // Elbow: leave and enter along each end's direction, turning at right
    // angles (one bend when the directions cross, two when they are parallel).
    const da = direction(a, b);
    const db = direction(b, a);
    const pts: Pt[] = [{ x: a.x, y: a.y }];
    if (horizontal(da) && horizontal(db)) {
        const mx = (a.x + b.x) / 2;
        pts.push({ x: mx, y: a.y }, { x: mx, y: b.y });
    } else if (!horizontal(da) && !horizontal(db)) {
        const my = (a.y + b.y) / 2;
        pts.push({ x: a.x, y: my }, { x: b.x, y: my });
    } else if (horizontal(da)) {
        pts.push({ x: b.x, y: a.y });
    } else {
        pts.push({ x: a.x, y: b.y });
    }
    pts.push({ x: b.x, y: b.y });
    // Drop bends that are not bends (aligned ends).
    const out = pts.filter((p, i) => {
        if (i === 0 || i === pts.length - 1) return true;
        const prev = pts[i - 1];
        const next = pts[i + 1];
        const collinear =
            Math.abs(
                (p.x - prev.x) * (next.y - p.y) -
                    (p.y - prev.y) * (next.x - p.x),
            ) < 1e-6;
        return !collinear;
    });
    return { curve: false, points: out };
}

function n(v: number): string {
    return String(Math.round(v * 100) / 100);
}

export function pathData(r: Route): string {
    const [first, ...rest] = r.points;
    const head = `M${n(first.x)},${n(first.y)}`;
    if (r.curve) {
        return `${head} C${rest.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")}`;
    }
    return `${head} ${rest.map((p) => `L${n(p.x)},${n(p.y)}`).join(" ")}`;
}

/** First and last point of a path's data (a connector's two ends). */
export function endpointsOf(d: string): { start: Pt; end: Pt } | null {
    const nums = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (nums.length < 4 || nums.some((v) => !Number.isFinite(v))) return null;
    return {
        start: { x: nums[0], y: nums[1] },
        end: { x: nums[nums.length - 2], y: nums[nums.length - 1] },
    };
}

export interface Connection {
    id: string;
    site: SiteName;
}

export function parseConnection(value: string | null): Connection | null {
    if (!value) return null;
    const i = value.lastIndexOf(":");
    const site = value.slice(i + 1) as SiteName;
    if (i <= 0 || !SITE_NAMES.includes(site)) return null;
    return { id: value.slice(0, i), site };
}
