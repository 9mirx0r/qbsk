// an earlier release — weighted population tables (the roadmap),
// the "Population Tables" item from the CDDA/Qud review's D4
// (the roadmap §4.5). Exercises examples/lib/population.qbsk in
// isolation, via `use` + runQbsk — the same style as an earlier release's action_rules tests.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

function run(source: string) {
  return runQbsk(source, "examples/lib/_test.qbsk", undefined, {
    baseDir: "examples/lib",
  });
}

function out(source: string): string[] {
  const r = run(source);
  expect(r.error).toBeNull();
  return r.out;
}

const TABLE =
  'var table = {"entries": [{"value": "guard", "weight": 50}, {"value": "merchant", "weight": 35}, {"value": "hermit", "weight": 15}]}';

describe("population.qbsk", () => {
  it("a roll near 0 lands in the first (heaviest) bucket", () => {
    expect(
      out(`
use "population.qbsk" as poptable
${TABLE}
print(poptable.weightedPick(table, 0.0))
print(poptable.weightedPick(table, 0.1))
`),
    ).toEqual(["guard", "guard"]);
  });

  it("a roll exactly on the guard/merchant boundary (0.50) lands in merchant", () => {
    // Cumulative weights: guard [0, 50), merchant [50, 85), hermit [85, 100).
    // target = roll * 100; target < cumulative is a strict '<', so target == 50
    // belongs to the NEXT bucket, not the one that just closed.
    expect(
      out(`
use "population.qbsk" as poptable
${TABLE}
print(poptable.weightedPick(table, 0.50))
`),
    ).toEqual(["merchant"]);
  });

  it("a roll in the middle range lands in the middle bucket", () => {
    expect(
      out(`
use "population.qbsk" as poptable
${TABLE}
print(poptable.weightedPick(table, 0.60))
print(poptable.weightedPick(table, 0.84))
`),
    ).toEqual(["merchant", "merchant"]);
  });

  it("a roll near 1.0 lands in the last (lightest) bucket", () => {
    expect(
      out(`
use "population.qbsk" as poptable
${TABLE}
print(poptable.weightedPick(table, 0.86))
print(poptable.weightedPick(table, 0.999))
`),
    ).toEqual(["hermit", "hermit"]);
  });

  it("weights need not sum to 100 — they're relative, not percentages", () => {
    expect(
      out(`
use "population.qbsk" as poptable
var table = {"entries": [{"value": "a", "weight": 1}, {"value": "b", "weight": 1}, {"value": "c", "weight": 2}]}
print(poptable.weightedPick(table, 0.0))
print(poptable.weightedPick(table, 0.3))
print(poptable.weightedPick(table, 0.9))
`),
    ).toEqual(["a", "b", "c"]);
  });

  it("a single-entry table always returns that entry, any roll", () => {
    expect(
      out(`
use "population.qbsk" as poptable
var table = {"entries": [{"value": "only", "weight": 7}]}
print(poptable.weightedPick(table, 0.0))
print(poptable.weightedPick(table, 0.5))
print(poptable.weightedPick(table, 0.999))
`),
    ).toEqual(["only", "only", "only"]);
  });

  it("a roll of exactly 1.0 falls back to the last entry (documented edge case)", () => {
    expect(
      out(`
use "population.qbsk" as poptable
${TABLE}
print(poptable.weightedPick(table, 1.0))
`),
    ).toEqual(["hermit"]);
  });
});

// ---------------------------------------------------------------------------
// The contract, enforced (library review).
//
// `weightedPick` had four ways to answer a question that had no answer, and each one
// returned the LAST ENTRY as though it had been chosen. A table whose weights are all
// zero describes no distribution; a negative weight makes the cumulative sum run
// backwards so entries after it can never be reached; an empty table has nothing to
// pick; and a roll outside [0, 1) — the range the header documents — lands past the end.
//
// None of those reported, because until 2026-08-19 a QBSK library could not report
// anything: `fail` did not exist. The fallback comment was right that an IN-RANGE input
// should always produce a result, and wrong that everything reaching that line was in
// range.
// ---------------------------------------------------------------------------

describe("weightedPick says when the table cannot answer", () => {
  const fails = (source: string): string => {
    const r = run(source);
    expect(r.error).not.toBeNull();
    return r.error!.message;
  };

  it("refuses a table whose weights are all zero", () => {
    // It used to answer the last entry, which reads as a deliberate pick from a table
    // that expresses no preference at all.
    const table = 'var t = {"entries": [{"value": "a", "weight": 0}, {"value": "b", "weight": 0}]}';
    expect(fails(`use "population.qbsk" as P\n${table}\nprint(P.weightedPick(t, 0.5))`))
      .toContain("no weight");
  });

  it("refuses a negative weight, which makes later entries unreachable", () => {
    // The cumulative sum runs backwards past it, so everything after can never win —
    // silently, and only for some rolls.
    const table = 'var t = {"entries": [{"value": "a", "weight": 5}, {"value": "b", "weight": 0 - 3}]}';
    expect(fails(`use "population.qbsk" as P\n${table}\nprint(P.weightedPick(t, 0.9))`))
      .toContain("negative");
  });

  it("refuses an empty table", () => {
    const table = 'var t = {"entries": []}';
    expect(fails(`use "population.qbsk" as P\n${table}\nprint(P.weightedPick(t, 0.5))`))
      .toContain("no entries");
  });

  it("refuses a roll outside the accepted [0, 1]", () => {
    // 1.5 used to land past the last cumulative boundary and fall through to the last
    // entry, which looks exactly like a valid pick.
    //
    // The bound is CLOSED, and finding that out is why this test is worth its length: the
    // header documents the roll as [0, 1) and an existing test asserted that exactly 1.0
    // falls back to the last entry. The two disagreed. They reconcile — the half-open
    // range is where the value comes from, `random()` never returning 1.0, while the
    // fallback deliberately tolerates the closed boundary and refusing 1.0 while
    // accepting 0.99999 would be a distinction with no meaning.
    const table = 'var t = {"entries": [{"value": "a", "weight": 1}, {"value": "b", "weight": 1}]}';
    expect(fails(`use "population.qbsk" as P\n${table}\nprint(P.weightedPick(t, 1.5))`))
      .toContain("[0, 1]");
    expect(fails(`use "population.qbsk" as P\n${table}\nprint(P.weightedPick(t, 0.0 - 0.1))`))
      .toContain("[0, 1]");
  });

  it("still answers the last entry for a roll that rounds to the very end", () => {
    // The fallback the header defends, and it stays: this is a real floating-point edge
    // and 0.9999 IS in range. What changed is only that out-of-range input no longer
    // arrives here wearing the same clothes.
    const table = 'var t = {"entries": [{"value": "a", "weight": 1}, {"value": "b", "weight": 1}]}';
    expect(out(`use "population.qbsk" as P\n${table}\nprint(P.weightedPick(t, 0.99999))`))
      .toEqual(["b"]);
  });
});
