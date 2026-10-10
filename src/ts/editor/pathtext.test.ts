import { describe, expect, it } from "vitest";
import {
    assetRef,
    commonPrefix,
    isPdfRef,
    joinPath,
    pdfPage,
    samePath,
    splitTyped,
    startingWith,
    withPage,
    withSep,
} from "./pathtext";

describe("typed paths", () => {
    it("splits into the folder and the start of a name", () => {
        expect(splitTyped("/home/me/ta")).toEqual({
            dir: "/home/me/",
            prefix: "ta",
        });
        expect(splitTyped("/home/me/")).toEqual({
            dir: "/home/me/",
            prefix: "",
        });
        expect(splitTyped("C:\\Users\\me\\De")).toEqual({
            dir: "C:\\Users\\me\\",
            prefix: "De",
        });
        expect(splitTyped("talk")).toEqual({ dir: "", prefix: "talk" });
    });

    it("joins and compares with the path's own separator", () => {
        expect(joinPath("/home/me", "talks")).toBe("/home/me/talks");
        expect(joinPath("/", "tmp")).toBe("/tmp");
        expect(joinPath("C:\\Users", "me")).toBe("C:\\Users\\me");
        expect(withSep("/home/me")).toBe("/home/me/");
        expect(samePath("/home/me/", "/home/me")).toBe(true);
        expect(samePath("/", "/")).toBe(true);
    });

    it("completes to what every match shares, ignoring case", () => {
        const dirs = ["Talks", "talk-2024", "Templates", "music"];
        expect(startingWith(dirs, "ta")).toEqual(["Talks", "talk-2024"]);
        expect(commonPrefix(startingWith(dirs, "ta"))).toBe("Talk");
        expect(commonPrefix(["music"])).toBe("music");
        expect(commonPrefix([])).toBe("");
    });
});

describe("asset references", () => {
    it("drop the version the server stamps", () => {
        expect(assetRef("diagrams/a.drawio.svg?v=17f3a2b")).toBe(
            "diagrams/a.drawio.svg",
        );
        expect(assetRef("assets/pic.png")).toBe("assets/pic.png");
    });
});

describe("PDF references", () => {
    it("tells a PDF and its page", () => {
        expect(isPdfRef("figures/plot.pdf")).toBe(true);
        expect(isPdfRef("figures/Plot.PDF#page=2")).toBe(true);
        expect(isPdfRef("plot.pdf.png")).toBe(false);
        expect(isPdfRef("https://example.com/plot.pdf")).toBe(false);
        expect(pdfPage("plot.pdf")).toBe(1);
        expect(pdfPage("plot.pdf#page=3")).toBe(3);
        expect(pdfPage("plot.pdf#zoom=50&page=2")).toBe(2);
    });

    it("writes the page as the fragment, none for the first", () => {
        expect(withPage("plot.pdf", 2)).toBe("plot.pdf#page=2");
        expect(withPage("plot.pdf#page=2", 1)).toBe("plot.pdf");
        expect(withPage("../a/plot.pdf#page=2", 4)).toBe(
            "../a/plot.pdf#page=4",
        );
    });
});
