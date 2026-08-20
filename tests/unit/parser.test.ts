import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { printAst } from "../../src/parser/ast.js";
import { parse } from "../../src/parser/parser.js";

function ast(source: string): string {
  return printAst(parse(source, "test.qbsk").ast);
}

function errors(source: string): string[] {
  return parse(source, "test.qbsk").errors.map((e) => e.message);
}

describe("parse: declarations", () => {
  it("empty program", () => {
    expect(ast("")).toBe("(Program)");
  });

  it("var with all literals", () => {
    const src = [
      "var a = 42",
      "var b = 3.5",
      'var c = "hello"',
      "var d = true",
      "var e = null",
    ].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (VarDecl a = 42)",
        "  (VarDecl b = 3.5)",
        '  (VarDecl c = "hello")',
        "  (VarDecl d = true)",
        "  (VarDecl e = null))",
      ].join("\n"),
    );
  });

  it("var with type annotation, without init, and const", () => {
    const src = ["var x: int = 1", "var y", "const PI = 3.1415"].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (VarDecl x : int = 1)",
        "  (VarDecl y)",
        "  (ConstDecl PI = 3.1415))",
      ].join("\n"),
    );
  });

  it("assignments =, +=, -= and to a member", () => {
    const src = ["x = 1", "hero.x += 1", "hero.y -= 2"].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (Assign x = 1)",
        "  (Assign hero.x += 1)",
        "  (Assign hero.y -= 2))",
      ].join("\n"),
    );
  });

  it("lists: [1, 2, 3], empty and nested (L1.5)", () => {
    expect(ast("var a = [1, 2, 3]")).toBe(
      '(Program\n  (VarDecl a = [1, 2, 3]))',
    );
    expect(ast("var b = []")).toBe("(Program\n  (VarDecl b = []))");
    expect(ast("var c = [1, [2, 3], \"x\"]")).toBe(
      '(Program\n  (VarDecl c = [1, [2, 3], "x"]))',
    );
  });

  it("dicts: {\"key\": value}, identifier key and empty (L1.5)", () => {
    expect(ast('var d = {"key": 1, "other": 2}')).toBe(
      '(Program\n  (VarDecl d = {"key": 1, "other": 2}))',
    );
    expect(ast("var e = {name: \"ada\"}")).toBe(
      '(Program\n  (VarDecl e = {"name": "ada"}))',
    );
    expect(ast("var f = {}")).toBe("(Program\n  (VarDecl f = {}))");
  });

  it("indexing: list[int] and dict[\"key\"] as postfix (L1.5)", () => {
    expect(ast("print(l[0])")).toBe(
      '(Program\n  (ExprStmt (Call print l[0])))',
    );
    expect(ast('print(d["key"])')).toBe(
      '(Program\n  (ExprStmt (Call print d["key"])))',
    );
    expect(ast("print(n[1][0])")).toBe(
      '(Program\n  (ExprStmt (Call print n[1][0])))',
    );
  });

  it("dict with non-string/ident key → error", () => {
    expect(errors("var d = {42: 1}")).toEqual([
      "dict keys must be strings or identifiers",
    ]);
  });

  it("multi-line literal inside [ ] and { } ignores INDENT/DEDENT", () => {
    const src = [
      "var l = [",
      "    1,",
      "    2,",
      "]",
      "var d = {",
      '    "a": 1,',
      '    "b": 2,',
      "}",
    ].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (VarDecl l = [1, 2])",
        '  (VarDecl d = {"a": 1, "b": 2}))',
      ].join("\n"),
    );
  });

  it("implicit call by juxtaposition (title \"hello\")", () => {
    expect(ast('title "hello"')).toBe(
      '(Program\n  (ExprStmt (Call title "hello")))',
    );
  });

  it("func with params, annotations and return annotation", () => {
    const src = ["func f(a: int, b): int", "    return a + b"].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (FuncDecl f (Param a int) (Param b) -> int",
        "    (Block",
        "      (Return (+ a b)))))",
      ].join("\n"),
    );
  });
});

