import { describe, expect, it, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Interpreter,
  runQbsk,
  type RunResult,
} from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";

function run(source: string): RunResult {
  return runQbsk(source, "test.qbsk");
}

function out(source: string): string[] {
  const r = run(source);
  expect(r.error).toBeNull();
  return r.out;
}

function err(source: string): string {
  const r = run(source);
  expect(r.error).not.toBeNull();
  return r.error?.message ?? "";
}

describe("eval: literals and arithmetic", () => {
  it("int and float are distinct types", () => {
    expect(out('print(type(42))\nprint(type(3.5))')).toEqual(["int", "float"]);
  });

  it("mixed int+float arithmetic → float", () => {
    expect(out("print(type(1 + 2))\nprint(type(1 + 2.5))")).toEqual([
      "int",
      "float",
    ]);
  });

  it("division is always float: 4/2 → 2.0", () => {
    expect(out("print(4 / 2)")).toEqual(["2.0"]);
  });

  it("% operator and unary -", () => {
    expect(
      out("var x = 5\nprint(-x)\nprint(--x)\nprint(7 % 3)"),
    ).toEqual(["-5", "5", "1"]);
  });

  it("string concat with +", () => {
    expect(out('print("hello" + " " + "world")')).toEqual(["hello world"]);
  });

  it("string repetition with * (both orders)", () => {
    expect(out('print("ab" * 3)\nprint(2 * "xy")')).toEqual([
      "ababab",
      "xyxy",
    ]);
  });

  it("str + int → error with types and hint", () => {
    expect(err('print("a" + 1)')).toContain("cannot add 'str' and 'int'");
  });

  it("division by zero → error", () => {
    expect(err("print(1 / 0)")).toContain("division by zero");
  });

  it("negative repetition → error", () => {
    expect(err('print("ab" * -1)')).toContain("repetition");
  });
});

describe("eval: string interpolation (L2)", () => {
  it("variables inside braces", () => {
    expect(out('var n = "Ada"\nprint("hello {n}")')).toEqual(["hello Ada"]);
  });

  it("numbers: int and float with the print rule", () => {
    expect(out('print("x: {42}, y: {3.5}")')).toEqual(["x: 42, y: 3.5"]);
  });

  it("booleans and null", () => {
    expect(out('print("b: {true}, n: {null}")')).toEqual(["b: true, n: null"]);
  });

  it("arithmetic inside braces", () => {
    expect(out('print("total: {2 + 3}")')).toEqual(["total: 5"]);
  });

  it("native calls inside braces", () => {
    expect(out('print("r: {len("hello")}")')).toEqual(["r: 5"]);
  });

  it("indexing lists and dicts inside", () => {
    expect(
      out('var l = [1, 2, 3]\nvar d = {"a": "x"}\nprint("l: {l[1]}, d: {d["a"]}")'),
    ).toEqual(["l: 2, d: x"]);
  });

  it("full list and dict literals inside", () => {
    expect(out('print("l: {[1, 2]}, r: {str({"a": 1})}")')).toEqual([
      'l: [1, 2], r: {"a": 1}',
    ]);
  });

  it("dict interpolated from a variable", () => {
    expect(out('var d = {"a": 1}\nprint("m: {d}")')).toEqual([
      'm: {"a": 1}',
    ]);
  });

  it("{{ escapes to a literal { (does not open interpolation)", () => {
    expect(out('var x = 5\nprint("a: {{x}")')).toEqual(["a: {x}"]);
  });

  it("}} escapes to a literal } (symmetric with {{)", () => {
    expect(out('print("a}}b")')).toEqual(["a}b"]);
  });

  it("stray } in the string is literal", () => {
    expect(out('var x = 1\nprint("a: {x} }")')).toEqual(["a: 1 }"]);
  });

  it("spec case: percentage: {{{pct}}} with pct = 50", () => {
    expect(out('var pct = 50\nprint("percentage: {{{pct}}}")')).toEqual([
      "percentage: {50}",
    ]);
  });

  it("symmetric escape around an interpolation", () => {
    expect(out('var pct = 50\nprint("value: {{{pct}}}")')).toEqual(["value: {50}"]);
  });

  it("interpolation inside larger expressions", () => {
    expect(out('var n = "Ada"\nprint("[" + "{n}" + "]")')).toEqual(["[Ada]"]);
  });

  it("nested interpolation (string inside string)", () => {
    expect(out('print("r: {str("x{1}")}")')).toEqual(["r: x1"]);
  });

  it("string without interpolation is untouched", () => {
    expect(out('print("100% sure")')).toEqual(["100% sure"]);
  });

  it("missing variable → error with message", () => {
    expect(err('print("x: {nope}")')).toContain("variable 'nope' is not defined");
  });
});

describe("eval: string stdlib (L3a)", () => {
  it("upper/lower/trim", () => {
    expect(
      out('print(upper("hello"))\nprint(lower("HELLO"))\nprint(trim("  x  "))'),
    ).toEqual(["HELLO", "hello", "x"]);
  });

  it("upper/lower/trim: type error", () => {
    expect(err("upper(1)")).toContain("'upper' expects a string");
    expect(err("lower(true)")).toContain("'lower' expects a string");
    expect(err("trim(3.5)")).toContain("'trim' expects a string");
  });

  it("split", () => {
    expect(out('print(split("a,b,c", ","))')).toEqual(["[a, b, c]"]);
    expect(out('print(len(split("a,b,c", ",")))')).toEqual(["3"]);
  });

  it("split: empty separator → error", () => {
    expect(err('split("a", "")')).toContain("non-empty separator");
  });

  it("split: type error", () => {
    expect(err('split(1, ",")')).toContain("'split' expects a string");
  });

  it("join", () => {
    expect(out('print(join(["a", "b", "c"], "-"))')).toEqual(["a-b-c"]);
    expect(out('print(join([], ","))')).toEqual([""]);
  });

  it("join: non-list and non-string element → error", () => {
    expect(err('join("x", ",")')).toContain("list of strings");
    expect(err("join([1], \",\")")).toContain("all elements to be strings");
  });

  it("replace", () => {
    expect(out('print(replace("a-b-c", "-", "+"))')).toEqual(["a+b+c"]);
  });

  it("replace: type error", () => {
    expect(err('replace(1, "a", "b")')).toContain("'replace' expects a string");
  });

  it("contains / starts_with / ends_with", () => {
    expect(
      out(
        'print(contains("hello", "el"))\nprint(contains("hello", "x"))\nprint(starts_with("hello", "he"))\nprint(starts_with("hello", "lo"))\nprint(ends_with("hello", "lo"))\nprint(ends_with("hello", "he"))',
      ),
    ).toEqual(["true", "false", "true", "false", "true", "false"]);
  });

  it("contains / starts_with / ends_with: type error", () => {
    expect(err('contains("hello", 1)')).toContain("'contains' expects a string");
    expect(err('starts_with(5, "ho")')).toContain("'starts_with' expects a string");
    expect(err('ends_with("hello", null)')).toContain("'ends_with' expects a string");
  });
});

