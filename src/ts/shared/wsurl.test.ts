// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { openSocket, socketUrl } from "./wsurl";

describe("socketUrl", () => {
    it("uses the page's own host and port", () => {
        expect(socketUrl({ protocol: "http:", host: "localhost:7777" })).toBe(
            "ws://localhost:7777/_inkflow/ws",
        );
        expect(socketUrl({ protocol: "http:", host: "192.168.1.5:7779" })).toBe(
            "ws://192.168.1.5:7779/_inkflow/ws",
        );
    });

    it("keeps a forwarded port and an IPv6 host", () => {
        expect(socketUrl({ protocol: "http:", host: "localhost:8000" })).toBe(
            "ws://localhost:8000/_inkflow/ws",
        );
        expect(socketUrl({ protocol: "http:", host: "[::1]:7777" })).toBe(
            "ws://[::1]:7777/_inkflow/ws",
        );
    });

    it("goes over TLS when the page does", () => {
        expect(
            socketUrl({ protocol: "https:", host: "box.tail1234.ts.net" }),
        ).toBe("wss://box.tail1234.ts.net/_inkflow/ws");
    });
});

describe("openSocket", () => {
    afterEach(() => {
        // The stand-in parent goes; the window is its own parent again.
        delete (window as { parent?: unknown }).parent;
    });

    it("takes the relay's channel when the frame's top window offers one", () => {
        const closed: number[] = [];
        const sock = { close: (code: number) => closed.push(code) };
        Object.defineProperty(window, "parent", {
            configurable: true,
            value: { __inkflowRelay: { openSocket: () => sock } },
        });
        expect(openSocket()).toBe(sock as unknown as WebSocket);
        window.dispatchEvent(new Event("pagehide"));
        expect(closed).toEqual([1001]);
    });
});
