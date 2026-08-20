// `slice` on strings and `format` (docs/language.md §15.19).
//
// Two ergonomics found by writing a lot of QBSK rather than by reading the spec. `slice`
// was list-only while `[]` already indexed strings — an asymmetry with no reason behind it
// — and there was no way to write a fixed number of decimals at all, so every line that
// wanted three of them wrote `str(int(x * 1000.0))` and then could not put the point back.
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

describe("slice cuts strings", () => {
  it("takes a start and an end", () => {
    expect(out('print(slice("gladius", 0, 4))', 'print(slice("gladius", 4, 7))'))
      .toEqual(["glad", "ius"]);
  });

  it("runs to the end when the end is left out, as it does for a list", () => {
    expect(out('print(slice("gladius", 4))')).toEqual(["ius"]);
  });

  it("clamps rather than reporting, the way the list form does", () => {
    // A substring that runs off the end is a normal thing to ask for; an error there
    // would be pedantry, and the list form has never done it.
    expect(
      out(
        'print(slice("abc", 0, 99))',
        'print(slice("abc", 0 - 5, 2))',
        'print("[" + slice("abc", 2, 1) + "]")',
        'print("[" + slice("", 0, 3) + "]")',
      ),
    ).toEqual(["abc", "ab", "[]", "[]"]);
  });

  it("agrees with indexing, which is the asymmetry it closes", () => {
    // `s[3]` answered and `slice(s, 3, 4)` reported. They must now say the same thing.
    expect(out('var s = "gladius"', 'print(s[3] + "|" + slice(s, 3, 4))')).toEqual(["d|d"]);
  });

  it("still cuts lists exactly as before", () => {
    expect(
      out(
        'var xs = ["a", "b", "c", "d"]',
        'print(join(slice(xs, 1, 3), ",") + " " + join(slice(xs, 2), ","))',
      ),
    ).toEqual(["b,c c,d"]);
  });

  it("still reports on something that is neither", () => {
    expect(fails("print(str(slice(7, 0, 1)))")).toContain("slice");
  });
});

describe("format writes the number you meant", () => {
  it("writes a fixed number of decimals", () => {
    expect(out("print(format(3.14159, 2))", "print(format(2.0, 3))")).toEqual(["3.14", "2.000"]);
  });

  it("ROUNDS, which is the bug the old workaround had", () => {
    // `str(int(x * 1000.0))` truncates: 0.0006 printed as 0 and 2.9999 as 2999.
    expect(out("print(format(0.0006, 3))", "print(format(2.9999, 3))", "print(format(0.5, 0))"))
      .toEqual(["0.001", "3.000", "1"]);
  });

  it("takes an int, because an int is a number too", () => {
    expect(out("print(format(7, 2))", "print(format(0, 1))")).toEqual(["7.00", "0.0"]);
  });

  it("writes no point at all for zero places", () => {
    expect(out("print(format(3.7, 0))")).toEqual(["4"]);
  });

  it("keeps the sign", () => {
    expect(out("print(format(0.0 - 1.256, 2))")).toEqual(["-1.26"]);
  });

  it("reports a negative or absurd number of places rather than guessing", () => {
    expect(fails("print(format(1.0, 0 - 1))")).toContain("format");
    expect(fails("print(format(1.0, 99))")).toContain("format");
  });

  it("reports on something that is not a number", () => {
    expect(fails('print(format("1.5", 2))')).toContain("format");
  });
});