describe("parse: control flow", () => {
  it("if / elif / else with blocks", () => {
    const src = [
      "if a > 1",
      "    b = 2",
      "elif a == 1",
      "    b = 3",
      "else",
      "    b = 4",
    ].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (If",
        "    (Cond (> a 1))",
        "    (Block",
        "      (Assign b = 2))",
        "    (Elif",
        "      (Cond (== a 1))",
        "      (Block",
        "        (Assign b = 3)))",
        "    (Else",
        "      (Block",
        "        (Assign b = 4)))))",
      ].join("\n"),
    );
  });

  it("inline if with simple bodies", () => {
    expect(ast("if x: y = 1")).toBe(
      "(Program\n  (If (Cond x) (Block (Assign y = 1))))",
    );
  });

  it("while with inline break/continue", () => {
    const src = [
      "while x < 10",
      "    if x == 5: break",
      "    if x > 3: continue",
      "    x += 1",
    ].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (While (< x 10)",
        "    (Block",
        "      (If (Cond (== x 5)) (Block (Break)))",
        "      (If (Cond (> x 3)) (Block (Continue)))",
        "      (Assign x += 1))))",
      ].join("\n"),
    );
  });

  it("for range 0..10", () => {
    const src = ["for i in 0..10", "    print(i)"].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (ForRange i 0 10",
        "    (Block",
        "      (ExprStmt (Call print i)))))",
      ].join("\n"),
    );
  });

  it("for range with compound bound 0..n-1", () => {
    const src = ["for i in 0..n-1", "    print(i)"].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (ForRange i 0 (- n 1)",
        "    (Block",
        "      (ExprStmt (Call print i)))))",
      ].join("\n"),
    );
  });

  it("for over a list", () => {
    const src = ["for item in items", "    print(item)"].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (ForList item items",
        "    (Block",
        "      (ExprStmt (Call print item)))))",
      ].join("\n"),
    );
  });

  it("return without value", () => {
    expect(ast("return")).toBe("(Program\n  (Return))");
  });

  it("match with arms and else", () => {
    const src = [
      "match x",
      '    "a":',
      "        r = 1",
      "    else:",
      "        r = 2",
    ].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (Match x",
        '    (Arm "a"',
        "      (Block",
        "        (Assign r = 1)))",
        "    (Else",
        "      (Block",
        "        (Assign r = 2)))))",
      ].join("\n"),
    );
  });

  it("try/catch with blocks", () => {
    const src = [
      "try:",
      '    var n = int("abc")',
      "catch e:",
      '    print(e["message"])',
    ].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (Try",
        "    (Block",
        '      (VarDecl n = (Call int "abc")))',
        "    (Catch e",
        "      (Block",
        '        (ExprStmt (Call print e["message"]))))))',
      ].join("\n"),
    );
  });

  it("try without catch → error", () => {
    expect(errors("try:\n    x = 1")[0]).toContain("expected 'catch'");
  });

  it("catch without variable → error", () => {
    expect(errors("try:\n    x = 1\ncatch:")[0]).toContain(
      "expected an identifier",
    );
  });
});

describe("parse: expressions (Pratt)", () => {
  it("precedence: * over +", () => {
    expect(ast("1 + 2 * 3")).toBe(
      "(Program\n  (ExprStmt (+ 1 (* 2 3))))",
    );
  });

  it("precedence: and over or", () => {
    expect(ast("a or b and c")).toBe(
      "(Program\n  (ExprStmt (or a (and b c))))",
    );
  });

  it("unary: -x * y and not a == b", () => {
    expect(ast("-x * y")).toBe("(Program\n  (ExprStmt (* (- x) y)))");
    expect(ast("not a == b")).toBe("(Program\n  (ExprStmt (== (not a) b)))");
  });

  it("double unary --x", () => {
    expect(ast("--x")).toBe("(Program\n  (ExprStmt (- (- x))))");
  });

  it("call with positional args", () => {
    expect(ast("f(1, 2)")).toBe("(Program\n  (ExprStmt (Call f 1 2)))");
  });

  it("call with named args (animate)", () => {
    expect(ast('animate("x", from: 10, to: 100)')).toBe(
      '(Program\n  (ExprStmt (Call animate "x" (Param from 10) (Param to 100))))',
    );
  });

  it("member chain a.b.c", () => {
    expect(ast("a.b.c")).toBe("(Program\n  (ExprStmt (Member (Member a b) c)))");
  });

  it("tuples with vector arithmetic", () => {
    expect(ast("(1, 2) + (3, 4)")).toBe(
      "(Program\n  (ExprStmt (+ (1, 2) (3, 4))))",
    );
  });
});