describe("eval: stdlib math (L3a)", () => {
  it("abs preserves the type", () => {
    expect(
      out("print(abs(-5))\nprint(abs(-3.5))\nprint(type(abs(-5)))\nprint(type(abs(-3.5)))"),
    ).toEqual(["5", "3.5", "int", "float"]);
  });

  it("abs: type error", () => {
    expect(err('abs("x")')).toContain("'abs' expects a number");
  });

  it("min / max (float if either is)", () => {
    expect(
      out(
        'print(min(3, 7))\nprint(max(3, 7))\nprint(min(2.5, 2))\nprint(max(2.5, 2))\nprint(type(min(2.5, 2)))',
      ),
    ).toEqual(["3", "7", "2.0", "2.5", "float"]);
  });

  it("min / max: type error", () => {
    expect(err('min("a", 1)')).toContain("'min' expects a number");
    expect(err("max(1, true)")).toContain("'max' expects a number");
  });

  it("round / floor / ceil return int", () => {
    expect(
      out(
        "print(round(3.5))\nprint(round(2.4))\nprint(floor(3.7))\nprint(floor(-3.2))\nprint(ceil(3.2))\nprint(ceil(-3.7))",
      ),
    ).toEqual(["4", "2", "3", "-4", "4", "-3"]);
  });

  it("round / floor / ceil: type error", () => {
    expect(err('round("x")')).toContain("'round' expects a number");
    expect(err("floor(null)")).toContain("'floor' expects a number");
    expect(err("ceil(true)")).toContain("'ceil' expects a number");
  });

  it("sqrt returns float", () => {
    expect(out("print(sqrt(16))\nprint(type(sqrt(16)))")).toEqual(["4.0", "float"]);
  });

  it("sqrt of negative → error; non-numeric type → error", () => {
    expect(err("print(sqrt(-1))")).toContain("does not accept negative numbers");
    expect(err('sqrt("x")')).toContain("'sqrt' expects a number");
  });

  // --- fail (§17.1, added for the pressure test) ---------------------------------------
  //
  // QBSK could CATCH an error and never RAISE one. So a library written in QBSK had
  // exactly two answers to a bad argument — return null, or return something wrong — and
  // both are the ghost this project hunts first. The language's own doctrine, report
  // rather than no-op, was unavailable to programs written in it.

  it("fail raises an error the author wrote", () => {
    expect(err('fail("no anatomical region")')).toContain("no anatomical region");
  });

  it("points at the fail() call, so the message and the place agree", () => {
    const r = run('print("a")\nfail("bad thing")');
    expect(r.error).not.toBeNull();
    expect(r.error!.span.start.line).toBe(2);
    expect(r.out).toEqual(["a"]);
  });

  it("is catchable, like every other runtime error", () => {
    // The half that makes it useful: a library reports, and a caller that expected the
    // failure can handle it. Without this, `fail` would only be a louder `exit`.
    expect(
      out(
        [
          "try",
          '    fail("nope")',
          "catch e",
          '    print("caught " + e["message"])',
        ].join("\n"),
      ),
    ).toEqual(["caught nope"]);
  });

  it("insists on a string, so the message is a message", () => {
    expect(err("fail(42)")).toContain("'fail' expects a str");
    expect(err("fail()")).toContain("expects 1 argument");
  });

  it("does not stop at a truthiness check, because it is not an assert", () => {
    // Deliberately NOT `assert(cond, msg)`. A condition is what `if` is for, and an
    // assert that takes one invites `assert(x)` with no message at all — which reports
    // that something was false and not what the author meant.
    expect(out(['var n = 3', "if n > 2", '    print("over")'].join("\n"))).toEqual(["over"]);
  });

  // --- exp and log (§17.1, added for the pressure test) --------------------------------
  //
  // The GDD's two central modulation formulas are sigmoids — §5.1's stress-induced
  // analgesia and §9.2's utility curves — and neither could be written: QBSK had no
  // e^x, no natural log and no power operator. Found by G0's spike, which is what that
  // stage is for.

  it("exp answers e^x as a float", () => {
    expect(out("print(str(int(exp(0.0))))")).toEqual(["1"]);
    expect(out("print(type(exp(1.0)))")).toEqual(["float"]);
    // e^1, to the precision a simulation cares about.
    expect(out("print(str(int(exp(1.0) * 1000.0)))")).toEqual(["2718"]);
  });

  it("log is exp's inverse, so a sigmoid can be undone", () => {
    expect(out("print(str(int(log(exp(3.0)) * 1000.0)))")).toEqual(["3000"]);
    expect(out("print(str(int(log(1.0))))")).toEqual(["0"]);
  });

  it("writes the sigmoid the the design document asks for", () => {
    // The actual formula from the design document §5.1: 1 / (1 + e^(-k(x - threshold))). At x equal to
    // the threshold it must be exactly one half, whatever k is — the property that makes
    // it a threshold at all.
    const src = [
      "func sia(x, k, threshold)",
      "    return 1.0 / (1.0 + exp(0.0 - k * (x - threshold)))",
      "print(str(int(sia(50.0, 0.2, 50.0) * 1000.0)))",
      "print(str(sia(90.0, 0.2, 50.0) > 0.99))",
      "print(str(sia(10.0, 0.2, 50.0) < 0.01))",
    ].join("\n");
    expect(out(src)).toEqual(["500", "true", "true"]);
  });

  it("log of zero or a negative reports, as sqrt already does", () => {
    // -Infinity and NaN are exactly the silent wrong values §15 exists to remove: they
    // do not fail, they poison every number downstream of them.
    expect(err("print(log(0.0))")).toContain("positive");
    expect(err("print(log(-1.0))")).toContain("positive");
    expect(err('log("x")')).toContain("'log' expects a number");
  });

  it("exp reports rather than answering infinity", () => {
    expect(err("print(exp(1000.0))")).toContain("too large");
    expect(err('exp("x")')).toContain("'exp' expects a number");
  });

  it("random() is float in [0, 1)", () => {
    const r = run("var r = random()\nprint(type(r))");
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["float"]);
  });

  it("random() with arguments → error", () => {
    expect(err("random(1)")).toContain("expects 0 arguments");
  });
});

describe("eval: stdlib list (L3b)", () => {
  it("push mutates the list and returns it", () => {
    expect(out("var l = [1, 2]\npush(l, 3)\nprint(l)\nprint(push(l, 4))")).toEqual([
      "[1, 2, 3]",
      "[1, 2, 3, 4]",
    ]);
  });

  it("lists are by reference (push affects the alias)", () => {
    expect(out("var a = [1]\nvar b = a\npush(a, 2)\nprint(b)")).toEqual([
      "[1, 2]",
    ]);
  });

  it("push: type error", () => {
    expect(err('push("x", 1)')).toContain("'push' expects a list");
  });

  it("pop returns the last item and removes it", () => {
    expect(out("var l = [1, 2, 3]\nprint(pop(l))\nprint(l)")).toEqual([
      "3",
      "[1, 2]",
    ]);
  });

  it("pop: empty list → error", () => {
    expect(err("pop([])")).toContain("empty list");
  });

  it("pop: type error", () => {
    expect(err('pop("x")')).toContain("'pop' expects a list");
  });

  it("sort mutates ascending; numbers and strings", () => {
    expect(out("var l = [3, 1, 2]\nsort(l)\nprint(l)")).toEqual(["[1, 2, 3]"]);
    expect(out('var s = ["c", "a", "b"]\nsort(s)\nprint(s)')).toEqual([
      "[a, b, c]",
    ]);
  });

  it("sort: mixed list and non-list → error", () => {
    expect(err('sort([1, "a"])')).toContain("homogeneous");
    expect(err('sort("x")')).toContain("'sort' expects a list");
  });

  it("reverse reverses in place", () => {
    expect(out("var l = [1, 2, 3]\nreverse(l)\nprint(l)")).toEqual([
      "[3, 2, 1]",
    ]);
  });

  it("reverse: type error", () => {
    expect(err("reverse(1)")).toContain("'reverse' expects a list");
  });

  it("map applies a named QBSK function", () => {
    expect(
      out("func double(x)\n    return x * 2\nprint(map([1, 2, 3], double))"),
    ).toEqual(["[2, 4, 6]"]);
  });

  it("map with a native as callback", () => {
    expect(out('print(map(["a", "bb", "ccc"], len))')).toEqual(["[1, 2, 3]"]);
  });

  it("map: callback captures the closure", () => {
    expect(
      out("var factor = 10\nfunc total(n)\n    return n + factor\nprint(map([1, 2], total))"),
    ).toEqual(["[11, 12]"]);
  });

  it("map: non-function and non-list → error", () => {
    expect(err("map([1], 5)")).toContain("'map' expects a function");
    expect(err('map("x", len)')).toContain("'map' expects a list");
  });

  it("filter keeps the truthy values", () => {
    expect(
      out("func even(x)\n    return x % 2 == 0\nprint(filter([1, 2, 3, 4], even))"),
    ).toEqual(["[2, 4]"]);
  });

  it("filter: type error", () => {
    expect(err('filter([1], "x")')).toContain("'filter' expects a function");
  });

  it("reduce accumulates with init", () => {
    expect(
      out("func add(a, b)\n    return a + b\nprint(reduce([1, 2, 3], add, 0))"),
    ).toEqual(["6"]);
    expect(
      out("func add(a, b)\n    return a + b\nprint(reduce([], add, 10))"),
    ).toEqual(["10"]);
  });

  it("reduce: type error", () => {
    expect(err("reduce([1], 5, 0)")).toContain("'reduce' expects a function");
    expect(err('reduce("x", len, 0)')).toContain("'reduce' expects a list");
  });

  it("slice with and without to; clamped bounds", () => {
    expect(
      out("print(slice([1, 2, 3, 4], 1, 3))\nprint(slice([1, 2, 3], 1))\nprint(slice([1, 2], 5))"),
    ).toEqual(["[2, 3]", "[2, 3]", "[]"]);
  });

  it("slice returns a copy (does not mutate the original)", () => {
    expect(out("var l = [1, 2, 3]\nvar c = slice(l, 0)\nprint(c)\nprint(l)")).toEqual([
      "[1, 2, 3]",
      "[1, 2, 3]",
    ]);
  });

  it("slice: type error", () => {
    // A string used to report here. §15.19 widened `slice` to cut strings too, because
    // `[]` already indexed them and the asymmetry had no reason behind it — so what is
    // left to refuse is a subject that is neither, and an index that is not an int.
    expect(err("slice(7, 1)")).toContain("'slice' expects a list");
    expect(err("slice([1], 1.5)")).toContain("'slice' expects an int");
    expect(err('slice("abc", 1.5)')).toContain("'slice' expects an int");
  });
});

