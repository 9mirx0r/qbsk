// Entities and turns (docs/engine.md §12).
import { describe, expect, it } from "vitest";
import { SceneProgram } from "../../src/interp/interpreter.js";
import { readFileSync } from "node:fs";
import { parse } from "../../src/parser/parser.js";

const program = (src: string) => {
  const parsed = parse(src, "t.qbsk");
  expect(parsed.errors).toEqual([]);
  return new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });
};

/** One frame of a program, with whatever it printed and whatever it reported. */
const run = (lines: string[]): { out: string[]; error: string | null } => {
  const out: string[] = [];
  const parsed = parse(lines.join("\n"), "t.qbsk");
  expect(parsed.errors).toEqual([]);
  const p = new SceneProgram(parsed.ast, {
    runtime: { gameTime: 0 },
    print: (line) => out.push(line),
  });
  const f = p.step(1 / 60);
  return { out, error: f.error?.message ?? null };
};

const printed = (src: string, frames = 1): string[] => {
  const out: string[] = [];
  const parsed = parse(src, "t.qbsk");
  expect(parsed.errors).toEqual([]);
  const p = new SceneProgram(parsed.ast, {
    runtime: { gameTime: 0 },
    print: (line) => out.push(line),
  });
  for (let i = 0; i < frames; i += 1) {
    const f = p.step(1 / 60);
    if (f.error !== null) {
      throw new Error(f.error.message);
    }
  }
  return out;
};

describe("the turn clock is not the frame clock", () => {
  it("turn() starts at 0 and frames alone never move it", () => {
    expect(printed("on tick(dt)\n    print(turn())", 5)).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
    ]);
  });

  it("advance() moves it by exactly one", () => {
    const src = [
      "on tick(dt)",
      "    if turn() < 3",
      "        advance()",
      "    print(turn())",
    ].join("\n");
    // Requested during tick, so the turn lands before composition of the SAME frame,
    // but `print` here runs before that — the reading is last frame's number.
    expect(printed(src, 4)).toEqual(["0", "1", "2", "3"]);
  });

  // A key press and its consequence must land in the same frame. A one-frame lag
  // between pressing and seeing is exactly what feels wrong and is hard to diagnose.
  it("a turn requested from a key handler runs in the same frame", () => {
    const src = [
      "var acted = 0",
      'on key "space"',
      "    advance()",
      "on turn(n)",
      "    acted += 1",
      "scene S(width: 8, height: 3)",
      "layer a z: 1",
      '    fill "."',
      '    put str(acted) at (0, 1)',
    ].join("\n");
    const p = program(src);
    p.step(1 / 60);
    expect(p.liveEnv.get("acted")).toEqual({ type: "int", value: 0 });
    p.pressKey("space");
    const f = p.step(1 / 60);
    expect(f.error).toBeNull();
    // Composed AFTER the turn ran, so the frame already shows the consequence.
    expect(f.canvas!.renderText().split("\n")[1]![0]).toBe("1");
  });

  it("several requests in one frame run several turns — that is `rest`", () => {
    const src = [
      "var acts = 0",
      'on key "r"',
      "    var i = 0",
      "    while i < 10",
      "        advance()",
      "        i += 1",
      "on turn(n)",
      "    acts += 1",
    ].join("\n");
    const p = program(src);
    p.pressKey("r");
    p.step(1 / 60);
    expect(p.liveEnv.get("acts")).toEqual({ type: "int", value: 10 });
    expect(p.liveEnv.get("__none")).toBeUndefined();
  });

  it("turn() inside a turn handler reads the turn being played", () => {
    const src = [
      "var seen = []",
      "on tick(dt)",
      "    if turn() < 3",
      "        advance()",
      "on turn(n)",
      "    seen = push(seen, n)",
    ].join("\n");
    const p = program(src);
    for (let i = 0; i < 4; i += 1) {
      p.step(1 / 60);
    }
    const seen = p.liveEnv.get("seen");
    expect(seen).toEqual({
      type: "list",
      items: [
        { type: "int", value: 1 },
        { type: "int", value: 2 },
        { type: "int", value: 3 },
      ],
    });
  });

  // Without this rule an infinite loop inside one frame is trivial to write by accident.
  it("a turn requested DURING a turn handler waits for the next frame", () => {
    const src = [
      "var acts = 0",
      "on tick(dt)",
      "    if turn() == 0",
      "        advance()",
      "on turn(n)",
      "    acts += 1",
      "    if n < 5",
      "        advance()",
    ].join("\n");
    const p = program(src);
    p.step(1 / 60);
    expect(p.liveEnv.get("acts")).toEqual({ type: "int", value: 1 });
    p.step(1 / 60);
    expect(p.liveEnv.get("acts")).toEqual({ type: "int", value: 2 });
  });

  it("a scene can draw the turn counter without keeping a variable in step", () => {
    const src = [
      'on key "space"',
      "    advance()",
      "scene S(width: 10, height: 3)",
      "layer a z: 1",
      '    fill "."',
      '    put "T" + str(turn()) at (0, 1)',
    ].join("\n");
    const p = program(src);
    // One press per frame: since docs/engine.md §8.3, repeated presses of the same key
    // within a frame coalesce, so two `space` in one frame is one turn. Pressing on
    // successive frames is how a turn-based game actually reads — a player pressing
    // space twice as fast as the frame rate meant to take one turn, not two.
    p.pressKey("space");
    expect(p.step(1 / 60).canvas!.renderText().split("\n")[1]!.slice(0, 2)).toBe("T1");
    p.pressKey("space");
    expect(p.step(1 / 60).canvas!.renderText().split("\n")[1]!.slice(0, 2)).toBe("T2");
  });
});

