// .qbdata — a data file that cannot run (docs/language.md §12).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadQbdata } from "../../src/parser/qbdata.js";
import { runQbsk } from "../../src/interp/interpreter.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qbsk-data-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, body: string): string => {
  const file = join(dir, name);
  writeFileSync(file, body, "utf8");
  return file;
};

const load = (body: string) => loadQbdata(body, "bestiary.qbdata");

const BESTIARY = [
  "shape creature",
  "    kind: str",
  "    glyph: str",
  "    hp: int",
  "",
  'GOBLIN = {"kind": "goblin", "glyph": "g", "hp": 3}',
  'OGRE = {"kind": "ogre", "glyph": "O", "hp": 12}',
].join("\n");

describe("loading", () => {
  it("reads entries as ordinary QBSK values", () => {
    const r = load(BESTIARY);
    expect(r.errors).toEqual([]);
    expect(r.entries.get("GOBLIN")).toEqual({
      type: "dict",
      map: new Map([
        ["kind", { type: "str", value: "goblin" }],
        ["glyph", { type: "str", value: "g" }],
        ["hp", { type: "int", value: 3 }],
      ]),
    });
  });

  it("takes every literal kind", () => {
    const r = load(
      [
        'A = "text"',
        "B = 42",
        "C = 1.5",
        "D = true",
        "E = null",
        'F = [1, 2, 3]',
        'G = {"a": [1, {"b": 2}]}',
      ].join("\n"),
    );
    expect(r.errors).toEqual([]);
    expect(r.entries.size).toBe(7);
  });

  it("ignores comments and blank lines", () => {
    const r = load(["// a bestiary", "", "X = 1", "// trailing"].join("\n"));
    expect(r.errors).toEqual([]);
    expect(r.entries.size).toBe(1);
  });

  it("an empty file is valid and empty", () => {
    const r = load("");
    expect(r.errors).toEqual([]);
    expect(r.entries.size).toBe(0);
  });

  it("a duplicate entry reports rather than silently overwriting", () => {
    const r = load("X = 1\nX = 2");
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.message).toContain("X");
  });
});

// A security property with no test is a hope. Each of these is a door that must stay
// shut: a .qbdata file is meant to be safe to load from anywhere, including generated
// content, and that is only true if it genuinely cannot run.
describe("it cannot run", () => {
  const rejected: [string, string][] = [
    ["HP = 3 + 4", "expression"],
    ["X = len([1])", "call"],
    ["A = 1\nB = A", "reference"],
    ['N = "hi {x}"', "interpolat"],
    ['use "other.qbsk"', "load anything"],
    ["func f()\n    return 1", "func"],
    ["print(1)", ""],
    ["var x = 1", ""],
    ["if true\n    X = 1", ""],
    ["scene S(width: 4, height: 2)", ""],
  ];

  for (const [source, needle] of rejected) {
    it(`rejects: ${source.split("\n")[0]}`, () => {
      const r = load(source);
      expect(r.errors.length).toBeGreaterThan(0);
      if (needle !== "") {
        expect(r.errors.map((e) => e.message).join(" ")).toContain(needle);
      }
    });
  }

  it("every rejection carries a span, so it points at the line", () => {
    const r = load("X = 1\nY = 2 + 2");
    expect(r.errors[0]!.span.start.line).toBe(2);
  });
});

