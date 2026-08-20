// L1 — persistence (docs/language.md §13): save_state / load_state / list_saves.
//
// The tests hand the interpreter an IN-MEMORY SaveStore (§13.5), so nothing here
// touches the disk except the CLI-store test, which builds its own temp directory.
// The acceptance test of the section is the round trip: save in one interpreter,
// load in a FRESH one, and the restored state is qbskEq-identical.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runQbsk } from "../../src/interp/interpreter.js";
import { serializeState } from "../../src/interp/saveState.js";
import { memorySaveStore, dirSaveStore } from "../../src/interp/saveStore.js";
import type { SaveStore } from "../../src/interp/natives.js";
import { loadQbdata } from "../../src/parser/qbdata.js";
import type { QValue } from "../../src/interp/value.js";

const run = (source: string, store?: SaveStore) =>
  runQbsk(source, "save.qbsk", undefined, { saveStore: store });

const dict = (entries: [string, QValue][]): Extract<QValue, { type: "dict" }> => ({
  type: "dict",
  map: new Map(entries),
});

// ---------------------------------------------------------------------------
// The serializer: QValue dict -> .qbdata text
// ---------------------------------------------------------------------------

describe("serializeState: a state dict becomes .qbdata text", () => {
  it("writes one entry per top-level key", () => {
    const text = serializeState(dict([
      ["seed", { type: "int", value: 1337 }],
      ["hp", { type: "int", value: 7 }],
    ]));
    expect(text).toContain("seed = 1337");
    expect(text).toContain("hp = 7");
  });

  it("round-trips every data type through loadQbdata", () => {
    const state = dict([
      ["n", { type: "null" }],
      ["b", { type: "bool", value: true }],
      ["i", { type: "int", value: -42 }],
      ["f", { type: "float", value: 2.5 }],
      ["whole", { type: "float", value: 3 }],
      ["s", { type: "str", value: 'he said "hi"\n\ttab' }],
      ["pos", { type: "tuple", x: { type: "int", value: 3 }, y: { type: "int", value: 4 } }],
      ["l", { type: "list", items: [{ type: "int", value: 1 }, { type: "str", value: "x" }] }],
      ["d", dict([["k", { type: "list", items: [{ type: "bool", value: false }] }]])],
    ]);
    const text = serializeState(state);
    const back = loadQbdata(text, "slot.qbdata");
    expect(back.errors).toEqual([]);
    expect(back.entries.get("n")).toEqual({ type: "null" });
    expect(back.entries.get("b")).toEqual({ type: "bool", value: true });
    expect(back.entries.get("i")).toEqual({ type: "int", value: -42 });
    // A whole float must come back a float, or a game's physics changes type on load.
    expect(back.entries.get("f")).toEqual({ type: "float", value: 2.5 });
    expect(back.entries.get("whole")).toEqual({ type: "float", value: 3 });
    expect(back.entries.get("s")).toEqual({ type: "str", value: 'he said "hi"\n\ttab' });
    expect(back.entries.get("pos")).toEqual({
      type: "tuple",
      x: { type: "int", value: 3 },
      y: { type: "int", value: 4 },
    });
    expect(back.entries.get("l")).toEqual({
      type: "list",
      items: [{ type: "int", value: 1 }, { type: "str", value: "x" }],
    });
    expect(back.entries.get("d")).toEqual(dict([
      ["k", { type: "list", items: [{ type: "bool", value: false }] }],
    ]));
  });

  it("refuses a non-data value, naming the key and the type", () => {
    const state = dict([["attack", { type: "native", name: "len", fn: () => ({ type: "null" }) }]]);
    expect(() => serializeState(state)).toThrow(/'attack'.*native.*not data/);
  });

  it("refuses a key that is not a valid entry name", () => {
    const state = dict([["not a name", { type: "int", value: 1 }]]);
    expect(() => serializeState(state)).toThrow(/'not a name'/);
  });
});

// ---------------------------------------------------------------------------
// The natives, against an in-memory store
// ---------------------------------------------------------------------------