describe("eval: dict stdlib (L3b)", () => {
  it("keys / values in insertion order", () => {
    expect(out('var d = {"a": 1, "b": 2}\nprint(keys(d))\nprint(values(d))')).toEqual([
      "[a, b]",
      "[1, 2]",
    ]);
  });

  it("keys / values: empty dict", () => {
    expect(out("var d = {}\nprint(keys(d))\nprint(values(d))")).toEqual([
      "[]",
      "[]",
    ]);
  });

  it("has", () => {
    expect(out('var d = {"a": 1}\nprint(has(d, "a"))\nprint(has(d, "z"))')).toEqual([
      "true",
      "false",
    ]);
  });

  it("dict natives: type errors", () => {
    expect(err('keys("x")')).toContain("'keys' expects a dict");
    expect(err("values(1)")).toContain("'values' expects a dict");
    expect(err('has("x", "a")')).toContain("'has' expects a dict");
    expect(err("has({}, 5)")).toContain("'has' expects a string");
  });
});

describe("eval: try/catch error handling (L4)", () => {
  it("caught error does not abort; catch runs and the program continues", () => {
    expect(
      out('try:\n    var n = int("abc")\n    print("not reached")\ncatch e:\n    print("caught: " + e["message"])\nprint("after")'),
    ).toEqual(["caught: cannot convert 'abc' to int", "after"]);
  });

  it("e exposes message, line, col and file (original span)", () => {
    expect(
      out('try:\n    int("abc")\ncatch e:\n    print(e["message"])\n    print(e["line"])\n    print(e["col"])\n    print(e["file"])'),
    ).toEqual(["cannot convert 'abc' to int", "2", "5", "test.qbsk"]);
  });

  it("without error, the catch block does not run", () => {
    expect(out('try:\n    print("try ok")\ncatch e:\n    print("catch")\nprint("end")')).toEqual([
      "try ok",
      "end",
    ]);
  });

  it("uncaught errors remain fatal", () => {
    expect(err('print("a")\nvar x = int("abc")\nprint("b")')).toContain(
      "cannot convert 'abc' to int",
    );
  });

  it("catches native and arithmetic errors", () => {
    expect(out("try:\n    var x = 1 / 0\ncatch e:\n    print(e[\"message\"])\nprint(\"end\")")).toEqual([
      "division by zero",
      "end",
    ]);
    expect(
      out('try:\n    pop([])\ncatch e:\n    print(e["message"])'),
    ).toEqual(["'pop' cannot operate on an empty list"]);
  });

  it("exit() inside try is not caught", () => {
    const r = run("try:\n    exit(3)\ncatch e:\n    print(\"caught\")\nprint(\"end\")");
    expect(r.error).toBeNull();
    expect(r.exitCode).toBe(3);
    expect(r.out).toEqual([]);
  });

  it("return inside try propagates (is not caught)", () => {
    expect(
      out('func f()\n    try:\n        return 42\n    catch e:\n        print("catch")\nprint(f())'),
    ).toEqual(["42"]);
  });

  it("break inside try propagates to the loop", () => {
    expect(
      out('var i = 0\nwhile i < 5:\n    try:\n        i += 1\n        if i == 2: break\n    catch e:\n        print("catch")\n    print(i)\nprint("end")'),
    ).toEqual(["1", "end"]);
  });

  it("an error in the catch is not re-caught by the same try", () => {
    expect(
      err('try:\n    int("abc")\ncatch e:\n    var y = int("xyz")'),
    ).toContain("cannot convert 'xyz' to int");
  });

  it("nested try: the nearest one catches the error", () => {
    expect(
      out('try:\n    try:\n        int("abc")\n    catch e:\n        print("inner: " + e["message"])\ncatch e2:\n    print("outer")'),
    ).toEqual(["inner: cannot convert 'abc' to int"]);
  });

  it("the catch variable does not escape the block", () => {
    expect(
      err('try:\n    int("abc")\ncatch e:\n    print("x")\nprint(e)'),
    ).toContain("'e' is not defined");
  });
});

describe("eval: list and dict literals (L1.5)", () => {
  it("[1, 2, 3] and [] evaluate to list", () => {
    expect(out("print([1, 2, 3])\nprint([])\nprint(type([1]))\nprint(type([]))")).toEqual([
      "[1, 2, 3]",
      "[]",
      "list",
      "list",
    ]);
  });

  it("dict with string and identifier keys + empty {}", () => {
    expect(
      out('print({"key": 42})\nprint({name: "ada"})\nprint({})\nprint(type({"a": 1}))'),
    ).toEqual(['{"key": 42}', '{"name": ada}', "{}", "dict"]);
  });

  it("nesting: list of lists and dict with a list inside", () => {
    expect(
      out("print([[1, 2], [3, 4]])\nprint({\"a\": [10, 20], \"b\": {\"x\": true}})"),
    ).toEqual([
      "[[1, 2], [3, 4]]",
      '{"a": [10, 20], "b": {"x": true}}',
    ]);
  });

  it("list indexing: l[0], l[2]", () => {
    expect(out("var l = [10, 20, 30]\nprint(l[0])\nprint(l[2])")).toEqual([
      "10",
      "30",
    ]);
  });

  it("dict indexing: d[\"key\"]", () => {
    expect(
      out('var d = {"key": 42, "other": "x"}\nprint(d["key"])\nprint(d["other"])'),
    ).toEqual(["42", "x"]);
  });

  it("nested index: n[1][0] and dd[\"a\"][1]", () => {
    expect(
      out('var n = [[1, 2], [3, 4]]\nvar dd = {"a": [10, 20]}\nprint(n[1][0])\nprint(dd["a"][1])'),
    ).toEqual(["3", "20"]);
  });

  it("index with expression: l[len(l) - 1]", () => {
    expect(out("var l = [1, 2, 3]\nprint(l[len(l) - 1])")).toEqual(["3"]);
  });

  it("list index out of range → runtime error with span", () => {
    const r = run("var l = [10, 20]\nprint(l[5])");
    expect(r.error?.message).toContain("index 5 out of range");
    expect(r.error?.message).toContain("list of 2 elements");
    expect(r.error?.span.start.line).toBe(2);
  });

  it("negative index → runtime error", () => {
    expect(err("var l = [10]\nprint(l[-1])")).toContain("out of range");
  });

  it("missing dict key → runtime error with span", () => {
    const r = run('var d = {"a": 1}\nprint(d["zz"])');
    expect(r.error?.message).toContain("key 'zz' does not exist in the dict");
    expect(r.error?.span.start.line).toBe(2);
  });

  it("non-int list index → error", () => {
    expect(err('var l = [10]\nprint(l["0"])')).toContain(
      "a list index must be an int",
    );
  });

  // This used to assert that indexing a string was an ERROR, pinning a limitation as
  // though it were a rule — the same shape as the test that said `(1)` could not be a
  // group. `len()` already worked on a string, so not being able to index one was an
  // asymmetry; both now agree (docs/language.md §7.2c).
  it("indexing a str gives the character at that position", () => {
    const r = run('var s = "hello"\nprint(s[0])\nprint(s[3])');
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["h", "l"]);
  });

  it("indexing a str past the end is still an error", () => {
    expect(err('var s = "hello"\nprint(s[9])')).toContain("out of range");
  });

  it("a bool is still not indexable", () => {
    expect(err("var b = true\nprint(b[0])")).toContain(
      "is not indexable with '[]'",
    );
  });

  it("lists and dicts compare by value with ==", () => {
    expect(out("print([1, 2] == [1, 2])\nprint([1] == [2])\nprint({\"a\": 1} == {\"a\": 1})")).toEqual([
      "true",
      "false",
      "true",
    ]);
  });
});