describe("shapes catch a typo at load", () => {
  it("a missing key names the entry and the key", () => {
    const r = load(
      [
        "shape creature",
        "    kind: str",
        "    hp: int",
        "",
        'WISP = {"kind": "wisp"}',
      ].join("\n"),
    );
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.message).toContain("WISP");
    expect(r.errors[0]!.message).toContain("hp");
  });

  // The whole point: `hpp` used to be accepted and blow up three turns later, in
  // whatever read `hp`, with a span pointing at the reader.
  it("a near-miss key is named as the likely typo", () => {
    const r = load(
      [
        "shape creature",
        "    hp: int",
        "",
        'WISP = {"hpp": 5}',
      ].join("\n"),
    );
    expect(r.errors.length).toBeGreaterThan(0);
    const all = r.errors.map((e) => e.message).join(" ");
    expect(all).toContain("hpp");
    expect(all).toContain("hp");
  });

  it("an unknown key is reported", () => {
    const r = load(
      ["shape c", "    hp: int", "", 'X = {"hp": 1, "wings": true}'].join("\n"),
    );
    expect(r.errors.map((e) => e.message).join(" ")).toContain("wings");
  });

  it("a wrong type names both types", () => {
    const r = load(
      ["shape c", "    hp: int", "", 'X = {"hp": "lots"}'].join("\n"),
    );
    const msg = r.errors.map((e) => e.message).join(" ");
    expect(msg).toContain("int");
    expect(msg).toContain("str");
  });

  it("accepts every type name a shape can use", () => {
    const r = load(
      [
        "shape everything",
        "    a: str",
        "    b: int",
        "    c: float",
        "    d: bool",
        "    e: list",
        "    f: dict",
        "",
        'X = {"a": "s", "b": 1, "c": 1.5, "d": true, "e": [], "f": {}}',
      ].join("\n"),
    );
    expect(r.errors).toEqual([]);
  });

  it("an unknown type in the shape itself reports", () => {
    const r = load(["shape c", "    hp: number", "", "X = 1"].join("\n"));
    expect(r.errors.map((e) => e.message).join(" ")).toContain("number");
  });

  // A file with no shape loads unchecked — that is the old behaviour, and it is why
  // adding this format breaks nothing.
  it("no shape means no checking", () => {
    const r = load('X = {"anything": 1}');
    expect(r.errors).toEqual([]);
  });

  it("an entry that is not a dict is not shape-checked", () => {
    const r = load(["shape c", "    hp: int", "", "N = 5"].join("\n"));
    expect(r.errors).toEqual([]);
  });

  it("a later shape applies to the entries below it", () => {
    const r = load(
      [
        "shape a",
        "    x: int",
        "",
        'ONE = {"x": 1}',
        "",
        "shape b",
        "    y: int",
        "",
        'TWO = {"y": 2}',
      ].join("\n"),
    );
    expect(r.errors).toEqual([]);
  });
});

describe("use picks the loader by extension", () => {
  it("a .qbdata module reaches the program as ordinary values", () => {
    write("bestiary.qbdata", BESTIARY);
    const main = write(
      "game.qbsk",
      [
        'use "bestiary.qbdata" as bestiary',
        'print(bestiary.GOBLIN["kind"])',
        'print(bestiary.OGRE["hp"])',
      ].join("\n"),
    );
    const r = runQbsk(
      [
        'use "bestiary.qbdata" as bestiary',
        'print(bestiary.GOBLIN["kind"])',
        'print(bestiary.OGRE["hp"])',
      ].join("\n"),
      main,
      undefined,
      { baseDir: dir },
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["goblin", "12"]);
  });

  it("the values work with spawn, so nothing has to be converted", () => {
    write("bestiary.qbdata", BESTIARY);
    const r = runQbsk(
      [
        'use "bestiary.qbdata" as bestiary',
        "var e = spawn(bestiary.GOBLIN)",
        'print(e["kind"])',
        'print(e["id"])',
      ].join("\n"),
      join(dir, "game.qbsk"),
      undefined,
      { baseDir: dir },
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["goblin", "1"]);
  });

  it("a load error in the data file reports through the use", () => {
    write("bad.qbdata", "X = 1 + 1");
    const r = runQbsk(
      'use "bad.qbdata" as bad',
      join(dir, "game.qbsk"),
      undefined,
      { baseDir: dir },
    );
    expect(r.error).not.toBeNull();
  });

  it("a .qbsk module still runs its code, unchanged", () => {
    write("helper.qbsk", 'export const N = 7\nprint("ran")');
    const r = runQbsk(
      'use "helper.qbsk" as helper\nprint(helper.N)',
      join(dir, "game.qbsk"),
      undefined,
      { baseDir: dir },
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["ran", "7"]);
  });
});

