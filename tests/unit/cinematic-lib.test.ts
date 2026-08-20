// examples/lib/cinematic.qbsk — the cinematic vocabulary (docs/engine.md §11.18).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples");

/** A newline, spelled once, for the multi-line QBSK snippets below. */
const NL = "\n";

/**
 * Runs a snippet with the library in scope and returns only what it PRINTED.
 *
 * `runQbsk` appends the composed canvas to the same sink, so the scene's own rows come
 * back mixed in with the prints. The scene here is two rows tall and exists only to give
 * the layer somewhere to live, so the last two lines are dropped.
 */
function evalLines(body: string[]): string[] {
  const source = [
    'use "lib/cinematic.qbsk" as cine',
    "scene T(width: 8, height: 2)",
    "layer l z: 0",
    '    fill " "',
    ...body.map((line) => `    ${line}`),
  ].join("\n");
  const result = runQbsk(source, "t.qbsk", undefined, { baseDir: EXAMPLES });
  expect(result.error?.message ?? null).toBeNull();
  return result.out.slice(0, -2);
}

describe("wrapping, at the boundaries that break naive implementations", () => {
  it("breaks on spaces without exceeding the width", () => {
    expect(evalLines(['print str(cine.wrap("the quick brown fox jumps", 10))']))
      .toEqual(["[the quick, brown fox, jumps]"]);
  });

  it("fills a line exactly rather than breaking one character early", () => {
    expect(evalLines(['print str(cine.wrap("abcde fghij", 5))']))
      .toEqual(["[abcde, fghij]"]);
  });

  it("lets a word longer than the line overflow instead of cutting it", () => {
    // Truncating would silently lose characters. A name that runs past the frame is a
    // bug the author sees; a name missing three letters is one only a reader finds.
    expect(evalLines(['print str(len(cine.wrap("supercalifragilistic", 5)))']))
      .toEqual(["1"]);
    expect(evalLines(['print str(len(cine.wrap("supercalifragilistic", 5)[0]))']))
      .toEqual(["20"]);
  });

  it("returns one empty line for empty or blank input, never zero lines", () => {
    // Zero lines would make a caller's loop draw nothing and a box collapse to its
    // border, which reads as a rendering fault rather than as an empty line.
    for (const input of ['""', '"   "']) {
      expect(evalLines([`print str(len(cine.wrap(${input}, 10)))`])).toEqual(["1"]);
    }
    expect(evalLines(['print str(len(cine.wrap("", 10)[0]))'])).toEqual(["0"]);
  });

  it("swallows runs of whitespace instead of emitting blank lines for them", () => {
    expect(evalLines(['print str(cine.wrap("hello   there", 20))']))
      .toEqual(["[hello there]"]);
  });

  it("gives back the whole string when the width is impossible", () => {
    // A width below 1 cannot hold anything. Returning the text unbroken is visibly
    // wrong at the call site; looping forever trying to fit it is not.
    expect(evalLines(['print str(cine.wrap("hello there", 0))']))
      .toEqual(["[hello there]"]);
  });
});

describe("a box reports its height before it is drawn", () => {
  it("counts border, speaker and wrapped body", () => {
    expect(evalLines(['print str(cine.box_height("a b c d e f g h", 12, "VOSK"))']))
      .toEqual(["5"]);
  });

  it("drops the speaker row when there is no speaker", () => {
    const withName = evalLines(['print str(cine.box_height("one two", 20, "VOSK"))']);
    const without = evalLines(['print str(cine.box_height("one two", 20, ""))']);
    expect(Number(withName[0])).toBe(Number(without[0]) + 1);
  });
});

describe("entrances and stage presence", () => {
  it("waits off-frame, eases across, and stays where it arrived", () => {
    // str() of a float keeps the decimal point, so these are "0.0" and "10.0" rather
    // than "0" and "10" -- the function returns the endpoints themselves, unrounded.
    expect(evalLines(['print str(cine.entrance_x(0.0, 10.0, 1.0, 2.0, 0.5))']))
      .toEqual(["0.0"]);
    expect(evalLines(['print str(int(cine.entrance_x(0.0, 10.0, 1.0, 2.0, 2.0)))']))
      .toEqual(["4"]);
    expect(evalLines(['print str(cine.entrance_x(0.0, 10.0, 1.0, 2.0, 99.0))']))
      .toEqual(["10.0"]);
  });

  it("eases rather than moving at constant speed", () => {
    // A figure that starts and stops at full speed reads as a sprite being moved.
    // Quarter of the way through time, an eased walk has covered less than a quarter.
    const quarter = evalLines(['print str(cine.entrance_x(0.0, 100.0, 0.0, 4.0, 1.0))']);
    expect(Number(quarter[0])).toBeLessThan(25);
  });

  it("keeps a figure on stage forever when no exit is given", () => {
    expect(evalLines(["print str(cine.on_stage(1.0, 0.0 - 1.0, 500.0))"])).toEqual(["true"]);
    expect(evalLines(["print str(cine.on_stage(1.0, 0.0 - 1.0, 0.5))"])).toEqual(["false"]);
    expect(evalLines(["print str(cine.on_stage(1.0, 3.0, 4.0))"])).toEqual(["false"]);
  });
});