// This used to assert that `l[0] = 9` was an ERROR ("read-only in L1.5"), pinning a
// limitation as though it were a rule — the same shape as the string-indexing test
// above. An earlier release closed the gap docs/language.md §5.1 always called "for now": index
// assignment fills the specific hole natives (push/pop/keys) never covered — replacing
// one list element, or adding/overwriting one dict key, without rebuilding the value.
describe("eval: index assignment", () => {
  it("list[i] = v replaces one element in place", () => {
    expect(out("var l = [1, 2, 3]\nl[1] = 99\nprint(l)")).toEqual(["[1, 99, 3]"]);
  });

  it("list[i] += v / -= v read-modify-write the element", () => {
    expect(
      out("var l = [10, 20]\nl[0] += 5\nl[1] -= 5\nprint(l)"),
    ).toEqual(["[15, 15]"]);
  });

  it("dict[\"k\"] = v overwrites an existing key", () => {
    expect(
      out('var d = {"a": 1}\nd["a"] = 5\nprint(d)'),
    ).toEqual(['{"a": 5}']);
  });

  it("dict[\"k\"] = v inserts a NEW key — the one thing natives couldn't do", () => {
    expect(
      out('var d = {"a": 1}\nd["b"] = 2\nprint(d["a"])\nprint(d["b"])'),
    ).toEqual(["1", "2"]);
  });

  it("dict[\"k\"] += v works when the key already exists", () => {
    expect(out('var d = {"a": 1}\nd["a"] += 4\nprint(d["a"])')).toEqual(["5"]);
  });

  it("dict[\"k\"] += v on a MISSING key is still an error — nothing to combine with", () => {
    const r = run('var d = {"a": 1}\nd["zz"] += 1');
    expect(r.error?.message).toContain("key 'zz' does not exist in the dict");
  });

  it("list[i] = v out of range → the same error a read would give, with a span", () => {
    const r = run("var l = [10, 20]\nl[5] = 1");
    expect(r.error?.message).toContain("index 5 out of range");
    expect(r.error?.message).toContain("list of 2 elements");
    expect(r.error?.span.start.line).toBe(2);
  });

  it("list assignment never auto-extends — push is still how a list grows", () => {
    expect(err("var l = [1]\nl[1] = 2")).toContain("out of range");
  });

  it("list[i] = v with a non-int index → type error", () => {
    expect(err('var l = [1]\nl["0"] = 2')).toContain(
      "a list index must be an int",
    );
  });

  it("dict[\"k\"] = v with a non-str key → type error", () => {
    expect(err("var d = {}\nd[0] = 1")).toContain(
      "a dict key must be a string",
    );
  });

  it("index-assigning into a non-list/dict value → type error, not a raw crash", () => {
    expect(err("var n = 5\nn[0] = 1")).toContain(
      "cannot index-assign into type 'int'",
    );
  });

  it("nested index assignment: n[1][0] = v reaches the inner list", () => {
    expect(
      out("var n = [[1, 2], [3, 4]]\nn[1][0] = 99\nprint(n)"),
    ).toEqual(["[[1, 2], [99, 4]]"]);
  });
});

describe("eval: booleans and comparison", () => {
  it("and/or short-circuit (does not evaluate the untaken side)", () => {
    expect(out("print(1 or doesnotexist)\nprint(false and doesnotexist)")).toEqual([
      "1",
      "false",
    ]);
  });

  it("and/or return operands", () => {
    expect(out("print(0 or 5)\nprint(3 and 4)")).toEqual(["5", "4"]);
  });

  it("not and ! over falsy/truthy", () => {
    expect(
      out("print(not 0)\nprint(not \"x\")\nprint(!true)"),
    ).toEqual(["true", "false", "false"]);
  });

  it("1.0 == 1 compares numeric values", () => {
    expect(out("print(1.0 == 1)\nprint(1.0 != 2)")).toEqual(["true", "true"]);
  });

  it("string comparison", () => {
    expect(out('print("a" < "b")\nprint("b" <= "a")')).toEqual([
      "true",
      "false",
    ]);
  });

  it("incompatible type comparison → error", () => {
    expect(err('print(1 < "a")')).toContain("cannot compare 'int' with 'str'");
  });

  it("range '..' outside for → error", () => {
    expect(err("var r = 0..10")).toContain("only valid as a 'for' iterable");
  });
});

describe("eval: variables and scopes", () => {
  it("var and const basics", () => {
    expect(out("var a = 1\nconst B = 2\nprint(a + B)")).toEqual(["3"]);
  });

  it("redefining in the same scope → error", () => {
    expect(err("var x = 1\nvar x = 2")).toContain(
      "variable 'x' is already defined",
    );
  });

  it("reassigning a constant → error", () => {
    expect(err("const PI = 3.14\nPI = 3")).toContain(
      "cannot reassign to constant 'PI'",
    );
  });

  it("assigning to an undefined variable → error", () => {
    expect(err("doesnotexist = 1")).toContain("variable 'doesnotexist' is not defined");
  });

  it("reading an undefined variable → error", () => {
    expect(err("print(doesnotexist)")).toContain("variable 'doesnotexist' is not defined");
  });

  it("shadowing in an inner block", () => {
    expect(out("var x = 1\nif true\n    var x = 2\n    print(x)\nprint(x)")).toEqual([
      "2",
      "1",
    ]);
  });

  it("a var declared in a block does not escape", () => {
    expect(err("if true\n    var hidden = 1\nprint(hidden)")).toContain(
      "variable 'hidden' is not defined",
    );
  });

  it("a native cannot be reassigned (print = 1)", () => {
    expect(err("print = 1")).toContain("cannot reassign to 'print'");
  });
});

describe("eval: control flow", () => {
  it("if / elif / else", () => {
    const src = [
      "var x = 2",
      "if x == 1",
      "    print(\"one\")",
      "elif x == 2",
      "    print(\"two\")",
      "else",
      "    print(\"other\")",
    ].join("\n");
    expect(out(src)).toEqual(["two"]);
  });

  it("inline if with colon", () => {
    expect(out("var y = 0\nif true: y = 1\nprint(y)")).toEqual(["1"]);
  });

  it("match with arms and else", () => {
    const src = [
      "var x = 2",
      "match x",
      "    1:",
      "        print(\"one\")",
      "    2:",
      "        print(\"two\")",
      "    else:",
      "        print(\"other\")",
    ].join("\n");
    expect(out(src)).toEqual(["two"]);
  });

  it("match with strings and no matching arm → no-op", () => {
    expect(out('match "z"\n    "a":\n        print("a")')).toEqual([]);
  });

  it("while + break", () => {
    const src = [
      "var i = 0",
      "while true",
      "    i += 1",
      "    if i > 3: break",
      "print(i)",
    ].join("\n");
    expect(out(src)).toEqual(["4"]);
  });

  it("continue skips the rest of the iteration", () => {
    const src = [
      "var i = 0",
      "var total = 0",
      "while i < 5",
      "    i += 1",
      "    if i == 3: continue",
      "    total += i",
      "print(total)",
    ].join("\n");
    expect(out(src)).toEqual(["12"]);
  });

  it("exclusive for range: sum 0..10 = 45", () => {
    expect(out("var s = 0\nfor i in 0..10\n    s += i\nprint(s)")).toEqual(["45"]);
  });

  it("for range with compound bound 0..n-1 (exclusive)", () => {
    const src = [
      "var n = 5",
      "var s = 0",
      "for i in 0..n-1",
      "    s += i",
      "print(s)",
    ].join("\n");
    expect(out(src)).toEqual(["6"]);
  });

  it("descending for range (from > to) → empty", () => {
    expect(out("var s = 0\nfor i in 10..5\n    s += i\nprint(s)")).toEqual(["0"]);
  });

  it("for in with a non-list → error", () => {
    expect(err("for i in 5\n    print(i)")).toContain(
      "'for in' expects a list",
    );
  });

  it("break outside a loop → error", () => {
    expect(err("break")).toContain("'break' outside a loop");
  });

  it("return outside a function → error", () => {
    expect(err("return")).toContain("'return' outside a function");
  });
});

