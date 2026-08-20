// §14.8 — the AST printer must not hide what the parser read.
//
// `printAst` is how the parser is verified. A field it omits is a field tests
// cannot see, so an omission is not cosmetic: it is a blind spot in the
// instrument. `PutStmt` printed neither `depth` nor `world`, which made three
// structurally different programs print identically — and printed `at` for a
// `world:` coordinate, which was not an omission but a wrong answer.

import { describe, expect, it } from "vitest";
import { parse } from "../../src/parser/parser.js";
import { printAst } from "../../src/parser/ast.js";

const ast = (source: string) => {
  const parsed = parse(source, "printer.qbsk");
  expect(parsed.errors).toEqual([]);
  return printAst(parsed.ast);
};

describe("printAst shows every field the parser stored (§14.8)", () => {
  it("three different puts no longer print the same string", () => {
    const plain = ast('put "X" at (0, 0)');
    const deep = ast('put "X" at (0, 0) depth: 3');
    const world = ast('put "X" world: (0, 0)');

    expect(new Set([plain, deep, world]).size).toBe(3);
  });

  it("put prints depth when it is there, and omits it when it is not", () => {
    expect(ast('put "X" at (0, 0) depth: 3')).toContain("depth: 3");
    expect(ast('put "X" at (0, 0)')).not.toContain("depth");
  });

  it("a world coordinate prints as 'world:', never as 'at'", () => {
    const text = ast('put "X" world: (4, 5)');
    expect(text).toContain("world: (4, 5)");
    expect(text).not.toContain("at (4, 5)");
  });

  it("text and sprite print world: too", () => {
    expect(ast('text "hi" world: (1, 2)')).toContain("world: (1, 2)");
    expect(ast('sprite "res/hero.qba" world: (1, 2)')).toContain(
      "world: (1, 2)",
    );
  });

  it("a layer's at offset is visible", () => {
    expect(ast("layer hud z: 9 at (0, 8)\n    fill \".\"")).toContain(
      "(Param at (0, 8))",
    );
  });

  it("a layer without an offset prints no at", () => {
    expect(ast("layer hud z: 9\n    fill \".\"")).not.toContain("Param at");
  });

  it("depth and world compose on one put", () => {
    const text = ast('put "X" world: (1, 2) depth: 7');
    expect(text).toContain("world: (1, 2)");
    expect(text).toContain("depth: 7");
  });
});