describe("parse: string interpolation (L2)", () => {
  it("plain non-interpolated string does not change", () => {
    expect(ast('var s = "hello"')).toContain('(VarDecl s = "hello")');
  });

  it("a single interpolation", () => {
    expect(ast('var s = "hello {name}"')).toContain(
      '(VarDecl s = (Interp "hello " name ""))',
    );
  });

  it("several interpolations with text in between", () => {
    expect(ast('var s = "a{x}b{y}c"')).toContain(
      '(VarDecl s = (Interp "a" x "b" y "c"))',
    );
  });

  it("arithmetic expressions inside", () => {
    expect(ast('var s = "s: {1 + 2}"')).toContain(
      '(VarDecl s = (Interp "s: " (+ 1 2) ""))',
    );
  });

  it("native calls inside", () => {
    expect(ast('var s = "r: {len("hello")}"')).toContain(
      '(VarDecl s = (Interp "r: " (Call len "hello") ""))',
    );
  });

  it("dict literal inside (as a subexpression)", () => {
    expect(ast('var s = "r: {f({"a": 1})}"')).toContain(
      '(VarDecl s = (Interp "r: " (Call f {"a": 1}) ""))',
    );
  });

  it("nested interpolation (string interpolating inside)", () => {
    expect(ast('var s = "r: {f("x{1}")}"')).toContain(
      '(VarDecl s = (Interp "r: " (Call f (Interp "x" 1 "")) ""))',
    );
  });

  it("{{ in a plain string is literal", () => {
    expect(ast('var s = "a{{b"')).toContain('(VarDecl s = "a{b")');
  });

  it("empty interpolation → parse error", () => {
    expect(errors('var s = "{}"')).not.toEqual([]);
  });
});

describe("parse: declarative DSL", () => {
  it("scene with all params, without block", () => {
    const src = 'scene Game(width: 80, height: 24, title: "Hello QBSK", fps: 30)';
    expect(ast(src)).toBe(
      "(Program\n  (SceneDecl Game (Param width 80) (Param height 24) (Param title \"Hello QBSK\") (Param fps 30)))",
    );
  });

  it("layer z with primitives", () => {
    const src = [
      "layer frame z: 100",
      '    border (0, 0) to (79, 23) style: double',
      '    text "QBSK" at (36, 10)',
      "    color fg: cyan",
    ].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (LayerDecl frame (Param z 100)",
        "    (Block",
        "      (Border (0, 0) to (79, 23) (Param style double))",
        '      (Text "QBSK" at (36, 10))',
        "      (Color (Param fg cyan)))))",
      ].join("\n"),
    );
  });

  it("fill, put, line, box", () => {
    const src = [
      'fill " "',
      'put "H" at (1, 2)',
      "line (0, 0) to (10, 10)",
      "box (1, 1) to (5, 5)",
    ].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        '  (Fill " ")',
        '  (Put "H" at (1, 2))',
        "  (Line (0, 0) to (10, 10))",
        "  (Box (1, 1) to (5, 5)))",
      ].join("\n"),
    );
  });

  it("a bare anchor: is rejected, it is not a directive (§14.2)", () => {
    // This used to assert `(Anchor center)` in the AST — it pinned the ghost as
    // correct behaviour. A bare `anchor:` composed to nothing in silence, so the
    // parser now refuses it and points at where an anchor belongs.
    expect(errors("anchor: center")).toEqual([
      "'anchor:' is not a layer directive — put it on the primitive it positions",
    ]);
  });

  it("sprite with frames/fps/loop", () => {
    const src = [
      'sprite "res/walk.qba" at (10, 20) frames: 6 fps: 10 loop: true',
    ].join("\n");
    expect(ast(src)).toBe(
      "(Program\n  (Sprite \"res/walk.qba\" at (10, 20) (Param frames 6) (Param fps 10) (Param loop true)))",
    );
  });

  it("the old sprinkle syntax no longer parses (§14.5)", () => {
    // `sprinkle` is an ordinary identifier now, so this reads as an expression
    // statement followed by garbage — it fails, which is the point.
    expect(errors('sprinkle "✦" count: 40 at random').length).toBeGreaterThan(0);
  });

  it("canvas block with dedented literal", () => {
    const src = [
      "canvas hero_sprite at (10, 5):",
      '    """',
      "     O",
      "    /|\\",
      "    / \\",
      '    """',
    ].join("\n");
    expect(ast(src)).toBe(
      "(Program\n  (Canvas hero_sprite at (10, 5) " +
        String.raw`" O\n/|\\\n/ \\"` +
        "))",
    );
  });

  it("events: start, tick, key inline, resize", () => {
    const src = [
      "on start",
      '    title "hello"',
      "on tick(dt: seconds)",
      "    hero.x += 1",
      'on key "arrow-left": dx = -1',
      "on resize(w, h)",
      "    x = w",
    ].join("\n");
    expect(ast(src)).toBe(
      [
        "(Program",
        "  (Event start",
        "    (Block",
        '      (ExprStmt (Call title "hello"))))',
        "  (Event tick (Param dt seconds)",
        "    (Block",
        "      (Assign hero.x += 1)))",
        '  (Event key "arrow-left"',
        "    (Block",
        "      (Assign dx = -1)))",
        "  (Event resize (Param w) (Param h)",
        "    (Block",
        "      (Assign x = w))))",
      ].join("\n"),
    );
  });

  it('use "res/other.qbsk"', () => {
    expect(ast('use "res/other.qbsk"')).toBe(
      '(Program\n  (Use "res/other.qbsk"))',
    );
  });

  it('use "res/other.qbsk" as m binds an alias', () => {
    expect(ast('use "res/other.qbsk" as m')).toBe(
      '(Program\n  (Use "res/other.qbsk" as m))',
    );
  });

  it('use "as" without a name → error', () => {
    expect(errors('use "res/other.qbsk" as')).toContain(
      "expected the module name after 'as'",
    );
  });

  it("export const and export func", () => {
    expect(ast("export const VERSION = \"1\"\nexport func f(n)\n    return n")).toBe(
      [
        "(Program",
        "  (export ConstDecl VERSION = \"1\")",
        "  (export FuncDecl f (Param n)",
        "    (Block",
        "      (Return n))))",
      ].join("\n"),
    );
  });

  it("export var → error (exported bindings are immutable)", () => {
    expect(errors("export var x = 1")[0]).toContain("immutable");
  });

  it("export inside a block → error (top level only)", () => {
    expect(
      errors("func f()\n    export const x = 1")[0],
    ).toContain("'export' is only allowed at the top level of a file");
  });

  it("export on a non-declaration → error", () => {
    expect(errors('export print("x")')[0]).toContain(
      "'export' applies only to top-level 'const' and 'func'",
    );
  });

  it("complete golden: examples/hello.qbsk", () => {
    const source = readFileSync(
      new URL("../../examples/hello.qbsk", import.meta.url),
      "utf8",
    );
    expect(ast(source)).toBe(
      [
        "(Program",
        "  (SceneDecl Game (Param width 80) (Param height 24) (Param title \"Hello QBSK\") (Param fps 30))",
        "  (LayerDecl frame (Param z 100)",
        "    (Block",
        "      (Border (0, 0) to (79, 23) (Param style double))",
        '      (Text "QBSK" at (36, 10))))',
        "  (LayerDecl hero (Param z 50)",
        "    (Block",
        "      (Canvas hero_sprite at (10, 5) " +
          String.raw`" O\n/|\\\n/ \\"` +
          "))))",
      ].join("\n"),
    );
  });
});

