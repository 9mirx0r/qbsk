// Parenthesised grouping (docs/language.md §3).
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const out = (src: string): string[] => {
  const r = runQbsk(src, "t.qbsk");
  expect(r.error).toBeNull();
  return r.out;
};

describe("parentheses group an expression", () => {
  // Until now `(` ALWAYS started a tuple, so `(a + b) * 4` was a syntax error. Nothing
  // caught it because no example had ever needed to group arithmetic — and the first
  // real game logic written in QBSK hit it immediately.
  it("overrides precedence, which is the whole point", () => {
    expect(out("print((2 + 3) * 4)")).toEqual(["20"]);
    expect(out("print(2 + 3 * 4)")).toEqual(["14"]);
  });

  it("nests", () => {
    expect(out("print(((1 + 2) * (3 + 4)))")).toEqual(["21"]);
  });

  it("groups around a modulo, the shape entity code is full of", () => {
    expect(out("var x = 39\nprint((x + 1) % 40)")).toEqual(["0"]);
  });

  it("groups a comparison used as a value", () => {
    expect(out("print((1 < 2) == true)")).toEqual(["true"]);
  });

  it("groups a call and indexes the result", () => {
    expect(out('var l = [1, 2, 3]\nprint((slice(l, 1, 3))[0])')).toEqual(["2"]);
  });
});

describe("tuples still work exactly as before", () => {
  it("a two-element tuple is still a tuple", () => {
    const r = runQbsk(
      [
        "scene S(width: 6, height: 3)",
        "layer a z: 1",
        '    fill "."',
        '    put "@" at (2, 1)',
      ].join("\n"),
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.canvas!.renderText().split("\n")[1]![2]).toBe("@");
  });

  it("a tuple built from grouped arithmetic lands where it should", () => {
    const r = runQbsk(
      [
        "var x = 1",
        "scene S(width: 8, height: 3)",
        "layer a z: 1",
        '    fill "."',
        '    put "@" at ((x + 1) * 2, 1)',
      ].join("\n"),
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.canvas!.renderText().split("\n")[1]![4]).toBe("@");
  });

  // The error that used to fire for `(a)` must still fire for a genuinely broken
  // tuple, or the fix would have removed a diagnostic instead of a limitation.
  it("three expressions in parentheses is still an error", () => {
    const r = runQbsk("var t = (1, 2, 3)", "t.qbsk");
    expect(r.error).not.toBeNull();
  });

  it("an unclosed parenthesis is still an error", () => {
    const r = runQbsk("print((1 + 2", "t.qbsk");
    expect(r.error).not.toBeNull();
  });

  it("an empty pair of parentheses is still an error", () => {
    const r = runQbsk("var t = ()", "t.qbsk");
    expect(r.error).not.toBeNull();
  });
});