describe("eval: functions and closures", () => {
  it("function with return", () => {
    expect(out("func total(a, b)\n    return a + b\nprint(total(2, 3))")).toEqual([
      "5",
    ]);
  });

  it("arity mismatch → error", () => {
    expect(err("func f(a, b)\n    return a + b\nprint(f(1))")).toContain(
      "function 'f' expects 2 arguments, got 1",
    );
  });

  it("recursion: factorial(5) = 120", () => {
    const src = [
      "func factorial(n)",
      "    if n <= 1",
      "        return 1",
      "    return n * factorial(n - 1)",
      "print(factorial(5))",
    ].join("\n");
    expect(out(src)).toEqual(["120"]);
  });

  it("closure captures and mutates the definition environment", () => {
    const src = [
      "func make_counter()",
      "    var n = 0",
      "    func increment()",
      "        n += 1",
      "        return n",
      "    return increment",
      "var c = make_counter()",
      "print(c())",
      "print(c())",
      "print(c())",
    ].join("\n");
    expect(out(src)).toEqual(["1", "2", "3"]);
  });

  it("return without value → null", () => {
    expect(out("func f()\n    return\nprint(type(f()))")).toEqual(["null"]);
  });

  it("calling a non-function → error", () => {
    expect(err("var x = 5\nx(1)")).toContain("'x' is not a function");
  });

  it("named arguments on a user function → error", () => {
    expect(err("func f(a)\n    return a\nprint(f(1, b: 2))")).toContain(
      "named arguments",
    );
  });

  it("named arguments on a native → the same honest error", () => {
    // The old message promised named args for engine natives ("an earlier release") when no
    // callee accepts them. It must say the truth: DSL-only, not engine natives.
    expect(err('animate("x", from: 0, to: 10)')).toContain(
      "only the scene DSL accepts them",
    );
  });
});

// An earlier release: found writing examples/lib/action_rules.qbsk's own tests — list/dict
// literals tolerated multi-line layout with a trailing comma (L1.5), a call's argument
// list silently didn't. `skipNewlineIndents()` (already used by ListLit/DictLit parsing)
// now runs the same way inside a call's `( )`.
describe("eval: multi-line call arguments", () => {
  it("a call's arguments can span multiple lines with a trailing comma", () => {
    const src = [
      "func add(a, b)",
      "    return a + b",
      "var r = add(",
      "    1,",
      "    2,",
      ")",
      "print(r)",
    ].join("\n");
    expect(out(src)).toEqual(["3"]);
  });

  it("a multi-line call with no trailing comma on the last argument also works", () => {
    const src = [
      "func add(a, b, c)",
      "    return a + b + c",
      "var r = add(",
      "    1,",
      "    2,",
      "    3",
      ")",
      "print(r)",
    ].join("\n");
    expect(out(src)).toEqual(["6"]);
  });

  it("a multi-line empty call, ()  with only whitespace, still works", () => {
    const src = ["func f()", "    return 42", "print(f(", "))"].join("\n");
    expect(out(src)).toEqual(["42"]);
  });
});

describe("eval: vector tuples", () => {
  it("tuple addition (1,2)+(3,4) = (4,6)", () => {
    expect(out("var p = (1, 2) + (3, 4)\nprint(p)")).toEqual(["(4, 6)"]);
  });

  it("scalar multiplication (2,3)*2 = (4,6)", () => {
    expect(out("var q = (2, 3) * 2\nprint(q)")).toEqual(["(4, 6)"]);
  });

  it("tuples: no members (immutable)", () => {
    expect(err("var p = (1, 2)\np.x = 1")).toContain("immutable");
  });

  it("members on other types → informative error", () => {
    expect(err("var n = 5\nprint(n.x)")).toContain("type 'int' has no members");
  });
});

describe("eval: natives", () => {
  it("len, type, str, int, float, bool", () => {
    const src = [
      'print(len("hello"))',
      "print(type(true))",
      "print(str(42))",
      "print(int(\"42\") + 1)",
      "print(float(2))",
      "print(bool(0))",
      "print(bool(\"x\"))",
    ].join("\n");
    expect(out(src)).toEqual(["5", "bool", "42", "43", "2.0", "false", "true"]);
  });

  it("int(\"abc\") → error", () => {
    expect(err('print(int("abc"))')).toContain("cannot convert");
  });

  it("len on int → error", () => {
    expect(err("print(len(5))")).toContain("len() does not support the type 'int'");
  });

  it("len(dict) → number of entries", () => {
    expect(out('print(len({"a": 1, "b": 2, "c": 3}))')).toEqual(["3"]);
  });

  it("len(empty dict) → 0", () => {
    expect(out("print(len({}))")).toEqual(["0"]);
  });

  it("len(dict) in an expression", () => {
    expect(out('print("n: {len({"a": 1, "b": 2})}")')).toEqual(["n: 2"]);
  });

  it("len(dict) with a nested value counts entries, not values", () => {
    expect(out('print(len({"a": [1, 2, 3]}))')).toEqual(["1"]);
  });

  it("len on bool → error", () => {
    expect(err("print(len(true))")).toContain("len() does not support the type 'bool'");
  });

  it("clock() returns float >= 0", () => {
    expect(out("print(clock() >= 0)")).toEqual(["true"]);
  });

  it("exit stops execution with a code", () => {
    const r = run("exit(3)\nprint(\"never\")");
    expect(r.exitCode).toBe(3);
    expect(r.out).toEqual([]);
  });

  it("exit() without argument → code 0", () => {
    const r = run("exit()\nprint(\"never\")");
    expect(r.exitCode).toBe(0);
  });
});

describe("eval: canvas natives", () => {
  it("canvas(qb) + box + put + line + print → golden byte by byte", () => {
    const source = readFileSync(
      new URL("../../examples/canvas.qbsk", import.meta.url),
      "utf8",
    );
    const golden = readFileSync(
      new URL("../golden/canvas.qbsk.out", import.meta.url),
      "utf8",
    );
    const r = run(source);
    expect(r.error).toBeNull();
    expect(r.out.join("\n")).toBe(golden.replace(/\r\n/g, "\n"));
  });

  it("canvas(0, 5) → error", () => {
    expect(err("canvas(0, 5)")).toContain(">= 1");
  });

  it("box on a non-canvas → error", () => {
    expect(err("box(5, (0, 0), (1, 1), \"+\")")).toContain(
      "expects a canvas",
    );
  });

  it("float coordinate in box → error (strict int/float)", () => {
    expect(err("var c = canvas(5, 5)\nbox(c, (0.0, 0), (4, 4), \"+\")")).toContain(
      "integers",
    );
  });

  it("fill with more than one character → error", () => {
    expect(err("var c = canvas(2, 2)\nfill(c, \"ab\")")).toContain(
      "single character",
    );
  });

  it("put with multi-line text → error", () => {
    expect(err("var c = canvas(4, 4)\nput(c, \"a\\nb\", (0, 0))")).toContain(
      "single-line text",
    );
  });
});

describe("eval: runtime errors with span", () => {
  it("the error carries formatted line, column and snippet", () => {
    const src = "var a = 1\nvar b = \"x\"\nprint(a + b)";
    const r = run(src);
    const errObj = r.error;
    expect(errObj).not.toBeNull();
    expect(errObj?.span.start.line).toBe(3);
    expect(errObj?.span.file).toBe("test.qbsk");
  });
});