// ---------------------------------------------------------------------------
// A shape checks the dicts INSIDE a list too (§12).
//
// Found by the pressure test, writing the 73 anatomical regions of the design document §3.1. A table of records is
// the most natural thing a `.qbdata` file holds, and the natural way to write one is a
// list — `ALL = [{...}, {...}, ...]` — because a module's exports cannot be enumerated
// from QBSK, so 73 top-level names would be unreachable as a set.
//
// `checkShape` returned early for anything that was not a dict, with a reason that is
// right about bare values and wrong about lists: "a file may hold a bare number or a list
// beside its creatures, and refusing those would make the shape a straitjacket". A bare
// number, yes. A list of dicts is not a value beside the entries — it IS the entries.
//
// So the format's central promise — the one its own doc comment makes, that misspelling a
// key reports at load "rather than three turns later in whatever went looking for it" —
// did not hold in the shape a table is written in. A list of NON-dicts stays exempt,
// which is what keeps the original reasoning intact.
// ---------------------------------------------------------------------------

describe("a shape reaches inside a list (§12)", () => {
  const SHAPE = ["shape thing", "    id: str", "    n: int", ""];

  it("catches a misspelled key in a list entry, as it does at the top level", () => {
    const r = load([...SHAPE, 'ALL = [{"id": "a", "n": 1}, {"id": "b", "nn": 2}]'].join("\n"));
    expect(r.errors).not.toEqual([]);
    expect(r.errors[0]!.message).toContain("nn");
  });

  it("names the entry by its index, so a 73-row table says which row", () => {
    // "the shape does not match" on a list of seventy-three sends the author to read all
    // of them. §8: the error points at the mistake.
    const r = load([...SHAPE, 'ALL = [{"id": "a", "n": 1}, {"id": "b", "nn": 2}]'].join("\n"));
    expect(r.errors[0]!.message).toContain("ALL[1]");
  });

  it("catches a wrong type in a list entry", () => {
    const r = load([...SHAPE, 'ALL = [{"id": "a", "n": "three"}]'].join("\n"));
    expect(r.errors).not.toEqual([]);
    expect(r.errors[0]!.message).toContain("should be int");
  });

  it("catches a missing key in a list entry", () => {
    const r = load([...SHAPE, 'ALL = [{"id": "a"}]'].join("\n"));
    expect(r.errors).not.toEqual([]);
    expect(r.errors[0]!.message).toContain("missing 'n'");
  });

  it("accepts a list of correct entries", () => {
    const r = load([...SHAPE, 'ALL = [{"id": "a", "n": 1}, {"id": "b", "n": 2}]'].join("\n"));
    expect(r.errors).toEqual([]);
  });

  it("leaves a list of NON-dicts alone, which is what the exemption was for", () => {
    // The original reasoning, preserved: a file may hold a bare number or a list of
    // numbers beside its records, and a shape that refused those would be a straitjacket.
    const r = load([...SHAPE, "SIZES = [1, 2, 3]", 'NAMES = ["a", "b"]', "SCALE = 2.5"].join("\n"));
    expect(r.errors).toEqual([]);
  });

  it("checks every entry, not only the first", () => {
    // A loop that reported and stopped would hide rows 3 through 73.
    const r = load(
      [...SHAPE, 'ALL = [{"id": "a", "n": 1}, {"id": "b", "n": 2}, {"id": "c", "nn": 3}]'].join("\n"),
    );
    expect(r.errors).not.toEqual([]);
    expect(r.errors[0]!.message).toContain("ALL[2]");
  });
});

