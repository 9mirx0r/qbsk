// Expressions, statements and blocks are each compiled once per AST node and evaluated
// many times (F6 rungs 5 and 6).
//
// That cache lives ON the syntax tree, which is the only place reachable without a
// lookup per evaluation — and a syntax tree outlives the interpreter that first ran it.
// So the compiled form must be a function OF the interpreter rather than a closure OVER
// one. These are the tests that fail when it is not.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "../../src/parser/parser.js";
import { Interpreter, runQbsk } from "../../src/interp/interpreter.js";
import type { Program } from "../../src/parser/ast.js";

function parsed(lines: string[]): Program {
  const p = parse(lines.join("\n"), "t.qbsk");
  expect(p.errors).toEqual([]);
  return p.ast;
}

/** One fresh interpreter over an ALREADY-PARSED tree, returning what it printed. */
function run(ast: Program): string[] {
  const out: string[] = [];
  new Interpreter({ print: (line) => out.push(line) }).evalProgram(ast);
  return out;
}

describe("a syntax tree run twice", () => {
  it("gives the second run its own state, not the first run's", () => {
    // The failure this pins: a thunk that captured `this` at compile time keeps
    // reading the FIRST interpreter's environment, so the second run reports 2.
    const ast = parsed(["var n = 0", "n = n + 1", "print(str(n))"]);
    expect(run(ast)).toEqual(["1"]);
    expect(run(ast)).toEqual(["1"]);
  });

  it("keeps two interpreters over one tree from seeing each other's variables", () => {
    // Interleaved rather than sequential, because a captured environment can survive
    // one full run and only show up when the two are alive at the same time.
    const ast = parsed(["var n = 0", "n = n + 41", "print(str(n))"]);
    const a: string[] = [];
    const b: string[] = [];
    const ia = new Interpreter({ print: (line) => a.push(line) });
    const ib = new Interpreter({ print: (line) => b.push(line) });
    ia.evalProgram(ast);
    ib.evalProgram(ast);
    expect(a).toEqual(["41"]);
    expect(b).toEqual(["41"]);
  });

  it("does not fail a program on an expression it never reaches", () => {
    // `or` short-circuits, so the right operand never evaluates — but compiling an
    // expression compiles its WHOLE subtree, so `1 .. 5` is built either way. Every arm
    // that can only ever end in an error — `..` used as a value, an `ErrorExpr` the
    // parser left behind — must therefore compile to a thunk that throws when CALLED,
    // not throw while being built. Get that wrong and a program dies on an operand it
    // was written never to reach.
    const ast = parsed([
      "var n = 1",
      "if n > 0 or (1 .. 5)",
      "    print(\"taken\")",
    ]);
    expect(run(ast)).toEqual(["taken"]);
    expect(run(ast)).toEqual(["taken"]);
  });

  it("closes a lambda over the interpreter that made it", () => {
    // A lambda captures `env` when it EVALUATES, which is the one place the old switch
    // read interpreter state while building a value rather than while using one.
    const ast = parsed([
      "func apply(f, x)",
      "    return f(x)",
      "var k = 10",
      "print(str(apply(func(v) v + k, 5)))",
    ]);
    expect(run(ast)).toEqual(["15"]);
    expect(run(ast)).toEqual(["15"]);
  });
});

// ---------------------------------------------------------------------------
// Assignment resolves its binding ONCE (F6 rung 7).
//
// `x = x + 1` used to walk the scope chain twice: `get` to read the old value and
// report an undefined name, then `assign` to write and report a const. One resolution
// serves both — but only if it keeps reporting the same thing, at the same place. The
// messages are pinned elsewhere (tests/unit/interp.test.ts); what is pinned here is
// WHERE, because a span is exactly what a refactor moves without any test noticing.
// ---------------------------------------------------------------------------

describe("what an assignment reports, and from where", () => {
  function failure(lines: string[]): { message: string; line: number; col: number } {
    const r = runQbsk(lines.join("\n"), "t.qbsk");
    expect(r.error).not.toBeNull();
    return {
      message: r.error!.message,
      line: r.error!.span.start.line,
      col: r.error!.span.start.col,
    };
  }

  it("points an undefined name at the name, not at the statement", () => {
    const f = failure(["var a = 1", "    ", "nope += a"]);
    expect(f.message).toContain("variable 'nope' is not defined");
    expect([f.line, f.col]).toEqual([3, 1]);
  });

  it("points a const reassignment at the whole statement", () => {
    // The statement, because the mistake is the assignment rather than the name: the
    // name is spelled correctly and refers to exactly what the author meant.
    const f = failure(["const PI = 3", "PI = 4"]);
    expect(f.message).toContain("cannot reassign to constant 'PI'");
    expect([f.line, f.col]).toEqual([2, 1]);
  });

  it("refuses to reassign a native, with its own message", () => {
    // The third binding kind, and the one no test covered: natives are neither var nor
    // const, so a resolution that only asked "is it const?" would let `len = 1` through
    // and quietly replace a native for the rest of the run.
    const f = failure(["len = 1"]);
    expect(f.message).toContain("cannot reassign to 'len'");
    expect(f.line).toBe(1);
  });

  it("still compounds through a dict and a list in place", () => {
    const r = runQbsk(
      ["var d = {\"n\": 1}", "var l = [10, 20]", "d[\"n\"] += 4", "l[1] -= 5",
       "print(str(d[\"n\"]) + \",\" + str(l[1]))"].join("\n"),
      "t.qbsk",
    );
    expect(r.error?.message ?? null).toBeNull();
    expect(r.out).toEqual(["5,15"]);
  });
});

