import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../../src/parser/parser.js";
import { analyzeProgram } from "../../src/analyze/analyzer.js";

function analyze(source: string, file = "test.qbsk", baseDir?: string): string[] {
  const result = parse(source, file);
  expect(result.errors).toEqual([]);
  const problems = analyzeProgram(result.ast, file, baseDir);
  return problems.map((p) => `${p.message} @${p.span.start.line}:${p.span.start.col}`);
}

function msgs(source: string, file = "test.qbsk", baseDir?: string): string[] {
  const result = parse(source, file);
  expect(result.errors).toEqual([]);
  return analyzeProgram(result.ast, file, baseDir).map((p) => p.message);
}

function includesMsg(source: string, fragment: string): void {
  const result = parse(source, "test.qbsk");
  expect(result.errors).toEqual([]);
  const messages = analyzeProgram(result.ast, "test.qbsk").map((p) => p.message);
  expect(messages.some((m) => m.includes(fragment))).toBe(true);
}

describe("analyze: name resolution", () => {
  it("reports an undefined variable read", () => {
    expect(msgs("print(missing_var)")).toContain("variable 'missing_var' is not defined");
  });

  it("reports an undefined function call", () => {
    expect(msgs("missing_fn()")).toContain("variable 'missing_fn' is not defined");
  });

  it("reports an undefined assignment target", () => {
    expect(msgs("counter = 1")).toContain("variable 'counter' is not defined");
  });

  it("reports reassignment to a constant", () => {
    expect(msgs("const c = 1\nc = 2")).toContain("cannot reassign to constant 'c'");
  });

  it("reports reassignment to a module", () => {
    expect(msgs("use \"lib.qbsk\"\nlib = 1")).toContain("cannot reassign to constant 'lib'");
  });

  it("reports reassignment to a native", () => {
    expect(msgs("print = 1")).toContain("cannot reassign to 'print'");
  });

  it("reports arity mismatch on a resolvable user function", () => {
    expect(msgs("func f(a, b)\n    return a\nf(1)")).toContain(
      "function 'f' expects 2 arguments, got 1",
    );
  });

  it("reports calling a module as a function", () => {
    expect(msgs("use \"lib.qbsk\"\nlib()")).toContain("'lib' is not a function");
  });

  it("does not flag native names", () => {
    expect(msgs("print(len([1, 2]))\nprint(type(1))\nprint(sqrt(4.0))")).toEqual([]);
  });

  it("suggests the closest name with a hint", () => {
    const [msg] = analyze("var counter = 0\nprint(counterr)");
    expect(msg).toContain("variable 'counterr' is not defined");
    expect(msg).toContain("did you mean 'counter'?");
  });
});

describe("analyze: scopes", () => {
  it("shadowing in an inner block is allowed (matches the runtime)", () => {
    expect(msgs("var x = 1\nif true:\n    var x = 2")).toEqual([]);
  });

  it("inner scope uses the outer binding without problems", () => {
    expect(msgs("var x = 1\nif true:\n    print(x)")).toEqual([]);
  });

  it("function parameters are scoped to the function", () => {
    expect(msgs("func f(p)\n    return p\nf(1)")).toEqual([]);
  });

  it("reports an undefined name inside a function body", () => {
    includesMsg("func f()\n    return nope", "variable 'nope' is not defined");
  });

  it("closures can see the outer scope and the parameter", () => {
    expect(msgs("var outer = 10\nfunc add(p)\n    return p + outer\nprint(add(1))")).toEqual(
      [],
    );
  });

  it("catch parameter is scoped to the catch block", () => {
    expect(
      msgs("try:\n    var n = int(\"x\")\ncatch e:\n    print(e[\"message\"])"),
    ).toEqual([]);
  });

  it("reports an undefined name inside a catch block", () => {
    includesMsg("try:\n    var n = 1\ncatch e:\n    print(missing)", "variable 'missing' is not defined");
  });

  it("for loop variable is scoped to the loop body", () => {
    expect(msgs("for i in 0..10:\n    print(i)")).toEqual([]);
  });

  it("loop variable does not leak after the loop", () => {
    includesMsg("for i in 0..10:\n    print(i)\nprint(i)", "variable 'i' is not defined");
  });
});

