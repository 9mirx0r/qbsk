// `contains` answers for lists too (docs/language.md §15.18).
//
// It was string-only, and nothing in the language could ask whether a LIST held a value:
// `find` and `without` are for entities and `has` is for dicts. So the four-line `holds`
// helper got written by hand — twice, in two modules of one codebase, three weeks apart.
// A rule a language makes you re-derive is a rule the language has not learned.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const NL = "\n";
const out = (...lines: string[]): string[] => {
  const r = runQbsk(lines.join(NL), "t.qbsk");
  expect(r.error?.message ?? null).toBeNull();
  return r.out;
};
const fails = (...lines: string[]): string =>
  runQbsk(lines.join(NL), "t.qbsk").error?.message ?? "";

describe("a list is a haystack now", () => {
  it("answers for the four primitive types", () => {
    expect(
      out(
        'print(str(contains([1, 2, 3], 2)) + " " + str(contains([1, 2, 3], 9)))',
        'print(str(contains([1.5, 2.5], 2.5)) + " " + str(contains([1.5], 9.0)))',
        'print(str(contains(["a", "b"], "b")) + " " + str(contains(["a"], "z")))',
        'print(str(contains([true, false], false)) + " " + str(contains([true], false)))',
      ),
    ).toEqual(["true false", "true false", "true false", "true false"]);
  });

  it("is empty-list safe", () => {
    expect(out("print(str(contains([], 1)))")).toEqual(["false"]);
  });

  it("compares the way `==` compares, not by identity", () => {
    // Two separately built strings are the same value, and the answer has to agree with
    // what the author would get from `==` written out by hand.
    expect(
      out('var xs = ["ab"]', 'var probe = "a" + "b"', "print(str(contains(xs, probe)))"),
    ).toEqual(["true"]);
  });

  it("does the job the hand-written helper did", () => {
    // The function this replaces, and the same question asked both ways.
    expect(
      out(
        "func holds(list, value)",
        "    for item in list",
        "        if item == value",
        "            return true",
        "    return false",
        'var st = ["pivot", "grip", "move"]',
        'print(str(holds(st, "grip") == contains(st, "grip")))',
        'print(str(holds(st, "fly") == contains(st, "fly")))',
      ),
    ).toEqual(["true", "true"]);
  });

  it("reports on a list of things it cannot compare, rather than guessing", () => {
    // "The same dict" is not a question this can answer for the author, so it says so
    // instead of returning false and letting a wrong answer through.
    expect(fails('print(str(contains([{"a": 1}], {"a": 1})))')).toContain("contains");
  });
});

describe("strings behave exactly as they did", () => {
  it("still tests for a substring", () => {
    expect(
      out(
        'print(str(contains("hello world", "o w")) + " " + str(contains("hello", "z")))',
      ),
    ).toEqual(["true false"]);
  });

  it("still reports when the needle is not a string", () => {
    expect(fails('print(str(contains("abc", 1)))')).toContain("contains");
  });

  it("still reports on a haystack that is neither", () => {
    expect(fails("print(str(contains(7, 1)))")).toContain("contains");
  });
});