describe("entities keep their identity across a rebuild", () => {
  it("spawn adds an id, and ids are unique", () => {
    const src = [
      'var a = spawn({"kind": "goblin"})',
      'var b = spawn({"kind": "goblin"})',
      'print(a["id"])',
      'print(b["id"])',
      'print(a["kind"])',
    ].join("\n");
    expect(printed(src)).toEqual(["1", "2", "goblin"]);
  });

  // The whole reason this native exists: no index assignment means a turn REBUILDS the
  // list, so every entity is a new dict and identity would otherwise be lost.
  it("an entity survives the list being rebuilt", () => {
    const src = [
      "var es = []",
      'es = push(es, spawn({"hp": 5}))',
      'es = push(es, spawn({"hp": 9}))',
      "var target = es[1][\"id\"]",
      "var next = []",
      "var i = 0",
      "while i < len(es)",
      "    var e = es[i]",
      '    next = push(next, {"id": e["id"], "hp": e["hp"] - 1})',
      "    i += 1",
      "es = next",
      'print(find(es, target)["hp"])',
    ].join("\n");
    expect(printed(src)).toEqual(["8"]);
  });

  // A corpse is not a bug. An entity that died is the normal case in a simulation.
  it("find returns null for an entity that is gone", () => {
    const src = [
      'var es = [spawn({"hp": 1})]',
      "var id = es[0][\"id\"]",
      "es = without(es, id)",
      "print(len(es))",
      "print(find(es, id) == null)",
    ].join("\n");
    expect(printed(src)).toEqual(["0", "true"]);
  });

  it("without leaves the others untouched", () => {
    const src = [
      'var es = [spawn({"n": 1}), spawn({"n": 2}), spawn({"n": 3})]',
      "es = without(es, es[1][\"id\"])",
      "print(len(es))",
      'print(es[0]["n"])',
      'print(es[1]["n"])',
    ].join("\n");
    expect(printed(src)).toEqual(["2", "1", "3"]);
  });

  it("without an id that is not there changes nothing", () => {
    expect(printed('var es = [spawn({"n": 1})]\nprint(len(without(es, 999)))'))
      .toEqual(["1"]);
  });

  // Silently renumbering would destroy exactly the identity this exists to provide.
  it("spawn refuses to overwrite an id that is already there", () => {
    const p = program('var e = spawn({"id": 7, "hp": 1})');
    const f = p.step(1 / 60);
    expect(f.error).not.toBeNull();
    expect(f.error!.message).toContain("id");
  });

  it("reports the wrong type by name", () => {
    for (const [src, needle] of [
      ["var e = spawn(7)", "int"],
      ["var e = find(7, 1)", "int"],
      ['var e = find([spawn({"a": 1})], "x")', "str"],
    ] as const) {
      const f = program(src).step(1 / 60);
      expect(f.error).not.toBeNull();
      expect(f.error!.message).toContain(needle);
    }
  });
});

