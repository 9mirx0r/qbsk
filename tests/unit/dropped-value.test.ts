// A line that computes a value must do something with it (docs/language.md §15.26).
//
// Invariant I2 — every value a construct evaluates is used or reported — broken at the
// most ordinary place in the grammar. §14 and §15 spent nineteen sections removing
// constructs that parse, run and do nothing, while the statement form that does it most
// easily sat unexamined.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";
import { formatQbskError } from "../../src/interp/error.js";

const NL = "\n";

function out(...lines: string[]): string[] {
  const printed: string[] = [];
  const source = lines.join(NL);
  const r = runQbsk(source, "t.qbsk", { print: (s: string) => printed.push(s) });
  if (r.error !== null) {
    throw new Error(formatQbskError(source, r.error));
  }
  return printed;
}

function fails(...lines: string[]): string {
  const source = lines.join(NL);
  const r = runQbsk(source, "t.qbsk", { print: () => {} });
  expect(r.error, "the program was supposed to fail").not.toBeNull();
  return formatQbskError(source, r.error!);
}

describe("a value computed and dropped is reported", () => {
  it("reports arithmetic on a line of its own", () => {
    expect(fails("var a = 1", "1 + 1", "print(str(a))")).toContain(
      "computes a value and does nothing with it",
    );
  });

  it("reports an index", () => {
    expect(fails("var xs = [1, 2]", "xs[0]", "print(str(xs))")).toContain(
      "does nothing with it",
    );
  });

  it("reports a comparison", () => {
    expect(fails("var a = 1", "a == 1", "print(str(a))")).toContain("does nothing with it");
  });

  it("reports a negation, which is where §15.25 lands the lines it stopped swallowing", () => {
    // `var damage = hit` then `-armour` used to be a subtraction. §15.25 made it a
    // separate statement; this makes that statement say something.
    expect(fails("var armour = 3", "-armour", "print(str(armour))")).toContain(
      "does nothing with it",
    );
  });

  it("reports a literal", () => {
    expect(fails("var a = 1", "\"just sitting here\"", "print(str(a))")).toContain(
      "does nothing with it",
    );
  });

  it("puts the caret under the whole expression", () => {
    const e = fails("var a = 1", "1 + 1", "print(str(a))");
    const fragment = e.split(NL).find((l) => l.includes("^"))!;
    expect(fragment.replace(/[^^]/g, "")).toBe("^^^^^");
  });
});

describe("a name on its own gets the message it needs", () => {
  it("offers both readings, because the caret cannot tell them apart", () => {
    const e = fails("func greet()", "    return 1", "greet", "print(\"after\")");
    expect(e).toContain("'greet' on its own line does nothing");
    expect(e).toContain("greet()");
    expect(e).toContain("var x = greet");
  });

  it("says the same for a member reached with a dot", () => {
    const e = fails('use "x.qbsk" as m', "m.thing", "print(\"after\")");
    expect(e).toContain("on its own line does nothing");
  });
});

describe("a call is exempt, because a call can be the point", () => {
  it("allows a call whose value nobody wants", () => {
    expect(out("var xs = []", "push(xs, 1)", "print(str(xs))")).toEqual(["[1]"]);
  });

  it("allows a call without parentheses", () => {
    expect(
      out("func shout(w)", "    print(w + \"!\")", "    return 0", "shout \"ave\""),
    ).toEqual(["ave!"]);
  });

  it("allows a method-shaped call", () => {
    expect(out("var xs = [3, 1, 2]", "sort(xs)", "print(str(xs))")).toEqual(["[1, 2, 3]"]);
  });

  it("allows a call inside a block", () => {
    expect(out("if true", "    print(\"yes\")")).toEqual(["yes"]);
  });
});

describe("everything that was already a statement is untouched", () => {
  it("assignment", () => {
    expect(out("var a = 1", "a = 2", "print(str(a))")).toEqual(["2"]);
  });

  it("compound assignment", () => {
    expect(out("var a = 1", "a += 2", "print(str(a))")).toEqual(["3"]);
  });

  it("an index assignment", () => {
    expect(out("var xs = [1, 2]", "xs[0] = 9", "print(str(xs))")).toEqual(["[9, 2]"]);
  });

  it("a return with a value", () => {
    expect(out("func f()", "    return 1 + 1", "print(str(f()))")).toEqual(["2"]);
  });
});
