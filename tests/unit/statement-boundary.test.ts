// A new line ends the statement before it (docs/language.md §15.25).
//
// QBSK has no end-of-line token, so two statements at the same indentation arrive at the
// parser with nothing between them. Every construct taking an OPTIONAL trailing expression
// read on into the next line, and all three of them produced silently wrong programs.
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

describe("a bare return does not swallow the line below it", () => {
  it("returns null and leaves the next line alone", () => {
    // Was `return print("unreachable")`: the line printed, and the function returned its
    // null. Both halves wrong, and neither reported.
    expect(
      out(
        "func total()",
        "    var a = 5",
        "    return",
        "    print(\"unreachable\")",
        "print(str(total()))",
      ),
    ).toEqual(["null"]);
  });

  it("still takes a value written on its own line", () => {
    expect(out("func f()", "    return 7", "print(str(f()))")).toEqual(["7"]);
  });

  it("still continues when the line ends on an operator (§15.23)", () => {
    expect(
      out("func f()", "    return 1 +", "        2", "print(str(f()))"),
    ).toEqual(["3"]);
  });

  it("still continues inside a bracket (§15.14)", () => {
    expect(
      out("func f()", "    return [", "        1,", "        2,", "    ]", "print(str(f()))"),
    ).toEqual(["[1, 2]"]);
  });
});

describe("a call without parentheses does not swallow the line below it", () => {
  it("does not fuse two statements into one call", () => {
    // Was `greet(print("mine"))`: the print ran first and greet received its null.
    expect(
      out(
        "func greet(x)",
        "    print(\"greet got: \" + str(x))",
        "    return 0",
        "greet",
        "print(\"mine\")",
      ),
    ).toEqual(["mine"]);
  });

  it("still calls without parentheses on one line", () => {
    expect(
      out("func shout(word)", "    print(word + \"!\")", "    return 0", "shout \"ave\""),
    ).toEqual(["ave!"]);
  });
});

describe("an expression does not continue onto a line that starts one", () => {
  it("does not turn the next line into a subtraction", () => {
    expect(
      out("var hit = 10", "var armour = 3", "var damage = hit", "print(str(damage))"),
    ).toEqual(["10"]);
  });

  it("does not report about a variable declared on the line above", () => {
    // `var a = 1` then `-a` read as `var a = 1 - a` and reported
    // `variable 'a' is not defined — did you mean 'abs'?` about `a` itself.
    const printed = out("var a = 1", "-a", "print(str(a))");
    expect(printed).toEqual(["1"]);
  });

  it("still continues when the line above ends on an operator", () => {
    expect(out("var t = 1 +", "    2 +", "    3", "print(str(t))")).toEqual(["6"]);
  });

  it("still continues inside a bracket", () => {
    expect(out("var xs = [", "    1,", "    2,", "]", "print(str(xs))")).toEqual(["[1, 2]"]);
  });

  it("keeps a whole expression on one line intact", () => {
    expect(out("var t = 1 + 2 * 3 - 4", "print(str(t))")).toEqual(["3"]);
  });
});

describe("break and continue use the same mark now (§15.22)", () => {
  it("still does not read a label from the next line", () => {
    expect(
      out("var stop = 0", "for i in 0..3 as outer", "    break", "stop = 1", "print(str(stop))"),
    ).toEqual(["1"]);
  });

  it("still takes a label written beside it", () => {
    expect(
      out(
        "for i in 0..3 as outer",
        "    for j in 0..3",
        "        break outer",
        "print(\"done\")",
      ),
    ).toEqual(["done"]);
  });
});

describe("the boundary does not reach inside a block", () => {
  it("leaves an indented block exactly as it was", () => {
    expect(
      out(
        "func f(n)",
        "    if n > 0",
        "        return \"positive\"",
        "    return \"other\"",
        "print(f(1))",
        "print(f(-1))",
      ),
    ).toEqual(["positive", "other"]);
  });

  it("leaves an inline block after ':' alone", () => {
    expect(out("if true: print(\"inline\")", "print(\"after\")")).toEqual([
      "inline",
      "after",
    ]);
  });

  it("still reports an unfinished line at the end of the file", () => {
    expect(fails("var x = 1 +")).toContain("t.qbsk");
  });
});

describe("the error tells the author what to write instead", () => {
  it("names the fix, which is on the OTHER line", () => {
    // "unexpected expression: '+'" is true and leaves the author staring at a line that
    // looks perfectly reasonable. The fix is one character, on the line above.
    const e = fails("var a = 1", "var c = a", "+ b", "print(str(c))");
    expect(e).toContain("does not continue the line above");
    expect(e).toContain("put it at the END of that line");
  });

  it("says it for any binary operator, not just the one that was tried first", () => {
    for (const op of ["*", "/", "and", "=="]) {
      expect(fails("var a = 1", "var c = a", `${op} b`, "print(str(c))")).toContain(
        "does not continue the line above",
      );
    }
  });

  it("does not say it for something that is simply not an expression", () => {
    // The hint is about operators. Attached to everything it would be noise, and wrong.
    const e = fails("var a = )");
    expect(e).not.toContain("does not continue the line above");
  });
});