describe("save_state / load_state / list_saves (docs/language.md §13.4)", () => {
  it("saves and loads a state dict through the store", () => {
    const store = memorySaveStore();
    const saved = run(
      `save_state("slot1", {"seed": 1337, "hp": 7})`,
      store,
    );
    expect(saved.error).toBeNull();

    const loaded = run(
      [
        `var s = load_state("slot1")`,
        `print("{s["seed"]} {s["hp"]}")`,
      ].join("\n"),
      store,
    );
    expect(loaded.error).toBeNull();
    expect(loaded.out).toEqual(["1337 7"]);
  });

  it("load_state of a missing slot is null — the Continue-menu idiom", () => {
    const result = run(
      [
        `var s = load_state("nothing")`,
        `if s == null`,
        `    print("new game")`,
      ].join("\n"),
      memorySaveStore(),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["new game"]);
  });

  it("a corrupt slot is an ERROR, never treated as missing", () => {
    const store = memorySaveStore();
    store.write("slot1", "hp = len(x)");
    const result = run(`load_state("slot1")`, store);
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/cannot call functions/);
  });

  it("list_saves is sorted and [] when empty", () => {
    const store = memorySaveStore();
    const empty = run(`print(str(list_saves()))`, store);
    expect(empty.out).toEqual(["[]"]);

    run(`save_state("zeta", {"a": 1})`, store);
    run(`save_state("alpha", {"a": 1})`, store);
    const two = run(`print(str(list_saves()))`, store);
    expect(two.out).toEqual([`[alpha, zeta]`]);
  });

  it("saving a function is a runtime error naming the key", () => {
    const result = run(
      [
        `func hit(n)`,
        `    return n - 1`,
        `save_state("slot1", {"attack": hit})`,
      ].join("\n"),
      memorySaveStore(),
    );
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/'attack'/);
    expect(result.error!.message).toMatch(/func/);
  });

  it("a slot name with a path separator is refused", () => {
    const result = run(`save_state("../escape", {"a": 1})`, memorySaveStore());
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/slot/);
  });

  it("a non-dict state is refused", () => {
    const result = run(`save_state("slot1", 42)`, memorySaveStore());
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/dict/);
  });

  it("a host with no store gets the honest error, not a silent no-op", () => {
    const result = run(`save_state("slot1", {"a": 1})`);
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/nowhere to save/);
  });
});

// ---------------------------------------------------------------------------
// The acceptance test (§13.6): round trip into a FRESH interpreter
// ---------------------------------------------------------------------------

describe("the round trip (docs/language.md §13.6)", () => {
  it("state saved in one interpreter restores identically in a fresh one", () => {
    const store = memorySaveStore();
    const first = run(
      [
        `var state = {"seed": 99, "turn": 12, "pos": (3, 4), "log": ["hit", "miss"]}`,
        `save_state("game", state)`,
      ].join("\n"),
      store,
    );
    expect(first.error).toBeNull();

    // A FRESH interpreter — nothing shared but the store.
    const second = run(
      [
        `var state = load_state("game")`,
        `print("{state["seed"]} {state["turn"]} {state["pos"]} {state["log"]}")`,
      ].join("\n"),
      store,
    );
    expect(second.error).toBeNull();
    expect(second.out).toEqual(["99 12 (3, 4) [hit, miss]"]);
  });
});

// ---------------------------------------------------------------------------
// The CLI store: <script-dir>/saves/<slot>.qbdata
// ---------------------------------------------------------------------------

describe("dirSaveStore (the CLI's storage, §13.5)", () => {
  it("writes <dir>/saves/<slot>.qbdata and reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-save-"));
    try {
      const store = dirSaveStore(dir);
      store.write("slot1", "hp = 7\n");
      const onDisk = readFileSync(join(dir, "saves", "slot1.qbdata"), "utf8");
      expect(onDisk).toBe("hp = 7\n");
      expect(store.read("slot1")).toBe("hp = 7\n");
      expect(store.read("missing")).toBeNull();
      expect(store.list()).toEqual(["slot1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists only .qbdata files, sorted, without the extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-save-"));
    try {
      const store = dirSaveStore(dir);
      store.write("zeta", "a = 1\n");
      store.write("alpha", "a = 1\n");
      writeFileSync(join(dir, "saves", "notes.txt"), "not a save");
      expect(store.list()).toEqual(["alpha", "zeta"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §12.2 amendment: tuple literals are admitted in .qbdata
// ---------------------------------------------------------------------------

describe(".qbdata admits tuple literals (§12.2)", () => {
  it("loads a tuple entry", () => {
    const result = loadQbdata("pos = (3, 4)", "t.qbdata");
    expect(result.errors).toEqual([]);
    expect(result.entries.get("pos")).toEqual({
      type: "tuple",
      x: { type: "int", value: 3 },
      y: { type: "int", value: 4 },
    });
  });

  it("still rejects a tuple containing a name", () => {
    const result = loadQbdata("pos = (x, 4)", "t.qbdata");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).toMatch(/'x' is a name/);
  });
});
