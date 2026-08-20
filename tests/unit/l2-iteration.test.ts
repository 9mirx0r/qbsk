// L2 — iteration ergonomics (docs/language.md §6.2, §6.3): indexed for + lambdas.
//
// The measure of this phase is subtraction: every `while i < len(xs)` whose only job
// was carrying an index, and every named one-line helper fed to map/filter/reduce,
// stops being necessary. The tests run the FEATURES; the rewrite of turns.qbsk is the
// acceptance criterion and lives with the goldens.

import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { analyzeProgram } from "../../src/analyze/analyzer.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const run = (source: string) => runQbsk(source, "l2.qbsk");

// ---------------------------------------------------------------------------
// §6.2 — for i, item in list
// ---------------------------------------------------------------------------

describe("for i, item in list (docs/language.md §6.2)", () => {
  it("binds index and element", () => {
    const result = run(
      [
        `for i, ch in ["a", "b", "c"]`,
        `    print("{i}:{ch}")`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("the index is an int, usable in coordinates", () => {
    const result = run(
      [
        `var total = 0`,
        `for i, n in [10, 20, 30]`,
        `    total = total + i * n`,
        `print(str(total))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    // 0*10 + 1*20 + 2*30 = 80
    expect(result.out).toEqual(["80"]);
  });

  it("nested loops keep their own indexes", () => {
    const result = run(
      [
        `for y, row in [["a", "b"], ["c"]]`,
        `    for x, ch in row`,
        `        print("{x},{y} {ch}")`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["0,0 a", "1,0 b", "0,1 c"]);
  });

  it("continue and break behave like the single-name form", () => {
    const result = run(
      [
        `for i, n in [1, 2, 3, 4]`,
        `    if n == 2`,
        `        continue`,
        `    if n == 4`,
        `        break`,
        `    print("{i}")`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["0", "2"]);
  });

  it("on a range it is a parse error — a range's element IS its index", () => {
    const parsed = parse(`for i, x in 0..10\n    print("no")`, "l2.qbsk");
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]!.message).toMatch(/range/);
  });

  it("the analyzer sees both names as declared", () => {
    const parsed = parse(
      [
        `for i, ch in ["a"]`,
        `    print("{i}{ch}")`,
      ].join("\n"),
      "l2.qbsk",
    );
    expect(parsed.errors).toEqual([]);
    expect(analyzeProgram(parsed.ast, "l2.qbsk", ".")).toEqual([]);
  });

  it("single-name iteration is untouched", () => {
    const result = run(
      [
        `for n in [1, 2]`,
        `    print(str(n))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["1", "2"]);
  });
});

// ---------------------------------------------------------------------------
// §6.3 — lambdas
// ---------------------------------------------------------------------------

describe("lambdas: func(params) expr (docs/language.md §6.3)", () => {
  it("works as a map argument — the motivating case", () => {
    const result = run(`print(str(map([1, 2, 3], func(n) n * 2)))`);
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["[2, 4, 6]"]);
  });

  it("works with filter and reduce", () => {
    const result = run(
      [
        `print(str(filter([1, 2, 3, 4], func(n) n % 2 == 0)))`,
        `print(str(reduce([1, 2, 3], func(acc, n) acc + n, 0)))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["[2, 4]", "6"]);
  });

  it("is a value: storable, callable, returnable", () => {
    const result = run(
      [
        `var inc = func(n) n + 1`,
        `print(str(inc(41)))`,
        `func make_adder(k)`,
        `    return func(n) n + k`,
        `var add5 = make_adder(5)`,
        `print(str(add5(10)))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["42", "15"]);
  });

  it("closes over its environment", () => {
    const result = run(
      [
        `var base = 100`,
        `print(str(map([1, 2], func(n) n + base)))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["[101, 102]"]);
  });

  it("zero params and multiple params parse", () => {
    const result = run(
      [
        `var f = func() 7`,
        `var g = func(a, b) a * b`,
        `print(str(f()))`,
        `print(str(g(3, 4)))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["7", "12"]);
  });

  it("arity errors report like a named function's", () => {
    const result = run(
      [
        `var f = func(a, b) a + b`,
        `f(1)`,
      ].join("\n"),
    );
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/expects 2 arguments, got 1/);
  });

  it("a block body is a parse error that points at named func", () => {
    const parsed = parse(
      [
        `var f = func(n):`,
        `    return n`,
      ].join("\n"),
      "l2.qbsk",
    );
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]!.message).toMatch(/named/);
  });

  it("ends where a call argument would: the paren closes the call", () => {
    const result = run(`print(str(len(map([1], func(n) n))))`);
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["1"]);
  });

  it("a named func statement is untouched", () => {
    const result = run(
      [
        `func double(n)`,
        `    return n * 2`,
        `print(str(double(21)))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["42"]);
  });

  it("the analyzer resolves lambda params and reports unknown names in the body", () => {
    const good = parse(`print(str(map([1], func(n) n + 1)))`, "l2.qbsk");
    expect(analyzeProgram(good.ast, "l2.qbsk", ".")).toEqual([]);

    const bad = parse(`print(str(map([1], func(n) n + nope)))`, "l2.qbsk");
    const problems = analyzeProgram(bad.ast, "l2.qbsk", ".");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]!.message).toMatch(/nope/);
  });
});

// ---------------------------------------------------------------------------
// Analyzer regression: a layer drawing from a `for` body keeps its directives live
// ---------------------------------------------------------------------------

describe("a 'color:' above a for loop that draws is NOT dead (an earlier release scan)", () => {
  it("for bodies count as drawing, like while bodies", () => {
    const source = [
      `scene S(width: 10, height: 5)`,
      `layer l z: 1`,
      `    color fg: red`,
      `    for i, ch in ["a", "b"]`,
      `        put ch at (i, 0)`,
    ].join("\n");
    const parsed = parse(source, "l2.qbsk");
    expect(parsed.errors).toEqual([]);
    expect(analyzeProgram(parsed.ast, "l2.qbsk", ".")).toEqual([]);
  });
});