describe("eval: declarative scene DSL", () => {
  const golden = (name: string): string =>
    readFileSync(new URL(`../../tests/golden/${name}.out`, import.meta.url), "utf8");
  const example = (name: string): string =>
    readFileSync(new URL(`../../examples/${name}`, import.meta.url), "utf8");

  it("sprinkle is gone from the language, and its name is free again (§14.5)", () => {
    // This used to assert the loud "reserved for M18" error. The error was the
    // honest part; the dishonest part was occupying a globally reserved name (§2.6)
    // for a feature whose replacement had already shipped in L4.
    const r = run('var sprinkle = 3\nprint(str(sprinkle))');
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["3"]);
  });

  it("hello.qbsk composes byte by byte (golden)", () => {
    const r = run(example("hello.qbsk"));
    expect(r.error).toBeNull();
    const text = r.out.join("\n");
    expect(text).toBe(golden("hello.qbsk"));
    const rows = r.out;
    expect(rows).toHaveLength(24);
    expect(rows[0]!.startsWith("╔")).toBe(true);
    expect(rows[0]!.endsWith("╗")).toBe(true);
    expect(rows[23]!.startsWith("╚")).toBe(true);
    expect(rows[10]!.slice(36, 40)).toBe("QBSK");
    expect(rows[5]!.slice(11, 12)).toBe("O");
    expect(rows[6]!.slice(10, 13)).toBe("/|\\");
  });

  it("layers.qbsk composes byte by byte (golden)", () => {
    const r = run(example("layers.qbsk"));
    expect(r.error).toBeNull();
    const text = r.out.join("\n");
    expect(text).toBe(golden("layers.qbsk"));
    expect(r.out).toHaveLength(10);
    expect(r.out[0]).toBe("+-----------------+...........");
    expect(r.out[5]).toBe("|ABxyzFGHIJKLMNO..|...........");
    expect(r.out[9]).toBe("+-----------------+...........");
  });

  // tiles.qbsk is tileset-READY (docs/engine.md §15): its golden is the pure
  // character grid, because the character path never sees a tile. This golden pins
  // that a tileset changes nothing in the terminal/character pipeline.
  it("tiles.qbsk composes byte by byte (golden)", () => {
    const r = run(example("tiles.qbsk"));
    expect(r.error).toBeNull();
    expect(r.out.join("\n")).toBe(golden("tiles.qbsk"));
    expect(r.out).toHaveLength(10);
    expect(r.out[0]).toBe("########################");
    expect(r.out[5]).toBe("#..@...................#");
    expect(r.out[9]).toBe("########################");
  });

  // An earlier release: the sprites behind the "c" (free-form blob), "s" (masked sword), "o"
  // (masked orc) and "e" (masked demon) glyphs are procedurally generated
  // (bench/sprite-gen.mjs + examples/lib/pixelart.qbsk), not hand-drawn — but exactly
  // like tiles.qbsk above, the character-grid golden is unaffected by tiles at all
  // (docs/engine.md §15.1), so this test proves the SCENE composes correctly without
  // needing to render or compare any image.
  it("pixelart_test.qbsk composes byte by byte (golden)", () => {
    const r = run(example("pixelart_test.qbsk"));
    expect(r.error).toBeNull();
    expect(r.out.join("\n")).toBe(golden("pixelart_test.qbsk"));
    expect(r.out).toHaveLength(8);
    expect(r.out[4]!.charAt(10)).toBe("c");
    expect(r.out[4]!.charAt(24)).toBe("s");
    expect(r.out[4]!.charAt(38)).toBe("o");
    expect(r.out[4]!.charAt(52)).toBe("e");
  });

  it("sprite.qbsk: .qba sprites with anchor and scale (golden)", () => {
    const r = runQbsk(example("sprite.qbsk"), "examples/sprite.qbsk");
    expect(r.error).toBeNull();
    expect(r.out.join("\n")).toBe(golden("sprite.qbsk"));
    const rows = r.out;
    expect(rows).toHaveLength(8);
    expect(rows[0]!.slice(11, 14)).toBe(" O ");
    expect(rows[1]!.slice(4, 7)).toBe(" O ");
    expect(rows[1]!.slice(11, 14)).toBe("/|\\");
    expect(rows[1]!.slice(14, 20)).toBe("  OO  ");
    expect(rows[2]!.slice(14, 20)).toBe("//||\\\\");
    expect(rows[3]!.slice(4, 7)).toBe("/ \\");
  });

  it("color.qbsk: layer styles ignored in plain text (golden)", () => {
    const r = run(example("color.qbsk"));
    expect(r.error).toBeNull();
    expect(r.out.join("\n")).toBe(golden("color.qbsk"));
    expect(r.canvas).not.toBeNull();
  });

  it("unknown color name is a runtime error with span", () => {
    const r = run(
      'scene S(width: 4, height: 4)\nlayer l z: 1\n    color fg: orange\n    text "x" at (0, 0)',
    );
    expect(r.error?.message).toContain("unknown color 'orange'");
    expect(r.error?.span.start.line).toBe(3);
  });

  it("layer style propagates to the following primitives", () => {
    const r = run(
      'scene S(width: 4, height: 4)\nlayer l z: 1\n    color fg: cyan\n    fill "."',
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("....");
  });

  it("layer without a previous scene is a runtime error with span", () => {
    const r = run("layer l z: 1\n    text \"x\" at (0, 0)");
    expect(r.error?.message).toContain("must be declared after a scene");
    expect(r.error?.span.start.line).toBe(1);
  });

  it("scene without int width or height is a runtime error", () => {
    const r = run('scene S(width: "x", height: 2)');
    expect(r.error?.message).toContain("width and height as int");
  });

  it("layer with non-int z is a runtime error", () => {
    const r = run('scene S(width: 4, height: 4)\nlayer l z: "a"\n    text "x" at (0, 0)');
    expect(r.error?.message).toContain("z of a layer must be int");
  });

  it("printing a scene gives its name (DSL value, side-effect free)", () => {
    const r = run('scene S(width: 2, height: 2)\nlayer l z: 1\n    fill "."\nprint(S)');
    expect(r.out[0]).toBe("<scene S>");
  });

  it("fizzbuzz.qbsk golden", () => {
    const source = readFileSync(
      new URL("../../examples/fizzbuzz.qbsk", import.meta.url),
      "utf8",
    );
    const lines = out(source);
    expect(lines).toHaveLength(100);
    expect(lines[0]).toBe("1");
    expect(lines[2]).toBe("Fizz");
    expect(lines[4]).toBe("Buzz");
    expect(lines[14]).toBe("FizzBuzz");
    expect(lines[99]).toBe("Buzz");
  });

  it("interpolation.qbsk golden", () => {
    const source = readFileSync(
      new URL("../../examples/interpolation.qbsk", import.meta.url),
      "utf8",
    );
    expect(out(source)).toEqual([
      "hello Ada, you are 36 years old",
      "sum: 27",
      "count: 3",
      "first: 8",
      "city: CABA",
      'full dict: {"city": CABA}',
      "escaped braces: {name}",
    ]);
  });

  it("stdlib.qbsk golden", () => {
    const source = readFileSync(
      new URL("../../examples/stdlib.qbsk", import.meta.url),
      "utf8",
    );
    expect(out(source)).toEqual([
      "  QBSK  ",
      "qbsk",
      "qbsk!",
      "[hello, world, qbsk]",
      "hello | world | qbsk",
      "hello, world, engine",
      "true",
      "true",
      "true",
      "42",
      "3",
      "2.5",
      "4",
      "9",
      "10",
      "4.0",
    ]);
  });

  it("errors.qbsk golden", () => {
    const source = readFileSync(
      new URL("../../examples/errors.qbsk", import.meta.url),
      "utf8",
    );
    expect(out(source)).toEqual([
      "10 / 2 = 5.0",
      "could not divide: division by zero",
      "10 / 0 = 0",
      "error on line 15: cannot convert 'not a number' to int",
      "the program continues after the caught error",
    ]);
  });
});