// ---------------------------------------------------------------------------
// The two properties the code calls out as deliberate and no test held.
//
// Both are the kind a later refactor moves in silence: nothing goes red, a program just
// starts reporting a different mistake, or starts sharing a value it should not.
// ---------------------------------------------------------------------------

describe("what a call reports when more than one thing is wrong", () => {
  it("reports the argument's own failure before the named-argument rule", () => {
    // `buildExpr` decides at COMPILE time that a call carries named arguments, but must
    // still evaluate callee and arguments before reporting — because that is what the
    // switch did, and because an argument that fails on its own terms is the mistake the
    // author actually made. Reporting the named-arg rule first would send them to fix
    // the wrong line.
    const r = runQbsk('func f(a)\n    return a\nprint(str(f(1 / 0, x: 1)))', "t.qbsk");
    expect(r.error?.message ?? "").toContain("division by zero");
  });

  it("still reports the named-argument rule when nothing else is wrong", () => {
    // Guards the guard: if the arm never reported at all, the assertion above would hold
    // for the wrong reason.
    const r = runQbsk('func f(a)\n    return a\nprint(str(f(1, x: 1)))', "t.qbsk");
    expect(r.error?.message ?? "").toContain("named arguments are not supported");
  });

  it("reports an undefined callee before either", () => {
    const r = runQbsk("nosuch(1, x: 2)", "t.qbsk");
    expect(r.error?.message ?? "").toContain("'nosuch' is not defined");
  });
});

describe("one QValue per literal, shared by every evaluation", () => {
  it("does not let a value written into a list be edited through another copy", () => {
    // A literal compiles to ONE QValue that every evaluation returns. That is only sound
    // because no QValue is ever edited in place — `Env.write` rebinds a `Binding`, it
    // never writes through. If anything ever did edit one, this list would read
    // [6, 6, 6]: all three entries are the same shared object.
    const r = runQbsk(
      ["var a = []", "push(a, 5)", "push(a, 5)", "push(a, 5)", "a[0] += 1",
       "print(str(a))"].join("\n"),
      "t.qbsk",
    );
    expect(r.error?.message ?? null).toBeNull();
    expect(r.out).toEqual(["[6, 5, 5]"]);
  });

  it("compares two evaluations of the same literal by value, not by identity", () => {
    // The other half of the licence: §11.19 compares scalars by value, so sharing is
    // invisible. If equality ever became identity-based for scalars, sharing would start
    // making unrelated literals compare equal.
    const r = runQbsk('print(str(1 == 1) + "," + str("a" == "a"))', "t.qbsk");
    expect(r.out).toEqual(["true,true"]);
  });
});

// ---------------------------------------------------------------------------
// Every statement kind is compiled or declarative — exactly one of the two.
//
// `buildStmt` specialises the control-flow half and routes the rest to
// `execDeclarative`, whose `default:` arm reports rather than returning null. That
// partition is hand-maintained: TypeScript cannot prove it, because in that `default:`
// the parameter is still the union of the compiled kinds rather than `never`.
//
// A kind in NEITHER switch fails loudly at run time, which is the safe direction. A kind
// in BOTH silently dead-codes the declarative arm — nothing reports, and the statement
// quietly does whichever the compiler reached first. This is the guard for that.
// ---------------------------------------------------------------------------

describe("the statement kinds are partitioned, not merely covered", () => {
  const root = resolve(import.meta.dirname, "..", "..");
  const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

  /** Every member of the `Stmt` union, from the type that defines it. */
  function stmtKinds(): string[] {
    const ast = read("src/parser/ast.ts");
    const union = /export type Stmt =([\s\S]*?);\n/.exec(ast);
    expect(union, "src/parser/ast.ts must declare `export type Stmt =`").not.toBeNull();
    return union![1]!
      .split("|")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /** The `case "X":` labels inside one method of the interpreter. */
  function casesIn(method: string): string[] {
    const src = read("src/interp/interpreter.ts");
    const start = src.indexOf(method);
    expect(start, `${method} must exist`).toBeGreaterThan(-1);
    // Up to the next method at the same indent, which is where this switch ends.
    const rest = src.slice(start + method.length);
    const end = rest.search(/\n {2}(?:private|public|static|\w+\()/);
    const body = end === -1 ? rest : rest.slice(0, end);
    return [...body.matchAll(/case "(\w+)":/g)].map((m) => m[1]!);
  }

  it("splits every kind between buildStmt and execDeclarative, with no overlap", () => {
    const kinds = stmtKinds();
    // The union names interfaces (`VarDecl`), and each interface's `kind` is its own
    // name — checked here rather than assumed, since that convention is what lets the
    // two lists be compared at all.
    const ast = read("src/parser/ast.ts");
    for (const name of kinds) {
      expect(ast, `${name} must declare kind: "${name}"`).toContain(`kind: "${name}"`);
    }

    const compiled = new Set(casesIn("private static buildStmt(stmt: Stmt): StmtThunk {"));
    const declarative = new Set(
      casesIn("private execDeclarative(stmt: Stmt): QValue | null {"),
    );

    const neither = kinds.filter((k) => !compiled.has(k) && !declarative.has(k));
    const both = kinds.filter((k) => compiled.has(k) && declarative.has(k));
    expect(neither, "statement kinds handled by neither switch").toEqual([]);
    expect(both, "statement kinds handled by both switches").toEqual([]);
    expect(compiled.size + declarative.size).toBe(kinds.length);
  });
});
