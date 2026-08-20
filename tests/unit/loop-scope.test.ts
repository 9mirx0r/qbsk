// A loop body's scope (docs/language.md §7).
//
// F6 rung 2 stops allocating an `Env` per iteration for bodies that declare nothing. That
// is a performance change with a semantic edge: the scope must still EXIST wherever a
// declaration needs it, and must still be fresh on every pass. These tests state what may
// not move, so the optimisation is checked against behaviour rather than against a hope.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples");

function out(lines: string[]): string[] {
  const r = runQbsk(lines.join("\n"), "t.qbsk", undefined, { baseDir: EXAMPLES });
  expect(r.error?.message ?? null).toBeNull();
  return r.out;
}

function failure(lines: string[]): string | null {
  return runQbsk(lines.join("\n"), "t.qbsk", undefined, { baseDir: EXAMPLES }).error?.message ?? null;
}

describe("a loop body keeps its own scope where it needs one", () => {
  it("redeclares a var on every pass instead of dying on the second", () => {
    // The failure a missing per-iteration scope produces, and it is loud: the second
    // iteration reports "already defined in this scope". Loud is the good case — this
    // test exists so the optimisation cannot quietly become right-for-one-iteration.
    expect(out([
      "var i = 0",
      "while i < 3",
      "    var seen = i * 10",
      "    print(seen)",
      "    i = i + 1",
    ])).toEqual(["0", "10", "20"]);
  });

  it("does the same in a for loop", () => {
    expect(out([
      "for i in 0..3",
      "    var doubled = i + i",
      "    print(doubled)",
    ])).toEqual(["0", "2", "4"]);
  });

  it("keeps a body-local name out of the enclosing scope", () => {
    // The other half of the same guarantee. A `var` that leaked would be visible after
    // the loop, which is a scoping change and not an optimisation.
    expect(failure([
      "var i = 0",
      "while i < 1",
      "    var inner = 5",
      "    i = i + 1",
      "print(inner)",
    ])).toMatch(/inner/);
  });

  it("still assigns to an outer variable from a body that declares nothing", () => {
    // The case the optimisation actually changes: no declarations, so no child scope.
    // Assignment must still walk up and mutate the outer binding.
    expect(out([
      "var total = 0",
      "var i = 0",
      "while i < 4",
      "    total = total + i",
      "    i = i + 1",
      "print(total)",
    ])).toEqual(["6"]);
  });

  it("gives a nested loop its own scope, twice over", () => {
    // A body that declares nothing may hold one that does. Skipping the outer scope must
    // not skip the inner.
    expect(out([
      "var i = 0",
      "while i < 2",
      "    var j = 0",
      "    while j < 2",
      "        var cell = i * 10 + j",
      "        print(cell)",
      "        j = j + 1",
      "    i = i + 1",
    ])).toEqual(["0", "1", "10", "11"]);
  });

  it("scopes a function declared inside a loop body", () => {
    // A FuncDecl declares a name exactly as a `var` does, and a body holding one needs a
    // scope for the same reason. Missing it means the second iteration cannot define it.
    expect(out([
      "var i = 0",
      "while i < 2",
      "    func label()",
      "        return \"pass\"",
      "    print(label())",
      "    i = i + 1",
    ])).toEqual(["pass", "pass"]);
  });

  it("scopes a canvas block declared inside a loop body", () => {
    // `canvas` binds a name too, and it is the kind easiest to forget when listing what
    // counts as a declaration — which is why it is listed here rather than assumed.
    expect(out([
      "var i = 0",
      "while i < 2",
      "    canvas art at (0, 0):",
      "        \"\"\"",
      "        ab",
      "        \"\"\"",
      "    print(i)",
      "    i = i + 1",
    ])).toEqual(["0", "1"]);
  });
});
