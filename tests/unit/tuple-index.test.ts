// Tuples are indexable (docs/language.md §5).
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const out = (src: string): string[] => {
  const r = runQbsk(src, "t.qbsk");
  expect(r.error).toBeNull();
  return r.out;
};

describe("a tuple can be read by index", () => {
  // Found by C5: path() returns coordinates, and there was no way to read one's x.
  // Returning lists instead would have worked, but indexing is strictly better —
  // route[1] passes straight to `at`, AND step[0] reads the component.
  it("[0] is x and [1] is y", () => {
    expect(out("var t = (3, 7)\nprint(t[0])\nprint(t[1])")).toEqual(["3", "7"]);
  });

  it("still passes whole to a coordinate slot", () => {
    const r = runQbsk(
      [
        "var t = (2, 1)",
        "scene S(width: 6, height: 3)",
        "layer a z: 1",
        '    fill "."',
        '    put "@" at t',
      ].join("\n"),
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.canvas!.renderText().split("\n")[1]![2]).toBe("@");
  });

  it("an index out of range reports rather than answering null", () => {
    const r = runQbsk("var t = (1, 2)\nprint(t[2])", "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("2");
  });

  it("a negative index reports", () => {
    const r = runQbsk("var t = (1, 2)\nprint(t[0 - 1])", "t.qbsk");
    expect(r.error).not.toBeNull();
  });

  it("a non-int index reports with the type it got", () => {
    const r = runQbsk('var t = (1, 2)\nprint(t["x"])', "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("str");
  });

  it("a tuple of expressions reads the evaluated components", () => {
    expect(out("var a = 4\nvar t = (a * 2, a + 1)\nprint(t[0])")).toEqual(["8"]);
  });

  it("path() coordinates are readable, which is why this exists", () => {
    const src = [
      'const m = ["....", "....", "...."]',
      'var r = path(m, (0, 0), (3, 2), "#")',
      "var step = r[1]",
      "print(step[0])",
      "print(step[1])",
    ].join("\n");
    expect(out(src)).toEqual(["1", "1"]);
  });
});

describe("a string can be read by index too", () => {
  // `len(s)` already worked on a string, so not being able to index one was an
  // asymmetry rather than a decision. Found the same way as tuple indexing: real code
  // reading a map of rows, `MAP[y][x]`, which is how anyone would write it.
  it("gives the character at a position", () => {
    expect(out('var s = "abc"\nprint(s[0])\nprint(s[2])')).toEqual(["a", "c"]);
  });

  it("reads a row of a map, which is what found this", () => {
    const src = [
      'const m = ["#..", ".#.", "..#"]',
      "print(m[1][1])",
      "print(m[0][1])",
    ].join("\n");
    expect(out(src)).toEqual(["#", "."]);
  });

  it("an index past the end reports rather than answering empty", () => {
    const r = runQbsk('var s = "ab"\nprint(s[5])', "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("5");
  });

  it("a negative index reports", () => {
    const r = runQbsk('var s = "ab"\nprint(s[0 - 1])', "t.qbsk");
    expect(r.error).not.toBeNull();
  });

  it("a non-int index reports with the type it got", () => {
    const r = runQbsk('var s = "ab"\nprint(s[true])', "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("bool");
  });

  it("counts characters, not code units — an emoji is one index", () => {
    // len() already counts this way; indexing must agree or the two disagree about
    // what position 1 is, which is worse than either answer alone.
    expect(out('var s = "a\u00f1o"\nprint(s[1])\nprint(len(s))')).toEqual(["ñ", "3"]);
  });

  it("an empty string has no index 0", () => {
    const r = runQbsk('var s = ""\nprint(s[0])', "t.qbsk");
    expect(r.error).not.toBeNull();
  });
});