describe("analyze: hoisting and modules", () => {
  it("forward reference to a top-level const is not a false positive", () => {
    expect(msgs("print(answer)\nconst answer = 42")).toEqual([]);
  });

  it("duplicate top-level definitions are flagged", () => {
    expect(msgs("func f()\n    return 1\nfunc f()\n    return 2")).toEqual([
      "variable 'f' is already defined in this scope",
    ]);
  });

  it("module member access is valid when exported", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-test-"));
    const lib = join(dir, "lib.qbsksk");
    writeFileSync(
      lib,
      "export const greeting = \"hi\"\nexport func double(n)\n    return n * 2\nconst secret = \"x\"",
    );
    const main = join(dir, "main.qbsk");
    writeFileSync(main, "use \"lib.qbsksk\"\nprint(lib.greeting)\nprint(lib.double(2))");
    const result = parse(readFileSync(main, "utf8"), main);
    expect(result.errors).toEqual([]);
    expect(analyzeProgram(result.ast, main)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("module member typo gets a hint", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-test-"));
    const lib = join(dir, "lib.qbsksk");
    writeFileSync(lib, "export const greeting = \"hi\"");
    const main = join(dir, "main.qbsk");
    writeFileSync(main, "use \"lib.qbsksk\"\nprint(lib.greetingg)");
    const result = parse(readFileSync(main, "utf8"), main);
    expect(result.errors).toEqual([]);
    const [msg] = analyzeProgram(result.ast, main).map((p) => p.message);
    expect(msg).toContain("module 'lib' has no exported member 'greetingg'");
    expect(msg).toContain("did you mean 'greeting'?");
    rmSync(dir, { recursive: true, force: true });
  });

  it("missing module file is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-test-"));
    const main = join(dir, "main.qbsk");
    writeFileSync(main, "use \"nope.qbsk\"");
    const result = parse(readFileSync(main, "utf8"), main);
    expect(result.errors).toEqual([]);
    expect(analyzeProgram(result.ast, main).map((p) => p.message)).toEqual([
      "cannot load module 'nope.qbsk': file not found",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports assignment to a module member", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-test-"));
    const lib = join(dir, "lib.qbsksk");
    writeFileSync(lib, "export const greeting = \"hi\"");
    const main = join(dir, "main.qbsk");
    writeFileSync(main, "use \"lib.qbsksk\"\nlib.greeting = \"bye\"");
    const result = parse(readFileSync(main, "utf8"), main);
    expect(result.errors).toEqual([]);
    expect(analyzeProgram(result.ast, main).map((p) => p.message)).toEqual([
      "modules are immutable: you cannot assign to a module member",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("analyze: DSL positions", () => {
  it("color names and hyphenated colors are inert, not problems", () => {
    expect(
      msgs(
        "scene S(width: 5, height: 3):\n    layer l z: 1:\n        color fg: bright-yellow\n        box (0, 0) to (2, 1)",
      ),
    ).toEqual([]);
  });

  it("anchor names are inert, not problems", () => {
    expect(
      msgs('sprite "res/hero.qba" at (1, 1) anchor: center'),
    ).toEqual([]);
  });

  it("a real expression in a DSL value is still checked", () => {
    expect(
      msgs("var n = 1\nprint(n + missing)"),
    ).toContain("variable 'missing' is not defined");
  });
});

describe("analyze: state directives that never reach a primitive are dead (an earlier release)", () => {
  it("a visible: at the end of a layer reaches nothing", () => {
    const src = [
      "var show = false",
      "scene P(width: 20, height: 5)",
      "layer l z: 1",
      '    put "A" at (1, 1)',
      "    visible: show",
    ].join("\n");
    includesMsg(src, "this 'visible:' never reaches a primitive");
  });

  it("a visible: overwritten before any primitive is dead (span on the first one)", () => {
    const src = [
      "var show = false",
      "scene P(width: 20, height: 5)",
      "layer l z: 1",
      "    visible: show",
      "    visible: show",
      '    put "A" at (1, 1)',
    ].join("\n");
    const problems = analyze(src);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("this 'visible:' never reaches a primitive");
    expect(problems[0]).toContain("@4:5");
  });

  it("a color: whose every key is overwritten is dead", () => {
    const src = [
      "scene P(width: 20, height: 5)",
      "layer l z: 1",
      "    color fg: red",
      "    color fg: green",
      '    put "A" at (1, 1)',
    ].join("\n");
    const problems = msgs(src);
    expect(problems.some((m) => m.includes("this 'color:' never reaches a primitive"))).toBe(true);
    expect(problems.filter((m) => m.includes("color:' never reaches"))).toHaveLength(1);
  });

  it("a color: whose keys partially survive is NOT dead", () => {
    const src = [
      "scene P(width: 20, height: 5)",
      "layer l z: 1",
      "    color fg: red bg: blue",
      "    color fg: green",
      '    put "A" at (1, 1)',
    ].join("\n");
    expect(msgs(src).some((m) => m.includes("this 'color:' never reaches a primitive"))).toBe(false);
  });

  it("a trailing z: after its primitives is dead", () => {
    const src = [
      "scene P(width: 20, height: 5)",
      "layer l z: 1",
      '    put "A" at (1, 1)',
      "    z: 9",
    ].join("\n");
    includesMsg(src, "this 'z:' never reaches a primitive");
  });

  it("live directives — one before a group of primitives — are clean", () => {
    const src = [
      "var show = false",
      "scene P(width: 20, height: 5)",
      "layer l z: 1",
      "    visible: show",
      '    put "A" at (1, 1)',
      '    put "B" at (3, 1)',
      "    color fg: green",
      '    put "C" at (5, 1)',
      "    z: 9",
      '    put "D" at (7, 1)',
    ].join("\n");
    expect(msgs(src)).toEqual([]);
  });

  it("the dead directive does not fire inside a scene-less program", () => {
    expect(msgs('put "x" at (1, 1)')).toEqual([]);
  });
});
