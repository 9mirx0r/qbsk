// A line that ends with an operator is not finished (docs/language.md §15.23).
//
// §15.14 freed line breaks inside brackets. Everything else still had to fit on one line,
// so a long condition was written with parentheses added for no reason except to buy the
// break. The dangerous half of this feature is the indent stack: a continuation that
// suppresses INDENT but lets the DEDENT through closes the enclosing block, which is the
// bug §15.14 was fixed twice for.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";
import { readFileSync } from "node:fs";
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

describe("an arithmetic line continues", () => {
  it("continues after a binary operator", () => {
    expect(out("var total = 1 +", "    2 +", "    3", "print(str(total))")).toEqual(["6"]);
  });

  it("continues after a division, and the result is still a float (§17.1)", () => {
    expect(out("var half = 7 /", "    2", "print(str(half))")).toEqual(["3.5"]);
  });

  it("continues after an assignment operator", () => {
    expect(out("var x =", "    41 + 1", "print(str(x))")).toEqual(["42"]);
  });

  it("continues after a compound assignment", () => {
    expect(out("var x = 1", "x +=", "    9", "print(str(x))")).toEqual(["10"]);
  });

  it("does not care how far the continuation is indented", () => {
    expect(
      out("var total = 1 +", "                    2 +", "  3", "print(str(total))"),
    ).toEqual(["6"]);
  });
});

describe("a condition continues", () => {
  it("continues after 'and' without parentheses", () => {
    expect(
      out(
        "var a = 1",
        "var b = 2",
        "if a == 1 and",
        "        b == 2",
        "    print(\"both\")",
      ),
    ).toEqual(["both"]);
  });

  it("continues after 'or'", () => {
    expect(
      out("if false or", "        true", "    print(\"yes\")"),
    ).toEqual(["yes"]);
  });

  it("continues after a comparison operator", () => {
    expect(out("if 1 <", "        2", "    print(\"less\")")).toEqual(["less"]);
  });
});

describe("the indent stack survives it", () => {
  // The failure mode §15.14 was fixed twice for: the continuation swallows the INDENT and
  // the matching DEDENT closes the block the expression was written in.
  it("keeps the enclosing block open", () => {
    expect(
      out(
        "func f()",
        "    var total = 1 +",
        "        2",
        "    return total + 10",
        "print(str(f()))",
      ),
    ).toEqual(["13"]);
  });

  it("keeps a loop body open across a continuation", () => {
    expect(
      out(
        "var sum = 0",
        "for i in 0..3",
        "    sum = sum +",
        "        i",
        "    sum += 10",
        "print(str(sum))",
      ),
    ).toEqual(["33"]);
  });

  it("closes the block correctly after a continuation ends it", () => {
    expect(
      out(
        "if true",
        "    var x = 1 +",
        "        1",
        "    print(str(x))",
        "print(\"after\")",
      ),
    ).toEqual(["2", "after"]);
  });

  it("survives a continuation two blocks deep", () => {
    expect(
      out(
        "for i in 0..2",
        "    if i == 1",
        "        var v = 5 *",
        "            2",
        "        print(str(v))",
        "    print(\"tick\")",
      ),
    ).toEqual(["tick", "10", "tick"]);
  });
});

describe("a blank line or a comment does not end the continuation", () => {
  it("continues across a blank line", () => {
    expect(out("var total = 1 +", "", "    2", "print(str(total))")).toEqual(["3"]);
  });

  it("continues across a comment line", () => {
    expect(
      out("var total = 1 +", "    // the second half", "    2", "print(str(total))"),
    ).toEqual(["3"]);
  });
});

describe("what does NOT continue", () => {
  it("a line ending in ':' still opens a block", () => {
    expect(out("if true: print(\"inline\")")).toEqual(["inline"]);
  });

  it("a line STARTING with an operator does not continue the one above it", () => {
    // This test pinned the OPPOSITE when §15.23 shipped. QBSK had no end-of-line
    // token, so at equal indentation the expression parser walked straight across the
    // break and `var c = a` then `+ b` was `a + b`. That was an accident nobody designed
    // and §15.25 closed it: an operator that opens a line belongs to that line.
    //
    // And it REPORTS rather than quietly doing nothing, which is the whole difference
    // between a language that guesses and one that asks.
    expect(fails("var a = 1", "var c = a", "+ b", "print(str(c))")).toContain(
      "unexpected expression",
    );
  });

  it("and it does NOT reach an indented line, which is what §15.23 changes", () => {
    // Before: `unexpected expression: 'indentation'`. The two rules meet here.
    expect(out("var a = 1", "var c = a +", "    1", "print(str(c))")).toEqual(["2"]);
  });

  it("still reports an operator with nothing after it at all", () => {
    expect(fails("var x = 1 +")).toContain("t.qbsk");
  });
});

describe("brackets still work the way §15.14 left them", () => {
  it("a call still breaks across lines", () => {
    expect(
      out("func add(a, b)", "    return a + b", "print(str(add(", "    1,", "    2,", ")))"),
    ).toEqual(["3"]);
  });

  it("a bracket and an operator continuation nest", () => {
    expect(
      out("var xs = [", "    1 +", "        1,", "    3,", "]", "print(str(xs))"),
    ).toEqual(["[2, 3]"]);
  });
});

describe("the example runs and shows the feature (RULE #5)", () => {
  it("examples/long_lines.qbsk prints what it claims", () => {
    const source = readFileSync(
      new URL("../../examples/long_lines.qbsk", import.meta.url),
      "utf8",
    );
    const printed: string[] = [];
    const r = runQbsk(source, "long_lines.qbsk", { print: (s: string) => printed.push(s) });
    expect(r.error === null ? "" : formatQbskError(source, r.error)).toBe("");
    expect(printed).toEqual([
      "pressure 30.86",
      "the crowd has turned",
      // 0+0+1, +2+1, +4+1, +6+1, +8+1 — the loop body stayed open across the break.
      "total 25",
      "span 32",
    ]);
  });
});
