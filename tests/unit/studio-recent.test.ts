// The files you actually work on (docs/studio.md §20).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addRecent,
  RECENT_LIMIT,
  recentLabel,
  samePath,
} from "../../studio/shared/recent.js";

describe("the list keeps what was opened last", () => {
  it("puts a new file at the front", () => {
    expect(addRecent(["a.qbsk"], "b.qbsk")).toEqual(["b.qbsk", "a.qbsk"]);
  });

  it("moves a file already in the list to the front instead of repeating it", () => {
    expect(addRecent(["a.qbsk", "b.qbsk", "c.qbsk"], "c.qbsk")).toEqual([
      "c.qbsk",
      "a.qbsk",
      "b.qbsk",
    ]);
  });

  it("caps the list", () => {
    let list: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      list = addRecent(list, `f${i}.qbsk`);
    }
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]).toBe("f24.qbsk");
  });

  it("takes a limit of its own", () => {
    expect(addRecent(["a", "b", "c"], "d", 2)).toEqual(["d", "a"]);
  });

  it("does not add a scene with no path", () => {
    // The default scene before it is ever saved. An empty row in the menu opens nothing.
    expect(addRecent(["a.qbsk"], "")).toEqual(["a.qbsk"]);
    expect(addRecent(["a.qbsk"], "   ")).toEqual(["a.qbsk"]);
  });

  it("returns a new array rather than mutating the one it was given", () => {
    const original = ["a.qbsk"];
    const next = addRecent(original, "b.qbsk");
    expect(original).toEqual(["a.qbsk"]);
    expect(next).not.toBe(original);
  });
});

describe("one file is one entry, however it was spelled", () => {
  it("treats separators as the same", () => {
    expect(samePath("C:\\x\\a.qbsk", "C:/x/a.qbsk")).toBe(true);
  });

  it("treats case as the same, because this list is written on Windows", () => {
    expect(samePath("C:/X/A.qbsk", "c:/x/a.qbsk")).toBe(true);
  });

  it("still tells two different files apart", () => {
    expect(samePath("C:/x/a.qbsk", "C:/x/b.qbsk")).toBe(false);
  });

  it("does not let one file appear twice under two spellings", () => {
    const list = addRecent(["C:\\x\\a.qbsk"], "C:/x/A.qbsk");
    expect(list).toEqual(["C:/x/A.qbsk"]);
  });
});

describe("the label says which file it is", () => {
  it("uses the file name", () => {
    expect(recentLabel("C:/games/arena/duel.qbsk")).toBe("arena/duel.qbsk");
  });

  it("keeps the parent folder, because two files can share a name", () => {
    expect(recentLabel("C:/a/duel.qbsk")).not.toBe(recentLabel("C:/b/duel.qbsk"));
  });

  it("survives a bare file name with no folder at all", () => {
    expect(recentLabel("duel.qbsk")).toBe("duel.qbsk");
  });

  it("handles Windows separators", () => {
    expect(recentLabel("C:\\a\\b\\duel.qbsk")).toBe("b/duel.qbsk");
  });
});

describe("the folder button is no longer wired to nothing", () => {
  const studioDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../studio");

  it("has a listener", () => {
    const source = readFileSync(join(studioDir, "renderer/renderer.ts"), "utf8");
    expect(source).toContain('el("btnFolder")');
  });

  it("the menu's rows are built with textContent", () => {
    // A file path is not markup, and a folder named `<b>` must not become one.
    const source = readFileSync(join(studioDir, "renderer/renderer.ts"), "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toContain("innerHTML");
  });
});