describe("eval: game clock gameTime()", () => {
  it("gameTime() outside the loop is 0.0", () => {
    const r = run("print(gameTime())");
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("0.0");
  });

  it("gameTime() with an injected runtime returns the game time", () => {
    const r = runQbsk("print(gameTime())", "test.qbsk", undefined, {
      runtime: { gameTime: 2.5 },
    });
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("2.5");
  });

  it("gameTime() is float (game clock, not int)", () => {
    const r = runQbsk("print(type(gameTime()))", "test.qbsk", undefined, {
      runtime: { gameTime: 1.25 },
    });
    expect(r.out[0]).toBe("float");
  });

  it("a sprite position can derive from gameTime()", () => {
    const r = runQbsk(
      'scene S(width: 30, height: 8)\nlayer l z: 1\n    sprite "res/ball.qba" at (int(gameTime() * 10) % 26 + 1, 4)',
      "examples/bounce.qbsk",
      undefined,
      { baseDir: "examples", runtime: { gameTime: 0.5 } },
    );
    expect(r.error).toBeNull();
    // int(0.5*10) % 26 + 1 = 6 → sprite corner at (6, 4); the art is " o ",
    // so the ball occupies row 4 in columns 6-8.
    expect(r.out[4]![7]).toBe("o");
    expect(r.out[4]![6]).toBe(" ");
  });
});

describe("eval: per-primitive z and visible (M15)", () => {
  it("z: by state orders primitives of the same layer", () => {
    const r = runQbsk(
      "scene S(width: 5, height: 1)\nlayer l z: 1\n    z: 5\n    put \"AAA\" at (0, 0)\n    z: 1\n    put \"bbb\" at (0, 0)",
      "test.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("AAA  ");
  });

  it("z: defaults to 0", () => {
    const r = runQbsk(
      "scene S(width: 5, height: 1)\nlayer l z: 1\n    put \"AAA\" at (0, 0)\n    z: 2\n    put \"bbb\" at (0, 0)",
      "test.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("bbb  ");
  });

  it("visible: false hides the following primitives", () => {
    const r = runQbsk(
      "scene S(width: 5, height: 1)\nlayer l z: 1\n    visible: false\n    put \"AAA\" at (0, 0)\n    visible: true\n    put \"bbb\" at (0, 0)",
      "test.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("bbb  ");
  });

  it("z: accepts gameTime expressions (dynamic z)", () => {
    const src =
      "scene S(width: 5, height: 1)\nlayer l z: 1\n    z: int(gameTime() * 10) % 2\n    put \"AAA\" at (0, 0)\n    z: 0\n    put \"bbb\" at (0, 0)";
    // gameTime=0.1 → int(1)%2 = 1 → "AAA" (z 1) wins over "bbb" (z 0)
    const low = runQbsk(src, "test.qbsk", undefined, { runtime: { gameTime: 0.1 } });
    expect(low.error).toBeNull();
    expect(low.out[0]).toBe("AAA  ");
    // gameTime=0.2 → int(2)%2 = 0 → "AAA" (z 0) loses to "bbb" (z 0,
    // declared later) — the reorder changes with the game clock
    const high = runQbsk(src, "test.qbsk", undefined, { runtime: { gameTime: 0.2 } });
    expect(high.error).toBeNull();
    expect(high.out[0]).toBe("bbb  ");
  });

  it("z: must be int (error with span)", () => {
    const r = runQbsk(
      "scene S(width: 5, height: 1)\nlayer l z: 1\n    z: 1.5\n    put \"AAA\" at (0, 0)",
      "test.qbsk",
    );
    expect(r.error).not.toBeNull();
  });

  it("visible: must be bool (error with span)", () => {
    const r = runQbsk(
      "scene S(width: 5, height: 1)\nlayer l z: 1\n    visible: 7\n    put \"AAA\" at (0, 0)",
      "test.qbsk",
    );
    expect(r.error).not.toBeNull();
  });
});

describe("eval: world ↔ local coordinates (M16)", () => {
  it("layer at (x, y) offsets its local primitives", () => {
    const r = runQbsk(
      "scene S(width: 6, height: 5)\nlayer hud z: 1 at (0, 4)\n    put \"pts\" at (1, 0)",
      "test.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[4]).toBe(" pts  ");
    expect(r.out[0]).toBe("      ");
  });

  it("put with world: (x, y) ignores the layer offset", () => {
    const r = runQbsk(
      "scene S(width: 6, height: 5)\nlayer hud z: 1 at (0, 4)\n    put \"pts\" world: (1, 0)\n    put \"loc\" at (1, 0)",
      "test.qbsk",
    );
    expect(r.error).toBeNull();
    // world: (1,0) → row 0; local at (1,0) → row 0 + offset 4 = row 4
    expect(r.out[0]).toBe(" pts  ");
    expect(r.out[4]).toBe(" loc  ");
  });

  it("sprite with world: (x, y) composes at absolute coordinates", () => {
    const r = runQbsk(
      "scene S(width: 30, height: 8)\nlayer l z: 1 at (0, 4)\n    sprite \"res/ball.qba\" world: (6, 0)",
      "examples/bounce.qbsk",
      undefined,
      { baseDir: "examples" },
    );
    expect(r.error).toBeNull();
    // the sprite " o " occupies (6,0)-(8,2), not (6,4)
    expect(r.out[0]![7]).toBe("o");
    expect(r.out[4]![7]).toBe(" ");
  });

  it("layer at must be a tuple (int, int)", () => {
    const r = runQbsk(
      "scene S(width: 5, height: 2)\nlayer l z: 1 at (0.5, 0)\n    put \"x\" at (0, 0)",
      "test.qbsk",
    );
    expect(r.error).not.toBeNull();
  });

  it("world: must be a tuple (int, int)", () => {
    const r = runQbsk(
      "scene S(width: 5, height: 2)\nlayer l z: 1\n    put \"x\" world: (0.5, 0)",
      "test.qbsk",
    );
    expect(r.error).not.toBeNull();
  });

  it("put converts a numeric value to text (like print)", () => {
    const r = runQbsk(
      "scene S(width: 6, height: 1)\nlayer l z: 1\n    put 42 at (0, 0)\n    put 2.5 at (3, 0)",
      "test.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("42 2.5");
  });
});

  describe("eval: modules use", () => {
  const tempDirs: string[] = [];

  function makeModulePair(lib: string, main: string): string {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-test-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "lib.qbsksk"), lib);
    writeFileSync(join(dir, "main.qbsk"), main);
    return join(dir, "main.qbsk");
  }

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("use binds the module by its file stem", () => {
    const mainPath = makeModulePair(
      "export const greeting = \"hello from lib\"\nexport func double(n)\n    return n * 2",
      "use \"lib.qbsksk\"\nprint(lib.greeting)\nprint(lib.double(21))",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["hello from lib", "42"]);
  });

  it("use ... as binds the module under the alias", () => {
    const mainPath = makeModulePair(
      "export const greeting = \"hi\"",
      "use \"lib.qbsksk\" as m\nprint(m.greeting)",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["hi"]);
  });

  it("private members are not accessible", () => {
    const mainPath = makeModulePair(
      "export const greeting = \"hi\"\nconst secret = \"hidden\"",
      "use \"lib.qbsksk\"\nprint(lib.secret)",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.out).toEqual([]);
    expect(r.error?.message).toContain(
      "module 'lib' has no exported member 'secret'",
    );
  });

  it("non-exported bindings do not leak into the importer", () => {
    const mainPath = makeModulePair(
      "var greeting = \"leak\"",
      "use \"lib.qbsksk\"\nprint(greeting)",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.out).toEqual([]);
    expect(r.error?.message).toContain("variable 'greeting' is not defined");
  });

  it("re-use is idempotent: module init runs once", () => {
    const mainPath = makeModulePair(
      "print(\"init\")",
      "use \"lib.qbsksk\"\nuse \"lib.qbsksk\"\nprint(\"done\")",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["init", "done"]);
  });

  it("two aliases to the same module share one init", () => {
    const mainPath = makeModulePair(
      "print(\"init\")",
      "use \"lib.qbsksk\" as a\nuse \"lib.qbsksk\" as b",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["init"]);
  });

  it("module cycle → error", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-test-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "a.qbsk"), "use \"b.qbsk\"");
    writeFileSync(join(dir, "b.qbsk"), "use \"a.qbsk\"");
    const r = runQbsk(readFileSync(join(dir, "a.qbsk"), "utf8"), join(dir, "a.qbsk"));
    expect(r.error?.message).toContain("module cycle");
  });

  it("missing module → error", () => {
    const mainPath = makeModulePair("export const x = 1", "use \"nope.qbsk\"");
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error?.message).toContain("cannot load module 'nope.qbsk'");
  });

  it("module with syntax error → error", () => {
    const mainPath = makeModulePair("var x = = 1", "use \"lib.qbsksk\"");
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error?.message).toContain("syntax error in module 'lib.qbsksk'");
  });

  it("module runtime errors point at the module file", () => {
    const mainPath = makeModulePair(
      "print(1 + \"x\")",
      "use \"lib.qbsksk\"\nprint(\"never\")",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.out).toEqual([]);
    expect(r.error).not.toBeNull();
    expect(r.error?.span.file).toContain("lib.qbsksk");
  });

  it("nested use resolves relative to the including module", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-test-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.qbsk"), "export const secret = \"nested ok\"");
    writeFileSync(
      join(dir, "sub", "a.qbsk"),
      "use \"b.qbsk\"\nexport const value = b.secret",
    );
    const mainPath = join(dir, "main.qbsk");
    writeFileSync(mainPath, "use \"sub/a.qbsk\"\nprint(a.value)");
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["nested ok"]);
  });

  it("exported functions close over module-private state", () => {
    const mainPath = makeModulePair(
      "const factor = 3\nexport func triple(n)\n    return n * factor",
      "use \"lib.qbsksk\"\nprint(lib.triple(5))",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["15"]);
  });

  it("modules are immutable: assigning to a member → error", () => {
    const mainPath = makeModulePair(
      "export const greeting = \"hi\"",
      "use \"lib.qbsksk\"\nlib.greeting = \"x\"",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error?.message).toContain("modules are immutable");
  });

  it("binding collision in the same scope → error", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-test-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "a.qbsk"), "export const x = 1");
    writeFileSync(join(dir, "b.qbsk"), "export const y = 2");
    const mainPath = join(dir, "main.qbsk");
    writeFileSync(
      mainPath,
      "use \"a.qbsk\" as m\nuse \"b.qbsk\" as m",
    );
    const r = runQbsk(readFileSync(mainPath, "utf8"), mainPath);
    expect(r.error?.message).toContain("name 'm' is already bound");
  });

  it("export at the top level of the entry script is allowed and harmless", () => {
    const r = runQbsk("export const x = 1\nprint(x)", join(tmpdir(), "entry.qbsk"));
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["1"]);
  });
});