describe("determinism — the reason the turn is a clock and not a variable", () => {
  const SIM = [
    "var es = []",
    "var log = []",
    "on start",
    "    var i = 0",
    "    while i < 5",
    '        es = push(es, spawn({"x": i, "hp": 3 + i}))',
    "        i += 1",
    "on tick(dt)",
    "    if turn() < 4",
    "        advance()",
    "on turn(n)",
    "    var next = []",
    "    var i = 0",
    "    while i < len(es)",
    "        var e = es[i]",
    '        next = push(next, {"id": e["id"], "x": (e["x"] + n) % 10, "hp": e["hp"] - 1})',
    "        i += 1",
    "    es = next",
    "    log = push(log, len(es))",
    "scene S(width: 12, height: 3)",
    "layer a z: 1",
    '    fill "."',
    '    put "T" + str(turn()) at (0, 1)',
  ].join("\n");

  const run = (): string => {
    const p = program(SIM);
    let text = "";
    for (let i = 0; i < 6; i += 1) {
      const f = p.step(1 / 60);
      expect(f.error).toBeNull();
      text += f.canvas!.renderText();
    }
    return text;
  };

  it("the same starting state and turn sequence give byte-identical frames", () => {
    expect(run()).toBe(run());
  });

  it("ids are a counter, so two runs assign them identically", () => {
    const ids = (): unknown => {
      const p = program(SIM);
      p.step(1 / 60);
      return p.liveEnv.get("es");
    };
    expect(JSON.stringify(ids())).toBe(JSON.stringify(ids()));
  });
});

