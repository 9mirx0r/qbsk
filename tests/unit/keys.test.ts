// The canonical key vocabulary (docs/studio.md §14.5, docs/language.md §7.2).
import { describe, expect, it } from "vitest";
import {
  NAMED_KEYS,
  isCanonicalKey,
  keyFromDom,
  suggestKey,
} from "../../src/engine/keys.js";
import { analyzeProgram } from "../../src/analyze/analyzer.js";
import { parse } from "../../src/parser/parser.js";

const problems = (src: string): string[] => {
  const parsed = parse(src, "t.qbsk");
  return analyzeProgram(parsed.ast, "t.qbsk").map((p) => p.message);
};

describe("isCanonicalKey", () => {
  it("accepts every named key", () => {
    for (const name of NAMED_KEYS) {
      expect(isCanonicalKey(name)).toBe(true);
    }
  });

  // "rest → char" (docs/engine.md §8): a printable character is its own key name,
  // which is what lets a console receive ordinary typing without a table of 95 entries.
  it("accepts any single printable character", () => {
    for (const ch of ["a", "Z", "7", "?", "/", "-", "@"]) {
      expect(isCanonicalKey(ch)).toBe(true);
    }
  });

  it("rejects the DOM spelling, which is the one people will actually paste", () => {
    expect(isCanonicalKey("ArrowLeft")).toBe(false);
    expect(isCanonicalKey("Escape")).toBe(false);
  });

  // docs/engine.md §8 used to say `left`; everything else says `arrow-left`. The
  // rejected spelling is the one that would silently never fire.
  it("rejects the old unprefixed arrow names", () => {
    for (const name of ["left", "right", "up", "down"]) {
      expect(isCanonicalKey(name)).toBe(false);
    }
  });

  it("rejects nonsense and the empty name", () => {
    expect(isCanonicalKey("qwerty")).toBe(false);
    expect(isCanonicalKey("")).toBe(false);
    expect(isCanonicalKey("ctrl+a")).toBe(false);
  });

  it("is case sensitive, because Shift+A is a different press than a", () => {
    expect(isCanonicalKey("A")).toBe(true);
    expect(isCanonicalKey("SPACE")).toBe(false);
  });
});

describe("suggestKey turns a wrong name into the right one", () => {
  it("maps the DOM spelling to the canonical one", () => {
    expect(suggestKey("ArrowLeft")).toBe("arrow-left");
    expect(suggestKey("ArrowUp")).toBe("arrow-up");
    expect(suggestKey("Escape")).toBe("escape");
    expect(suggestKey("Enter")).toBe("enter");
  });

  it("maps the unprefixed arrows, the exact trap docs/engine.md §8 set", () => {
    expect(suggestKey("left")).toBe("arrow-left");
    expect(suggestKey("down")).toBe("arrow-down");
  });

  it("catches a near miss by edit distance", () => {
    expect(suggestKey("arrowleft")).toBe("arrow-left");
    expect(suggestKey("scape")).toBe("escape");
  });

  it("returns null when there is nothing useful to say", () => {
    expect(suggestKey("qwerty")).toBeNull();
  });
});

describe("keyFromDom", () => {
  it("maps the arrows to the canonical names", () => {
    expect(keyFromDom("ArrowLeft")).toBe("arrow-left");
    expect(keyFromDom("ArrowRight")).toBe("arrow-right");
    expect(keyFromDom("ArrowUp")).toBe("arrow-up");
    expect(keyFromDom("ArrowDown")).toBe("arrow-down");
  });

  it("maps the space bar, which DOM reports as a literal space", () => {
    expect(keyFromDom(" ")).toBe("space");
  });

  it("passes a printable character through unchanged, case included", () => {
    expect(keyFromDom("a")).toBe("a");
    expect(keyFromDom("A")).toBe("A");
    expect(keyFromDom("?")).toBe("?");
  });

  it("maps the editing keys a console needs", () => {
    expect(keyFromDom("Enter")).toBe("enter");
    expect(keyFromDom("Backspace")).toBe("backspace");
    expect(keyFromDom("Tab")).toBe("tab");
    expect(keyFromDom("Escape")).toBe("escape");
    expect(keyFromDom("Delete")).toBe("delete");
    expect(keyFromDom("Home")).toBe("home");
    expect(keyFromDom("PageUp")).toBe("page-up");
  });

  // A modifier is not a key press a program should see — holding Shift would
  // otherwise fire a handler once per keydown repeat.
  it("drops modifiers rather than delivering them", () => {
    for (const mod of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      expect(keyFromDom(mod)).toBeNull();
    }
  });

  // F5 and Escape belong to play mode (docs/studio.md §13); a scene must not be able
  // to steal the key that leaves full screen.
  it("drops the function keys, which the window owns", () => {
    expect(keyFromDom("F5")).toBeNull();
    expect(keyFromDom("F12")).toBeNull();
  });

  it("drops an unrecognised name instead of inventing one", () => {
    expect(keyFromDom("Unidentified")).toBeNull();
    expect(keyFromDom("")).toBeNull();
  });

  it("every name it produces is canonical — the two must not drift apart", () => {
    const domNames = [
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter",
      "Backspace", "Tab", "Escape", "Delete", "Home", "End", "PageUp",
      "PageDown", "a", "Z", "9", "!",
    ];
    for (const d of domNames) {
      const name = keyFromDom(d);
      expect(name).not.toBeNull();
      expect(isCanonicalKey(name!)).toBe(true);
    }
  });
});

describe("the analyzer rejects an unknown key name", () => {
  // Today this parses, analyzes and runs clean, and simply never fires — the
  // `sprinkle` failure shape, and what an earlier release exists to stop.
  it("reports a name that can never fire", () => {
    const found = problems('on key "qwerty"\n    var x = 1');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toContain("qwerty");
  });

  it("suggests the canonical spelling for the DOM one", () => {
    const found = problems('on key "ArrowLeft"\n    var x = 1');
    expect(found[0]).toContain("arrow-left");
  });

  it("suggests the canonical spelling for the unprefixed arrow", () => {
    const found = problems('on key "left"\n    var x = 1');
    expect(found[0]).toContain("arrow-left");
  });

  it("accepts every name a real scene uses", () => {
    const src = [
      'on key "arrow-left"',
      "    var a = 1",
      'on key "space"',
      "    var b = 1",
      'on key "q"',
      "    var c = 1",
      'on key "enter"',
      "    var d = 1",
    ].join("\n");
    expect(problems(src)).toEqual([]);
  });

  it("leaves examples/keys.qbsk clean", () => {
    const src = [
      'on key "arrow-left"',
      "    var playerX = 1",
      'on key "arrow-right"',
      "    var playerY = 1",
    ].join("\n");
    expect(problems(src)).toEqual([]);
  });
});