describe("parse: errors and recovery", () => {
  it("var without name → error and the rest parses", () => {
    const src = ["var = 5", "var b = 6"].join("\n");
    const result = parse(src, "test.qbsk");
    expect(result.errors.map((e) => e.message)).toEqual([
      "expected an identifier after 'var'",
    ]);
    expect(printAst(result.ast)).toBe(
      "(Program\n  (Error \"expected an identifier after 'var'\")\n  (VarDecl b = 6))",
    );
  });

  it("if without block → error, next statement survives", () => {
    const src = ["if x", "var b = 1"].join("\n");
    const result = parse(src, "test.qbsk");
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.message).toContain("block");
    expect(printAst(result.ast)).toContain("(VarDecl b = 1)");
  });

  it("two errors in one pass (multi-error recovery)", () => {
    const src = ["var = 1", "if x", "var c = 2"].join("\n");
    const result = parse(src, "test.qbsk");
    expect(result.errors.length).toBe(2);
    expect(printAst(result.ast)).toContain("(VarDecl c = 2)");
  });

  it("assignment to a non-target", () => {
    expect(errors("(1, 2) = 5")).toEqual(["cannot assign to this expression"]);
  });

  it("missing RPAREN in call", () => {
    expect(errors("f(1")).toEqual(["expected ')' in a call"]);
  });

  it("invalid annotation", () => {
    expect(errors("var x: 3 = 1")).toEqual([
      "expected a type identifier after ':'",
    ]);
  });

  // This test used to assert that `(1)` was an ERROR, pinning a limitation as though it
  // were a rule: `(` always started a tuple, so parentheses could not group anything and
  // `(a + b) * 4` did not parse. A single parenthesised expression is now a group.
  it("a single parenthesised expression is a group, not a broken tuple", () => {
    expect(errors("var t = (1)")).toEqual([]);
  });

  it("a tuple missing its closing paren still reports", () => {
    expect(errors("var t = (1, 2")).not.toEqual([]);
  });

  it("more than two elements is still not a tuple", () => {
    expect(errors("var t = (1, 2, 3)")).not.toEqual([]);
  });

  it("layer without z", () => {
    expect(errors(['layer foo', '    fill " "'].join("\n"))).toEqual([
      "layer requires 'z:'",
    ]);
  });

  it("scene without width and height", () => {
    expect(errors("scene Bad(fps: 30)")).toEqual([
      "scene requires 'width' and 'height'",
    ]);
  });

  it("error with correct span", () => {
    const result = parse("var = 5", "test.qbsk");
    const err = result.errors[0];
    expect(err?.span.start.line).toBe(1);
    expect(err?.span.start.col).toBe(5);
    expect(err?.span.file).toBe("test.qbsk");
  });
});

