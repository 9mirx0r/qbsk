// A float index says what to write instead (docs/language.md §15.17).
//
// `/` returns a float whatever its operands and §17.1 freezes that. In a language whose
// commonest values are grid coordinates that is a trap, and the trap is not the semantics
// — it is the DISTANCE. `span / 2` produces the float on one line and the error arrives on
// another, often in a different function, saying only "got 'float'".
//
// Four sites can raise it: a list read, a list write, a string and a tuple. A message
// written for one of them and not the others is the same defect with better odds, so all
// four are asserted here.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const NL = "\n";
const fails = (...lines: string[]): string =>
  runQbsk(lines.join(NL), "t.qbsk").error?.message ?? "";

describe("an index that is a float teaches the fix", () => {
  it("names int(a / b) when a list is READ with one", () => {
    const m = fails("var xs = [1, 2, 3]", "var n = 4", "print(str(xs[n / 2]))");
    expect(m).toContain("float");
    expect(m).toContain("int(a / b)");
  });

  it("names it when a list is WRITTEN through one", () => {
    // The site that actually bit: `rows[y][x] = ch` where x came from arithmetic.
    const m = fails("var xs = [1, 2, 3]", "var n = 4", "xs[n / 2] = 9");
    expect(m).toContain("int(a / b)");
  });

  it("names it for a string", () => {
    const m = fails('var s = "abcd"', "var n = 4", "print(s[n / 2])");
    expect(m).toContain("int(a / b)");
  });

  it("names it for a tuple", () => {
    const m = fails("var t = (7, 8)", "var n = 2", "print(str(t[n / 2]))");
    expect(m).toContain("int(a / b)");
  });

  it("says WHY, not only what — that `/` is float division whatever its operands", () => {
    // The half that turns a puzzle into a signpost. Without it an author reads "got
    // 'float'" and looks for a float, when what they wrote was two integers.
    expect(fails("var xs = [1]", "print(str(xs[2 / 2]))")).toContain("float division");
  });

  it("does NOT lecture when the index is a string or a bool", () => {
    // The advice is about arithmetic. Attaching it to every wrong-typed index would make
    // it noise, and noise is how good diagnostics stop being read.
    const m = fails("var xs = [1, 2]", 'print(str(xs["one"]))');
    expect(m).toContain("must be an int");
    expect(m).not.toContain("int(a / b)");
  });

  it("still accepts an int index, including one that came from int()", () => {
    const r = runQbsk(
      ["var xs = [10, 20, 30]", "var n = 4", "print(str(xs[int(n / 2)]))"].join(NL),
      "t.qbsk",
    );
    expect(r.error?.message ?? null).toBeNull();
    expect(r.out).toEqual(["30"]);
  });
});
