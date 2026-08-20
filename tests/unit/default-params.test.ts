// A parameter can carry a default (docs/language.md §15.21).
//
// The interesting half is not that `func f(a, b = 1)` parses. It is WHEN the default is
// evaluated: once at declaration, and every call shares one value, which is how a list
// default turns into a bug the language taught. These cases pin call-time evaluation.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";
import { readFileSync } from "node:fs";
import { formatQbskError } from "../../src/interp/error.js";

const NL = "\n";

/** Runs a program and returns everything it printed. */
function out(...lines: string[]): string[] {
  const printed: string[] = [];
  const source = lines.join(NL);
  const r = runQbsk(source, "t.qbsk", { print: (s: string) => printed.push(s) });
  if (r.error !== null) {
    throw new Error(formatQbskError(source, r.error));
  }
  return printed;
}

/** Runs a program expected to fail, and returns the rendered error. */
function fails(...lines: string[]): string {
  const source = lines.join(NL);
  const r = runQbsk(source, "t.qbsk", { print: () => {} });
  expect(r.error, "the program was supposed to fail").not.toBeNull();
  return formatQbskError(source, r.error!);
}

describe("a default fills an argument that was not given", () => {
  it("uses the default when the argument is missing", () => {
    expect(
      out("func greet(name, mark = \"!\")", "    return name + mark", "print(greet(\"ave\"))"),
    ).toEqual(["ave!"]);
  });

  it("uses the argument when it is given", () => {
    expect(
      out("func greet(name, mark = \"!\")", "    return name + mark", "print(greet(\"ave\", \"?\"))"),
    ).toEqual(["ave?"]);
  });

  it("fills several defaults at once", () => {
    expect(
      out(
        "func box(w = 2, h = 3, fill = \"#\")",
        "    return str(w) + \"x\" + str(h) + fill",
        "print(box())",
        "print(box(9))",
        "print(box(9, 8))",
      ),
    ).toEqual(["2x3#", "9x3#", "9x8#"]);
  });

  it("accepts a default that is not a literal", () => {
    expect(
      out(
        "var base = 10",
        "func at(offset = base * 2)",
        "    return offset",
        "print(str(at()))",
      ),
    ).toEqual(["20"]);
  });
});

describe("the default is evaluated at call time", () => {
  it("does not share one list across calls", () => {
    // The whole point. Evaluated once at declaration, the second call prints two items.
    expect(
      out(
        "func collect(item, into = [])",
        "    push(into, item)",
        "    return len(into)",
        "print(str(collect(\"a\")))",
        "print(str(collect(\"b\")))",
      ),
    ).toEqual(["1", "1"]);
  });

  it("sees the value the enclosing scope has NOW, not at declaration", () => {
    expect(
      out(
        "var limit = 1",
        "func cap(n = limit)",
        "    return n",
        "limit = 7",
        "print(str(cap()))",
      ),
    ).toEqual(["7"]);
  });

  it("may name a parameter already bound", () => {
    expect(
      out(
        "func window(text, from = 0, count = len(text) - from)",
        "    return slice(text, from, from + count)",
        "print(window(\"gladius\"))",
        "print(window(\"gladius\", 4))",
      ),
    ).toEqual(["gladius", "ius"]);
  });

  it("reports a default that names a parameter to its right", () => {
    const e = fails("func f(a = b, b = 1)", "    return a", "print(str(f()))");
    expect(e).toContain("'b' is not defined");
  });

  it("does not evaluate a default when the argument was given", () => {
    // `fail` in the default would end the program if it ran.
    expect(
      out(
        "func f(a, b = fail(\"evaluated\"))",
        "    return a + b",
        "print(f(\"o\", \"k\"))",
      ),
    ).toEqual(["ok"]);
  });
});

describe("the declaration is checked", () => {
  it("refuses a required parameter after an optional one", () => {
    const e = fails("func f(a = 1, b)", "    return a", "print(str(f(1, 2)))");
    expect(e).toContain("'b' is required but follows 'a'");
  });

  it("still refuses a duplicate parameter", () => {
    expect(fails("func f(a, a = 1)", "    return a", "print(str(f(1)))")).toContain("a");
  });
});

describe("arity reports the range", () => {
  it("names both ends when there are defaults", () => {
    const e = fails(
      "func window(text, from = 0, count = 1)",
      "    return text",
      "print(window(\"a\", 1, 2, 3))",
    );
    expect(e).toContain("expects 1 to 3 arguments, got 4");
  });

  it("keeps the single-number message when there are none", () => {
    const e = fails("func f(a, b)", "    return a", "print(str(f(1)))");
    expect(e).toContain("expects 2 arguments, got 1");
  });

  it("reports too few arguments against the required count", () => {
    const e = fails("func f(a, b, c = 1)", "    return a", "print(str(f(1)))");
    expect(e).toContain("expects 2 to 3 arguments, got 1");
  });
});

describe("a lambda takes defaults on the same terms", () => {
  it("fills a missing argument", () => {
    expect(
      out("var add = func(a, b = 10) a + b", "print(str(add(5)))", "print(str(add(5, 1)))"),
    ).toEqual(["15", "6"]);
  });

  it("refuses a required parameter after an optional one", () => {
    expect(fails("var f = func(a = 1, b) a", "print(str(f(1, 2)))")).toContain(
      "'b' is required but follows 'a'",
    );
  });
});

describe("the example runs and shows the feature (RULE #5)", () => {
  it("examples/defaults.qbsk prints what it claims", () => {
    // An example nobody runs is anti-pattern 1 waiting to happen: it parses, it is read
    // as documentation, and nothing checks that it still does what the prose says.
    const source = readFileSync(
      new URL("../../examples/defaults.qbsk", import.meta.url),
      "utf8",
    );
    const printed: string[] = [];
    const r = runQbsk(source, "defaults.qbsk", { print: (s: string) => printed.push(s) });
    expect(r.error === null ? "" : formatQbskError(source, r.error)).toBe("");
    expect(printed).toEqual([
      "stamina  ################....",
      "wounds   ******..............",
      "crowd    ======    |",
      // The second call does NOT print [gladius, scutum]: the default list is fresh.
      "first  [gladius]",
      "second [scutum]",
      "whole  gladiator",
      "tail   ator",
      "middle diat",
      "twice  ave ave ",
      "once   ave ",
    ]);
  });
});
