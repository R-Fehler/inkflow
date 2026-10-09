import { describe, expect, it } from "vitest";
import {
    commonPrefix,
    joinPath,
    samePath,
    splitTyped,
    startingWith,
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
