// The mutation epoch (docs/engine.md §11.19).
//
// Identity cannot tell whether a list or dict changed, because QBSK edits them in place.
// The epoch answers that, and a mutator it does not know about is a layer held stale --
// silently, which is the failure this project names §14. These tests are what make an
// unlisted mutator fail instead of pass.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples");

/** Runs a program and reports how far the epoch moved while it ran. */
function epochDelta(body: string[]): number {
  const source = ["var probe = [1, 2, 3]", "var bag = {\"k\": 1}", ...body].join("\n");
  const result = runQbsk(source, "e.qbsk", undefined, { baseDir: EXAMPLES });
  expect(result.error?.message ?? null).toBeNull();
  return (result as unknown as { mutationEpoch?: number }).mutationEpoch ?? -1;
}

describe("in-place edits move the epoch", () => {
  it("index assignment on a list", () => {
    expect(epochDelta(["probe[0] = 9"])).toBeGreaterThan(0);
  });

  it("key assignment on a dict, both inserting and overwriting", () => {
    expect(epochDelta(['bag["k"] = 2'])).toBeGreaterThan(0);
    expect(epochDelta(['bag["fresh"] = 2'])).toBeGreaterThan(0);
  });

  it("compound assignment, which reads then writes back", () => {
    expect(epochDelta(["probe[0] += 1"])).toBeGreaterThan(0);
    expect(epochDelta(['bag["k"] += 1'])).toBeGreaterThan(0);
  });

  it("every native that edits its argument", () => {
    // Read out of natives.ts: push and reverse call items.push / items.reverse on the
    // list they were given. If a new mutator is added and not listed, this fails.
    for (const call of ["push(probe, 4)", "pop(probe)", "sort(probe)", "reverse(probe)"]) {
      expect(epochDelta([`var ignored = ${call}`]), call).toBeGreaterThan(0);
    }
  });
});

describe("rebinding does not move it, which is what makes the cache useful", () => {
  it("assigning a variable leaves the epoch alone", () => {
    // A frame that only reassigns -- which is what most `on tick` bodies do -- must not
    // invalidate anything. Bumping here would make the cache never hit and the whole
    // stage pointless.
    expect(epochDelta(["var t = 1", "t = 2", "t = 3"])).toBe(0);
  });

  it("reading, slicing and mapping leave it alone", () => {
    expect(epochDelta([
      "var a = probe[0]",
      "var b = slice(probe, 0, 2)",
      "var c = map(probe, str)",
      'var d = keys(bag)',
    ])).toBe(0);
  });
});