describe("parse: reserved names teach the cause, not the symptom (§15.15)", () => {
  it("takes a scene word as a layer name, which §15.15 made legal", () => {
    // This asserted the opposite until 2026-08-19: `layer box z: 5` reported "'box' is a
    // scene primitive and cannot be a layer name". §15.15 freed all twenty-six scene
    // words outside statement position, and a layer name is one of those positions. The
    // message it used to give is still owed by the twenty-five core keywords, which is
    // what the case below checks.
    const src = [
      'scene P(width: 40, height: 10)',
      '  layer box z: 5',
      '    put "x" at (1, 1)',
    ].join("\n");
    const result = parse(src, "test.qbsk");
    expect(result.errors).toEqual([]);
    expect(result.ast.body[0]!.kind).toBe("SceneDecl");
  });

  it("takes a DSL keyword in a layer name slot too", () => {
    expect(errors('layer color z: 1\n    put "x" at (1, 1)')).toEqual([]);
  });

  it("a language keyword in a layer name slot is named too", () => {
    expect(errors('layer if z: 1\n    put "x" at (1, 1)')[0]).toBe(
      "'if' is a reserved keyword and cannot be a layer name",
    );
  });

  it("scene and canvas name slots take a scene word, and still name a core keyword", () => {
    expect(errors("scene box (width: 10, height: 5)")).toEqual([]);
    expect(
      errors([
        "scene P(width: 10, height: 5)",
        "  canvas box at (0, 0):",
        '      """',
        "      X",
        '      """',
      ].join("\n")),
    ).toEqual([]);
    // The cause-naming message survives where a name is still genuinely impossible.
    expect(errors("scene return (width: 10, height: 5)")[0]).toBe(
      "'return' is a reserved keyword and cannot be a scene name",
    );
  });

  it("takes every scene word as a parameter, and still names a core keyword", () => {
    // Three of these asserted a reservation that §15.15 removed. What is left of the
    // original claim — that the message says WHY and not merely that parsing failed — is
    // asserted against the words that are still reserved, which is where it now belongs.
    for (const word of ["color", "anchor", "visible", "box", "from", "to", "line", "z"]) {
      expect(errors(`func paint(${word})`), word).toEqual([
        "expected ':' or an indented block",
      ]);
    }
    expect(errors("func paint(return)")[0]).toBe(
      "'return' is a reserved keyword and cannot be a parameter name",
    );
  });

  it("event handler parameter slots take scene words and name a core keyword", () => {
    expect(errors("on tick(color)")).toEqual(["expected ':' or an indented block"]);
    expect(errors("on turn(z)")).toEqual(["expected ':' or an indented block"]);
    expect(errors("on resize(from, to)")).toEqual([
      "expected ':' or an indented block",
    ]);
    expect(errors("on tick(while)")[0]).toBe(
      "'while' is a reserved keyword and cannot be a parameter name",
    );
  });
});

describe("parse: lexer errors are returned, not thrown (parser.ts:171-188)", () => {
  it("an unknown character returns a syntax error instead of throwing", () => {
    // The character § is not valid in QBSK — it would previously throw from
    // tokenize() and crash the Electron main process (parser.ts:174-188).
    const errs = errors("var x = 1 § 2");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain("unexpected character");
  });

  it("an unterminated string returns a syntax error instead of throwing", () => {
    const errs = errors('var x = "unterminated');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toContain("unterminated string");
  });
});
