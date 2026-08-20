// Inside brackets, a line break carries no meaning (docs/language.md §14.6).
//
// QBSK is indentation-sensitive, so a newline ends a statement — correctly, at the top
// level. Inside a bracket it should not, and until 2026-08-19 it did: `f(\n 1,\n 2)`
// worked because the comma-separated walker skipped the layout tokens BETWEEN items,
// while `f(1 +\n 2)` — one item spanning two lines — failed in every one of the four
// bracket contexts.
//
// So a program could lay out a LIST across lines and never a FORMULA, which is backwards
// for a language whose current consumer is a physiological simulation. Found writing
// the design document §9.1's discontent function, where six weighted terms do not fit on one line and
// putting them there is not an answer.
import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const NL = "\n";
const out = (...lines: string[]): string[] => {
  const r = runQbsk(lines.join(NL), "t.qbsk");
  expect(r.error?.message ?? null).toBeNull();
  return r.out;
};
const errors = (...lines: string[]): string[] =>
  parse(lines.join(NL), "t.qbsk").errors.map((e) => e.message);

describe("one expression spanning lines, in each of the four bracket contexts", () => {
  it("continues inside grouping parentheses", () => {
    expect(out("var x = (1 +", "    2 +", "    3)", "print(str(x))")).toEqual(["6"]);
  });

  it("continues inside a call argument", () => {
    expect(out("print(str(1 +", "    2))")).toEqual(["3"]);
  });

  it("continues inside a list element", () => {
    expect(out("var l = [1 +", "    2, 9]", 'print(str(l[0]) + "," + str(l[1]))')).toEqual(["3,9"]);
  });

  it("continues inside a dict value", () => {
    expect(out('var d = {"a": 1 +', "    2}", 'print(str(d["a"]))')).toEqual(["3"]);
  });

  it("continues through a nested call, which is where the depth has to be a count", () => {
    // One bracket suppressing layout is not enough: the inner call closes and the outer
    // one is still open, so a flag would re-enable line endings halfway through.
    expect(out("var x = (max(1,", "    2) +", "    max(3,", "    4))", "print(str(x))")).toEqual(["6"]);
  });

  it("lays out the formula that found this", () => {
    // the design document §9.1's discontent, in the shape it is actually written in.
    expect(
      out(
        "func discontent(a, b, c)",
        "    return (a * 2.0",
        "        + b * 1.5",
        "        + c * 0.5)",
        "print(str(int(discontent(1.0, 2.0, 4.0) * 10.0)))",
      ),
    ).toEqual(["70"]);
  });
});

describe("outside brackets a line break still ends the statement", () => {
  it("keeps two statements two statements", () => {
    // The property the change must not take with it. If a trailing operator or a bare
    // newline continued an expression, this would become `1 + 2` and print once.
    expect(out("print(str(1))", "print(str(2))")).toEqual(["1", "2"]);
  });

  it("still refuses a block that is indented under nothing", () => {
    expect(errors("var a = 1", "    var b = 2").length).toBeGreaterThan(0);
  });

  it("still reads an indented block as a block", () => {
    expect(out("var n = 0", "if true", "    n = 7", "print(str(n))")).toEqual(["7"]);
  });

  it("continues an UNINDENTED line that starts with an operator, as it always has", () => {
    // Recorded rather than changed, and it was a surprise: `var a = 1` followed by `+ 2`
    // at column zero binds to 3. QBSK has always continued an expression across a line
    // break when the next line is at the SAME indentation, because the lexer emits no
    // INDENT and nothing terminates a statement but a layout change.
    //
    // So the gap this file closes was never "expressions cannot span lines" — it was that
    // an INDENTED continuation could not, which is the one a person actually writes. This
    // assertion pins the older behaviour so a later change to the lexer cannot take it
    // away silently.
    expect(out("var a = 1", "+ 2", "print(str(a))")).toEqual(["3"]);
  });

  it("keeps a function body a body across a multi-line expression", () => {
    // The interesting interaction: the continuation must not swallow the DEDENT that
    // ends the function, or everything after it joins the body.
    expect(
      out(
        "func f(a)",
        "    return (a +",
        "        1)",
        "print(str(f(41)))",
        'print("after")',
      ),
    ).toEqual(["42", "after"]);
  });
});

describe("the continuation must not close the block it is written in", () => {
  // Found writing the design document §9.2's utility table, where a dozen `score = (...)` formulas sit
  // one level inside an `if` inside a function. The first fix for this file lived in the
  // PARSER: it skipped the layout tokens while a bracket was open. That skipped the
  // INDENT and left its DEDENT — so when the expression ended, one DEDENT too many
  // arrived and closed a real block. The tests above missed it because none of them had
  // a block left to close: at the top level, and in a one-deep function body, the extra
  // DEDENT lands where nothing is open and is harmless.
  //
  // The category is "layout inside brackets means nothing", and only the LEXER can honour
  // it: while a bracket is open it emits no INDENT and no DEDENT, so the indent stack
  // never learns about a level the parser is not tracking.
  it("keeps the sibling statement inside the same function", () => {
    expect(
      out(
        "func f(a)",
        "    if a > 0",
        "        var s = (1 +",
        "            2)",
        "    if a > 1",
        "        return 9",
        "    return 3",
        "print(str(f(1)))",
      ),
    ).toEqual(["3"]);
  });

  it("keeps the value visible to the rest of the block", () => {
    expect(
      out(
        "func f(a)",
        "    if a > 0",
        "        var s = (a +",
        "            10)",
        "        return s * 2",
        "    return 0",
        "print(str(f(1)))",
      ),
    ).toEqual(["22"]);
  });

  it("survives three levels of nesting", () => {
    expect(
      out(
        "func f(n)",
        "    var total = 0",
        "    var i = 0",
        "    while i < n",
        "        if i > 0",
        "            total = (total",
        "                + i * 2)",
        "        i += 1",
        "    return total",
        "print(str(f(4)))",
      ),
    ).toEqual(["12"]);
  });

  it("does the same for a dict spanning lines inside a nested block", () => {
    expect(
      out(
        "func f()",
        "    if true",
        '        var d = {"a": 1,',
        '            "b": 2}',
        '        return d["a"] + d["b"]',
        "    return 0",
        "print(str(f()))",
      ),
    ).toEqual(["3"]);
  });

  it("still reports a bracket that is never closed", () => {
    // The one thing suppressing layout could have broken: with no INDENT and no DEDENT
    // for the rest of the file, an unclosed `(` must still produce an error rather than
    // swallowing the program in silence.
    expect(errors("var x = (1 +", "print(str(x))").length).toBeGreaterThan(0);
  });
});
