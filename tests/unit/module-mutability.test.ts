// Modules and mutation — a spec claim that the implementation does not keep.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples");

function run(body: string[]) {
  const source = [
    'use "res/jail.qbdata" as art',
    "scene M(width: 4, height: 1)",
    "layer l z: 0",
    '    fill " "',
    ...body.map((l) => `    ${l}`),
  ].join("\n");
  return runQbsk(source, "m.qbsk", undefined, { baseDir: EXAMPLES });
}

describe("modules are documented as immutable and are not", () => {
  // docs/language.md §5 on index assignment: "`Member` (module access, still always an
  // error — modules are immutable)". Both of these succeed instead.
  //
  // It matters beyond pedantry. A module is loaded once and cached by path, so a
  // mutation reaches every later `use` of the same file — action at a distance across
  // scenes that never mention each other. It is also the reason the E1 classifier is
  // right to call a module read volatile: these tests are what justify that verdict,
  // and if the language is ever made to keep its promise, the classifier can be relaxed
  // and F1's backdrop becomes cacheable without an invalidation cache at all.
  //
  // Pinned rather than fixed here: changing it is a language decision (§17.1 surface),
  // not an engine repair, and it belongs to whoever takes that decision.
  it("lets a module's dict be mutated through the member directly", () => {
    const result = run(['art.CELL["cols"] = 999', 'print str(art.CELL["cols"])']);
    expect(result.error).toBeNull();
    expect(result.out[0]).toBe("999");
  });

  it("lets it be mutated through an alias, which no error could catch at the site", () => {
    const result = run([
      "var d = art.CELL",
      'd["cols"] = 777',
      'print str(art.CELL["cols"])',
    ]);
    expect(result.error).toBeNull();
    expect(result.out[0]).toBe("777");
  });

  it("keeps the binding itself unassignable, which is the part that does hold", () => {
    const result = run(["art.CELL = 1"]);
    expect(result.error).not.toBeNull();
  });
});