describe("the cinematic example is pinned", () => {
  it("examples/cell_block.qbsk matches its golden byte for byte", () => {
    const source = readFileSync(resolve(EXAMPLES, "cell_block.qbsk"), "utf8");
    const golden = readFileSync(
      resolve(EXAMPLES, "..", "tests", "golden", "cell_block.qbsk.out"),
      "utf8",
    );
    const result = runQbsk(source, "cell_block.qbsk", undefined, { baseDir: EXAMPLES });
    expect(result.error).toBeNull();
    expect(result.out.join("\n")).toBe(golden.replace(/\r\n/g, "\n").replace(/\n$/, ""));
  });

  it("seeds its first frame with a real beat rather than an empty box", () => {
    // The scene block composes once at startup, before any tick (language.md §7.7). A
    // scene starting blank pins an empty dialogue box as its golden and nobody notices
    // until the loop runs.
    const golden = readFileSync(
      resolve(EXAMPLES, "..", "tests", "golden", "cell_block.qbsk.out"),
      "utf8",
    );
    expect(golden).toContain("VOSK");
    expect(golden).toContain("on your feet");
  });
});

// ---------------------------------------------------------------------------
// The contract, enforced (library review).
//
// `box_height` answers how many rows a dialogue box needs, and it is asked BEFORE
// drawing so the caller "can place the box against the bottom of the frame without
// guessing and then discovering it overflowed". For a width that cannot hold a box at
// all it answered anyway: 4 rows for a width of 4, where the border alone takes four
// columns and leaves nothing for a character of text. The caller places a box that
// cannot contain its own contents, and discovers it exactly where this function exists
// to stop them discovering it.
// ---------------------------------------------------------------------------

describe("a dialogue box refuses a width that cannot hold one", () => {
  const fails = (call: string): string => {
    const r = runQbsk(
      ['use "lib/cinematic.qbsk" as cine', `print(str(${call}))`].join(NL),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error).not.toBeNull();
    return r.error!.message;
  };

  it("refuses a width with no room for text inside the border", () => {
    // The border takes four columns. A width of 4 leaves an inner width of zero, and it
    // used to answer 4 rows for it.
    expect(fails('cine.box_height("hola mundo largo", 4, "NARRATOR")')).toContain("at least 5");
    expect(fails('cine.box_lines("hola mundo largo", 4)')).toContain("at least 5");
  });

  it("refuses a width of zero, which answered three rows", () => {
    expect(fails('cine.box_height("hola", 0, "")')).toContain("at least 5");
  });

  it("accepts the narrowest width that can actually hold a character", () => {
    // Five: four for the border, one for text. The guard has to admit this or it would
    // be refusing the smallest box that works. Three rows, not four: with no speaker the
    // box is border + one wrapped line + border.
    const r = runQbsk(
      ['use "lib/cinematic.qbsk" as cine', 'print(str(cine.box_height("ab", 5, "")))'].join(NL),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("3");
  });
});

describe("an entrance refuses a duration that runs backwards", () => {
  it("refuses a negative number of seconds", () => {
    // A negative duration made `now >= enters + seconds` true BEFORE the entrance
    // started, so the figure teleported to its destination ahead of its own cue.
    const r = runQbsk(
      [
        'use "lib/cinematic.qbsk" as cine',
        "print(str(cine.entrance_x(0.0, 10.0, 1.0, 0.0 - 2.0, 1.5)))",
      ].join(NL),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("seconds");
  });

  it("still allows an instant entrance, which zero seconds legitimately is", () => {
    const r = runQbsk(
      [
        'use "lib/cinematic.qbsk" as cine',
        "print(str(cine.entrance_x(0.0, 10.0, 1.0, 0.0, 1.5)))",
      ].join(NL),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error).toBeNull();
    expect(r.out[0]).toBe("10.0");
  });
});

