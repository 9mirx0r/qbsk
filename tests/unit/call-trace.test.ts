// A runtime error says which calls led to it (docs/language.md §15.20).
//
// QBSK errors carry a span and a fragment and that is the language's best feature. What
// they never carried is the ROUTE: an error four calls deep reported the innermost line
// and nothing else, which is true and useless when the failing line is a general-purpose
// accessor called from thirty places.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";
import { formatQbskError } from "../../src/interp/error.js";

const NL = "\n";

/** The whole rendered error, the way the CLI prints it. */
function shown(...lines: string[]): string {
  const source = lines.join(NL);
  const r = runQbsk(source, "t.qbsk");
  expect(r.error, "the program was supposed to fail").not.toBeNull();
  return formatQbskError(source, r.error!);
}

describe("the route, innermost first", () => {
  it("names every function between the error and the top", () => {
    const out = shown(
      "func lookup(table, at)",
      "    return table[at]",
      "func capacity(table)",
      "    return lookup(table, 4 / 2)",
      "func step(table)",
      "    return capacity(table)",
      "print(str(step([1, 2, 3])))",
    );
    expect(out).toContain("in lookup");
    expect(out).toContain("from capacity");
    expect(out).toContain("from step");
    // Innermost first: `lookup` is where it broke, `step` is where it started.
    expect(out.indexOf("in lookup")).toBeLessThan(out.indexOf("from step"));
  });

  it("names the innermost frame even at depth one", () => {
    // "in `f`" is information when the span is inside a function the caller did not write.
    const out = shown("func f(xs)", "    return xs[1.5]", "print(str(f([1, 2])))");
    expect(out).toContain("in f");
  });

  it("says nothing extra for an error at the top level", () => {
    const out = shown("var xs = [1, 2]", "print(str(xs[1.5]))");
    expect(out).toContain("must be an int");
    expect(out).not.toContain("\n   in ");
    // Matched against the TRACE's own shape, not against the bare word. This asserted
    // `not.toContain("from ")` and broke the day an error message used the English word
    // "from" in a hint -- a test that fails on prose is testing the prose.
    expect(out).not.toContain(NL + "   from ");
  });

  it("keeps the span and the fragment it always had", () => {
    // The trace is an addition. If it ever replaced the fragment it would be a downgrade.
    const out = shown("func f(xs)", "    return xs[1.5]", "print(str(f([1])))");
    expect(out).toContain("t.qbsk:2:");
    expect(out).toContain("return xs[1.5]");
    expect(out).toContain("^");
  });

  it("carries the line each call was made from", () => {
    // Which of the thirty callers is the whole question, and only the line answers it.
    const out = shown(
      "func inner(xs)",
      "    return xs[1.5]",
      "func outer(xs)",
      "    return inner(xs)",
      "print(str(outer([1])))",
    );
    expect(out).toMatch(/from outer \(t\.qbsk:5\)/);
  });
});

describe("a native's own error gets the route too", () => {
  it("traces an error raised inside a native", () => {
    // Most errors come from natives — a bad argument, a missing key — and they are thrown
    // from the native rather than from the interpreter. A trace that covered only one of
    // the two would be the same feature with better odds.
    const out = shown(
      "func mid(v)",
      "    return sqrt(v)",
      "func top(v)",
      "    return mid(v)",
      "print(str(top(0.0 - 4.0)))",
    );
    expect(out).toContain("in mid");
    expect(out).toContain("from top");
  });

  it("traces `fail`, which is the author's own error", () => {
    const out = shown(
      "func check(n)",
      '    fail("no region " + str(n))',
      "func use_it()",
      "    return check(3)",
      "print(str(use_it()))",
    );
    expect(out).toContain("no region 3");
    expect(out).toContain("in check");
    expect(out).toContain("from use_it");
  });
});

describe("deep recursion is elided rather than dumped", () => {
  it("shows both ends and says how many were dropped", () => {
    // A thousand identical lines is not a trace, it is a wall, and the two ends are what
    // a reader uses.
    const out = shown(
      "func down(n)",
      "    if n <= 0",
      "        return [1][1.5]",
      "    return down(n - 1)",
      "print(str(down(40)))",
    );
    expect(out).toContain("in down");
    expect(out).toMatch(/\d+ more/);
    // Bounded: the whole error stays readable in a terminal.
    expect(out.split(NL).length).toBeLessThan(20);
  });
});