// ---------------------------------------------------------------------------
// An entry may span lines (§12).
//
// A `.qbdata` entry was one line, so a table of records was one line: 73
// anatomical regions came out as nine thousand characters with no way to break them, and
// every table still to come — nine weapons, five armour materials, thirty psychological
// variables — would have been another. A format whose stated purpose is human-authored
// tables could not lay a table out.
//
// The rule is the one a reader would guess: a literal continues while its brackets are
// open. Which means the scan has to know what a string is — `{"id": "a]b"}` closes
// nothing, and a naive bracket count would end the entry in the middle of it.
// ---------------------------------------------------------------------------

describe("an entry that spans lines (§12)", () => {
  const SHAPE = ["shape region", "    id: str", "    n: int", ""];

  it("continues a list while its brackets are open", () => {
    const r = load(
      [
        ...SHAPE,
        "ALL = [",
        '    {"id": "a", "n": 1},',
        '    {"id": "b", "n": 2}',
        "]",
      ].join("\n"),
    );
    expect(r.errors).toEqual([]);
    const all = r.entries.get("ALL");
    expect(all?.type).toBe("list");
    expect(all?.type === "list" && all.items.length).toBe(2);
  });

  it("continues a dict the same way", () => {
    const r = load(['ONE = {', '    "id": "a",', '    "n": 1', "}"].join("\n"));
    expect(r.errors).toEqual([]);
    expect(r.entries.get("ONE")?.type).toBe("dict");
  });

  it("is not fooled by a bracket inside a string", () => {
    // The reason this needs a scanner rather than a counter. If `]` inside the string
    // ended the literal, the entry would close early and the rest would look like junk.
    const r = load(['A = [', '    "a]b",', '    "c[d"', "]"].join("\n"));
    expect(r.errors).toEqual([]);
    const a = r.entries.get("A");
    expect(a?.type === "list" && a.items.length).toBe(2);
  });

  it("lets a comment sit inside a multi-line entry", () => {
    // The point of spanning lines is that a person reads it, and a table a person reads
    // is a table a person annotates.
    const r = load(
      [
        ...SHAPE,
        "ALL = [",
        "    // the head",
        '    {"id": "a", "n": 1},   // the first',
        '    {"id": "b", "n": 2}',
        "]",
      ].join("\n"),
    );
    expect(r.errors).toEqual([]);
    const all = r.entries.get("ALL");
    expect(all?.type === "list" && all.items.length).toBe(2);
  });

  it("reports a literal that is never closed, at the line that opened it", () => {
    // Not at end of file: the mistake is the entry, and the entry has a name and a line.
    const r = load(["FIRST = 1", "ALL = [", '    {"id": "a"}'].join("\n"));
    expect(r.errors).not.toEqual([]);
    expect(r.errors[0]!.message).toContain("ALL");
    expect(r.errors[0]!.span.start.line).toBe(2);
  });

  it("still checks the shape of every entry across the lines", () => {
    // The §12 promise has to survive the reformatting, or spanning lines would have
    // bought legibility by giving up the checking.
    const r = load(
      [
        ...SHAPE,
        "ALL = [",
        '    {"id": "a", "n": 1},',
        '    {"id": "b", "nn": 2}',
        "]",
      ].join("\n"),
    );
    expect(r.errors).not.toEqual([]);
    expect(r.errors[0]!.message).toContain("ALL[1]");
  });

  it("leaves a single-line entry exactly as it was", () => {
    const r = load([...SHAPE, 'ALL = [{"id": "a", "n": 1}]', "N = 3"].join("\n"));
    expect(r.errors).toEqual([]);
    expect(r.entries.get("N")).toEqual({ type: "int", value: 3 });
  });

  it("still refuses a line that is indented under nothing", () => {
    // The guard that a continuation line has to slip past, and it must not take this
    // with it: an indented line OUTSIDE any open literal is still a mistake.
    const r = load(["A = 1", "    B = 2"].join("\n"));
    expect(r.errors).not.toEqual([]);
    expect(r.errors[0]!.message).toContain("indented under nothing");
  });
});
