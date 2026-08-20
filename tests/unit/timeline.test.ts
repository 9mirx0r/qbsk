// an earlier release — timelines (docs/engine.md §11.5).
import { describe, expect, it } from "vitest";
import {
  activeAt,
  duration,
  finished,
  isActive,
  parallel,
  progressOf,
  sequence,
  step,
  wait,
} from "../../src/choreo/timeline.js";
import { parse } from "../../src/parser/parser.js";
import { SceneProgram } from "../../src/interp/interpreter.js";
import { runQbsk } from "../../src/interp/interpreter.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const EXAMPLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
);

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "golden");

const names = (s: Parameters<typeof activeAt>[0], t: number): string[] =>
  activeAt(s, t).map((a) => a.name);

describe("timeline duration", () => {
  it("a sequence SUMS its children", () => {
    expect(duration(sequence(step("a", 1), step("b", 2)))).toBe(3);
  });

  it("a parallel takes the LONGEST child, not the first", () => {
    expect(duration(parallel(step("a", 1), step("b", 2.5)))).toBe(2.5);
  });

  it("a wait occupies time even though it has no name", () => {
    expect(duration(sequence(step("a", 1), wait(0.5), step("b", 1)))).toBe(2.5);
  });
});

describe("what is active, and when", () => {
  const tl = sequence(step("a", 1), wait(0.5), step("b", 1));

  it("runs its steps in order", () => {
    expect(names(tl, 0.5)).toEqual(["a"]);
    expect(names(tl, 1.9)).toEqual(["b"]);
  });

  it("a wait contributes no name — it only takes time", () => {
    // This is what makes the sequence read the way it looks.
    expect(names(tl, 1.25)).toEqual([]);
  });

  it("reports progress within the active step, not within the whole timeline", () => {
    expect(progressOf(tl, "a", 0.5)).toBeCloseTo(0.5, 6);
    expect(progressOf(tl, "b", 2)).toBeCloseTo(0.5, 6);
  });

  it("a step that is not running reports null rather than 0", () => {
    // 0 would be indistinguishable from "just started" — a real ambiguity for a
    // caller deciding whether to draw something.
    expect(progressOf(tl, "b", 0.5)).toBeNull();
    expect(isActive(tl, "b", 0.5)).toBe(false);
  });

  it("nothing is active before the start or after the end", () => {
    expect(names(tl, -1)).toEqual([]);
    expect(names(tl, 99)).toEqual([]);
    expect(finished(tl, 99)).toBe(true);
    expect(finished(tl, 1)).toBe(false);
  });
});

// Criterion 4: nesting must work in BOTH directions, which is why activeAt
// recurses rather than special-casing one level.
describe("nesting works both ways round", () => {
  it("a parallel inside a sequence", () => {
    const tl = sequence(step("intro", 1), parallel(step("x", 2), step("y", 1)));
    expect(names(tl, 0.5)).toEqual(["intro"]);
    // Both branches of the parallel start together, after the intro.
    expect(names(tl, 1.5).sort()).toEqual(["x", "y"]);
    // ...and the shorter one has finished while the longer one continues.
    expect(names(tl, 2.5)).toEqual(["x"]);
    expect(duration(tl)).toBe(3);
  });

  it("a sequence inside a parallel", () => {
    const tl = parallel(sequence(step("a", 1), step("b", 1)), step("long", 2));
    expect(names(tl, 0.5).sort()).toEqual(["a", "long"]);
    expect(names(tl, 1.5).sort()).toEqual(["b", "long"]);
    expect(duration(tl)).toBe(2);
  });

  it("three levels deep still resolves", () => {
    const tl = sequence(
      wait(0.5),
      parallel(sequence(step("deep", 1)), step("side", 0.5)),
    );
    expect(names(tl, 0.25)).toEqual([]);
    expect(names(tl, 0.75).sort()).toEqual(["deep", "side"]);
    expect(names(tl, 1.25)).toEqual(["deep"]);
  });
});

describe("timelines are queried, never ticked", () => {
  it("asking the same time twice gives the same answer", () => {
    const tl = sequence(step("a", 1), parallel(step("b", 1), step("c", 2)));
    expect(activeAt(tl, 1.5)).toEqual(activeAt(tl, 1.5));
  });

  it("asking out of order is fine — there is no cursor to rewind", () => {
    const tl = sequence(step("a", 1), step("b", 1));
    const late = names(tl, 1.5);
    const early = names(tl, 0.5);
    expect(late).toEqual(["b"]);
    expect(early).toEqual(["a"]);
    expect(names(tl, 1.5)).toEqual(late);
  });
});

describe("the timeline natives from QBSK", () => {
  const build = `var tl = timeline_sequence([
    timeline_step("one", 1.0),
    timeline_wait(0.5),
    timeline_parallel([timeline_step("two", 1.0), timeline_step("three", 2.0)]),
])
`;

  it("builds and reports its total duration", () => {
    const r = runQbsk(`${build}print(timeline_duration(tl))`, "t.qbsk");
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["3.5"]);
  });

  it("reports the active names at a given time", () => {
    const r = runQbsk(
      `${build}print(timeline_active(tl, 0.5))\nprint(timeline_active(tl, 1.25))\nprint(timeline_active(tl, 2.0))`,
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("[one]");
    expect(r.out[1]).toBe("[]"); // inside the wait
    expect(r.out[2]).toContain("two");
    expect(r.out[2]).toContain("three");
  });

  it("progress is a float, and -1.0 means 'not running'", () => {
    const r = runQbsk(
      `${build}print(type(timeline_progress(tl, "one", 0.5)))\nprint(timeline_progress(tl, "one", 0.5))\nprint(timeline_progress(tl, "two", 0.5))`,
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("float");
    expect(r.out[1]).toBe("0.5");
    expect(r.out[2]).toBe("-1.0");
  });

  it("passing a non-timeline reports a typed error with a span", () => {
    const r = runQbsk(`print(timeline_duration(42))`, "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("timeline");
  });

  it("passing a dict with invalid JSON in __timeline reports a typed error with a span", () => {
    const r = runQbsk(`var bad = {"__timeline": "not valid json"}\nprint(timeline_duration(bad))`, "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("invalid timeline JSON");
  });
});

describe("byte-exact golden for intermediate timeline frame", () => {
  const SCENE = `func isActive(name)
    var active = timeline_active(tl, gameTime() % timeline_duration(tl))
    var i = 0
    while i < len(active)
        if active[i] == name
            return true
        i += 1
    return false

scene T(width: 20, height: 6)
var tl = timeline_sequence([
    timeline_step("a", 1.0),
    timeline_wait(0.5),
    timeline_parallel([
        timeline_step("b", 1.0),
        timeline_step("c", 2.0)
    ])
])

layer L z: 1
    fill "."
    visible: isActive("a")
    put "A" at (2, 2)
    visible: isActive("b")
    put "B" at (6, 2)
    visible: isActive("c")
    put "C" at (10, 2)
`;

  it("timeline frame at t=1.75 (parallel b+c active) matches golden", () => {
    const p = new SceneProgram(parse(SCENE, "t.qbsk").ast, { baseDir: EXAMPLES });
    const f = p.step(1.75);
    expect(f.error).toBeNull();
    const out = f.canvas!.renderText();
    const golden = readFileSync(resolve(GOLDEN, "timeline-t175.out"), "utf8");
    expect(out).toBe(golden);
  });
});