describe("examples/turns.qbsk — the world moves when you do", () => {
  const example = readFileSync(
    new URL("../../examples/turns.qbsk", import.meta.url),
    "utf8",
  );
  const game = () => {
    const parsed = parse(example, "examples/turns.qbsk");
    expect(parsed.errors).toEqual([]);
    // baseDir so `use "res/bestiary.qbdata"` resolves — the example is data-driven
    // since an earlier release, and its creatures come out of a file that cannot run.
    return new SceneProgram(parsed.ast, {
      runtime: { gameTime: 0 },
      baseDir: "examples",
    });
  };

  const positions = (p: ReturnType<typeof game>): string =>
    JSON.stringify(
      (p.liveEnv.get("goblins") as { items: { map: Map<string, { value: number }> }[] })
        .items.map((g) => `${g.map.get("x")!.value},${g.map.get("y")!.value}`),
    );

  // The claim the whole phase rests on, asserted rather than described.
  it("frames alone move nothing", () => {
    const p = game();
    p.step(1 / 20);
    const before = positions(p);
    for (let i = 0; i < 20; i += 1) {
      p.step(1 / 20);
    }
    expect(positions(p)).toBe(before);
    expect(p.runtime.sim!.turn).toBe(0);
  });

  it("one key press moves the whole world once", () => {
    const p = game();
    p.step(1 / 20);
    const before = positions(p);
    p.pressKey("arrow-right");
    p.step(1 / 20);
    expect(positions(p)).not.toBe(before);
    expect(p.runtime.sim!.turn).toBe(1);
  });

  // Free actions are why advance() is explicit instead of automatic on every key.
  it("opening the pack costs nothing", () => {
    const p = game();
    p.pressKey("arrow-right");
    p.step(1 / 20);
    const before = positions(p);
    p.pressKey("i");
    p.step(1 / 20);
    expect(positions(p)).toBe(before);
    expect(p.runtime.sim!.turn).toBe(1);
  });

  it("goblins close in, turn after turn", () => {
    const p = game();
    p.step(1 / 20);
    const start = positions(p);
    for (let i = 0; i < 5; i += 1) {
      p.pressKey(".");
      p.step(1 / 20);
    }
    expect(p.runtime.sim!.turn).toBe(5);
    expect(positions(p)).not.toBe(start);
  });

  // The golden is driven through a SCRIPTED TURN SEQUENCE, which is what turns
  // "the same turns give the same frames" from a sentence into a check.
  const SEQUENCE = [
    "arrow-right",
    "arrow-right",
    "arrow-down",
    ".",
    "i",
    "arrow-left",
  ];

  const play = (): string => {
    const p = game();
    p.step(1 / 20);
    let text = "";
    for (const key of SEQUENCE) {
      p.pressKey(key);
      const f = p.step(1 / 20);
      expect(f.error).toBeNull();
      text = f.canvas!.renderText();
    }
    return text;
  };

  it("the scripted sequence composes byte for byte", () => {
    const golden = readFileSync(
      new URL("../golden/turns.qbsk.out", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(play()).toBe(golden);
  });

  it("replaying the same sequence gives the same frames", () => {
    expect(play()).toBe(play());
  });

  it("six keys, one of them free, leave the counter on five", () => {
    expect(play()).toContain("turn 5");
  });

  it("a different sequence gives a different frame", () => {
    const p = game();
    p.step(1 / 20);
    let f = null;
    for (const key of ["arrow-up", "arrow-up", "arrow-up"]) {
      p.pressKey(key);
      f = p.step(1 / 20);
    }
    expect(f!.canvas!.renderText()).not.toBe(play());
  });
});

// docs/engine.md §12.2 and this example both stated that QBSK has no index assignment,
// which stopped being true in an earlier release. The claim survived because nothing executed it:
// a comment cannot fail, and the golden only pins what the example DOES, never what it
// says about the language.
//
// It was not harmless. A reader took "the list is REBUILT — QBSK has no index
// assignment" as a language limit, wrote a full list rebuild to subtract one point of
// hp, and filed the verbosity as a missing feature. So the corrected claim gets a test:
// if in-place entity mutation ever stops working, this fails, and if it keeps working,
// no document may claim otherwise.
describe("entities can be mutated in place (docs/engine.md §12.2, an earlier release)", () => {
  it("an entity's component is assignable through the list", () => {
    const out = printed(
      [
        'var es = [spawn({"hp": 3}), spawn({"hp": 2})]',
        "es[0][\"hp\"] -= 1",
        'print("{es[0]["hp"]},{es[1]["hp"]}")',
      ].join("\n"),
    );
    expect(out).toEqual(["2,2"]);
  });

  // The property that makes in-place mutation useful across a program: a function
  // receives the same list its caller holds (docs/language.md §5.3, by reference).
  it("a function mutates the entity its caller holds", () => {
    const out = printed(
      [
        "func hurt(list, id, amount)",
        "    var i = 0",
        "    while i < len(list)",
        '        if list[i]["id"] == id',
        '            list[i]["hp"] -= amount',
        "        i += 1",
        'var es = [spawn({"hp": 5})]',
        "hurt(es, es[0][\"id\"], 2)",
        'print("{es[0]["hp"]}")',
      ].join("\n"),
    );
    expect(out).toEqual(["3"]);
  });

  // The example is free to rebuild — that is a design choice with real merits (a
  // half-updated turn is never drawn). What it may not do is call it a limitation.
  it("no example or spec claims the language lacks index assignment", () => {
    // The claim, as an assertion ABOUT THE LANGUAGE: "QBSK/it has no index assignment".
    // Narrow on purpose. A wider pattern plus a "but this is retracted" escape hatch was
    // tried first and proved worthless: the escape hatch matched the correction note
    // sitting beside any reintroduced claim, so the test passed when the bug was put
    // back by hand. A rule that cannot fail is not a rule, so the retraction is quoted
    // in a form the pattern does not match instead of being exempted by proximity.
    const claim = /\b(QBSK|the language|it)\s+has no index assignment/i;
    const files = [
      new URL("../../examples/turns.qbsk", import.meta.url),
      new URL("../../docs/engine.md", import.meta.url),
      new URL("../../docs/language.md", import.meta.url),
    ];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (claim.test(line)) {
          throw new Error(`stale claim in ${file.pathname}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// `find` and `without` are ENTITY natives, and they now say so (§15.11).
//
// Found by first spike, writing a GOAP planner's open list. `without` was
// reached for as "remove this element" — the reading its name invites — and it returned
// the list UNCHANGED, with exit code 0 and no message. The planner then expanded four
// hundred nodes and found nothing, because its frontier never shrank.
//
// The mechanism is one helper: `entityList` promises "a list of entities" in its own
// error message and only checks that the value is a LIST, while `idOf` answers `null` for
// anything that is not an entity. Both natives then read that `null` as "does not match"
// rather than as "this is not an entity" — so a list of ints filters to itself and a
// lookup answers `null`, which is indistinguishable from the legitimate "it died".
//
// That is anti-pattern 1 in its purest form: it parses, it runs, it reports success, and
// it does nothing. These tests pin the CATEGORY — both natives, both directions — because
// the defect was never in either of them, it was in the helper they share.
// ---------------------------------------------------------------------------

describe("an entity native says when it was not given entities (§15.12)", () => {
  it("reports rather than silently returning the list unchanged", () => {
    // The exact call the spike made. Returning `[10, 20, 30]` here is the bug.
    const r = run(["var l = [10, 20, 30]", "print(str(without(l, 1)))"]);
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("entities");
  });

  it("reports on `find` too, where the silence looked like a dead entity", () => {
    // Worse than `without`'s, because `null` is what `find` legitimately answers for an
    // entity that died — so the mistake wears the costume of a normal simulation event.
    const r = run(["var l = [10, 20, 30]", "print(str(find(l, 1)))"]);
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("entities");
  });

  it("names the offending element, not just the call", () => {
    // §8: the error points at the mistake. "expects entities" on a 200-entity list sends
    // the author to read all of them; the index and the type say which one to look at.
    const r = run([
      'var a = spawn({"hp": 3})',
      "var l = [a, 7]",
      "print(str(without(l, 1)))",
    ]);
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("1");
    expect(r.error).toContain("int");
  });

  it("still accepts an empty list, because every entity dying is not an error", () => {
    const r = run(["var l = []", "print(str(len(without(l, 1))))"]);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["0"]);
  });

  it("still accepts an id that matches nothing, for the same reason", () => {
    // A corpse is not a bug — the comment `find` already carries. What changed is only
    // that the LIST has to be entities; the ID is still free to match none of them.
    const r = run([
      'var a = spawn({"hp": 3})',
      "var l = [a]",
      "print(str(len(without(l, 9999))) + \",\" + str(find(l, 9999) == null))",
    ]);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["1,true"]);
  });

  it("still removes and finds a real entity, which is what it is for", () => {
    const r = run([
      'var a = spawn({"hp": 3})',
      'var b = spawn({"hp": 5})',
      "var l = [a, b]",
      "var rest = without(l, a[\"id\"])",
      "print(str(len(rest)) + \",\" + str(find(rest, b[\"id\"])[\"hp\"]))",
    ]);
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["1,5"]);
  });
});