describe("eval: args()", () => {
  it("args() returns the script arguments", () => {
    const r = runQbsk("print(args())\nprint(len(args()))", "test.qbsk", undefined, {
      scriptArgs: ["a", "b"],
    });
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["[a, b]", "2"]);
  });

  it("empty args() → empty list", () => {
    expect(out("print(len(args()))")).toEqual(["0"]);
  });
});

describe("eval: sprites from file (.qba)", () => {
  const tempDirs: string[] = [];

  const HERO = "META name: hero, width: 3, height: 3\n O\n/|\\\n/ \\\n";

  function sceneWithSprite(spriteLine: string, width = 5, height = 5): string {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-test-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "hero.qba"), HERO);
    writeFileSync(join(dir, "bad.qba"), "# only comment\n");
    const qb = join(dir, "main.qbsk");
    writeFileSync(
      qb,
      `scene S(width: ${width}, height: ${height})\nlayer l z: 1\n    ${spriteLine}`,
    );
    return qb;
  }

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sprite with anchor: center places the anchor point at (x, y)", () => {
    const qb = sceneWithSprite('sprite "hero.qba" at (2, 2) anchor: center');
    const r = runQbsk(readFileSync(qb, "utf8"), qb);
    expect(r.error).toBeNull();
    expect(r.out[1]![2]).toBe("O");
    expect(r.out[2]![2]).toBe("|");
    expect(r.out[2]![1]).toBe("/");
    expect(r.out[2]![3]).toBe("\\");
  });

  it("scale: (fx, fy) scales by repetition (and composes)", () => {
    const qb = sceneWithSprite('sprite "hero.qba" at (0, 0) scale: (2, 2)', 8, 4);
    const r = runQbsk(readFileSync(qb, "utf8"), qb);
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("  OO    ");
    expect(r.out[1]).toBe("  OO    ");
    expect(r.out[2]).toBe("//||\\\\  ");
    expect(r.out[3]).toBe("//||\\\\  ");
  });

  it("sprite without anchor or scale: top-left corner", () => {
    const qb = sceneWithSprite('sprite "hero.qba" at (0, 0)');
    const r = runQbsk(readFileSync(qb, "utf8"), qb);
    expect(r.error).toBeNull();
    expect(r.out[0]![0]).toBe(" ");
    expect(r.out[0]![1]).toBe("O");
  });

  it("missing file → clear error with path and span", () => {
    const qb = sceneWithSprite('sprite "nope.qbska" at (0, 0)');
    const r = runQbsk(readFileSync(qb, "utf8"), qb);
    expect(r.error?.message).toContain("cannot load sprite 'nope.qbska'");
    expect(r.error?.message).toContain("not found");
    expect(r.error?.span.start.line).toBe(3);
    expect(r.error?.span.file).not.toBe("test.qbsk");
  });

  it(".qba without art → error with file name", () => {
    const qb = sceneWithSprite('sprite "bad.qba" at (0, 0)');
    const r = runQbsk(readFileSync(qb, "utf8"), qb);
    expect(r.error?.message).toContain("cannot load sprite 'bad.qba'");
    expect(r.error?.message).toContain("contains no art");
  });

  it("non-string path → error", () => {
    const qb = sceneWithSprite("sprite 42 at (0, 0)");
    const r = runQbsk(readFileSync(qb, "utf8"), qb);
    expect(r.error?.message).toContain("the sprite path must be a string");
  });

  it("unknown anchor → error", () => {
    const qb = sceneWithSprite('sprite "hero.qba" at (2, 2) anchor: "weird"');
    const r = runQbsk(readFileSync(qb, "utf8"), qb);
    expect(r.error?.message).toContain("unknown anchor 'weird'");
  });

  it("invalid scale (float or < 1) → error", () => {
    const qb1 = sceneWithSprite('sprite "hero.qba" at (0, 0) scale: (2.5, 1)');
    expect(runQbsk(readFileSync(qb1, "utf8"), qb1).error?.message).toContain(
      "scale must be (fx, fy) with ints ≥ 1",
    );
    const qb2 = sceneWithSprite('sprite "hero.qba" at (0, 0) scale: (0, 1)');
    expect(runQbsk(readFileSync(qb2, "utf8"), qb2).error?.message).toContain(
      "scale must be (fx, fy) with ints ≥ 1",
    );
  });
});

  describe("eval: persistent interpreter (REPL)", () => {
  it("state persists across evaluations", () => {
    const collected: string[] = [];
    const interp = new Interpreter({ print: (line) => collected.push(line) });
    interp.evalProgram(parse("var x = 1\nfunc f(n)\n    return n + x", "repl").ast);
    interp.evalProgram(parse("print(f(41))", "repl").ast);
    expect(collected).toEqual(["42"]);
  });

  it("redefining a variable in the same session → error", () => {
    const interp = new Interpreter({ print: () => {} });
    interp.evalProgram(parse("var x = 1", "repl").ast);
    expect(() => interp.evalProgram(parse("var x = 2", "repl").ast)).toThrow(
      /is already defined/,
    );
  });

  it("lastExprValue exposes the last expression value", () => {
    const interp = new Interpreter({ print: () => {} });
    interp.evalProgram(parse("40 + 2", "repl").ast);
    expect(interp.lastExprValue).toEqual({ type: "int", value: 42 });
    interp.evalProgram(parse("print(1)", "repl").ast);
    expect(interp.lastExprValue).toEqual({ type: "null" });
  });
});
