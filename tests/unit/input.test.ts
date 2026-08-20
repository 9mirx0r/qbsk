// The terminal key decoder (docs/engine.md §8).
import { describe, expect, it } from "vitest";
import { KeyDecoder, KEY_QUEUE_MAX } from "../../src/engine/input.js";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isCanonicalKey } from "../../src/engine/keys.js";
import { SceneProgram } from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";

/** Feeds chunks and collects every name that came out. */
const feed = (...chunks: string[]): string[] => {
  const d = new KeyDecoder();
  const out: string[] = [];
  for (const chunk of chunks) {
    out.push(...d.push(Buffer.from(chunk, "binary")));
  }
  out.push(...d.flush());
  return out;
};

describe("decoding", () => {
  it("the arrows carry the prefix the language actually uses", () => {
    expect(feed("\x1b[A")).toEqual(["arrow-up"]);
    expect(feed("\x1b[B")).toEqual(["arrow-down"]);
    expect(feed("\x1b[C")).toEqual(["arrow-right"]);
    expect(feed("\x1b[D")).toEqual(["arrow-left"]);
  });

  it("space, enter, tab and backspace have names", () => {
    expect(feed(" ")).toEqual(["space"]);
    expect(feed("\r")).toEqual(["enter"]);
    expect(feed("\n")).toEqual(["enter"]);
    expect(feed("\t")).toEqual(["tab"]);
    expect(feed("\x7f")).toEqual(["backspace"]);
    expect(feed("\b")).toEqual(["backspace"]);
  });

  it("home and end decode", () => {
    expect(feed("\x1b[H")).toEqual(["home"]);
    expect(feed("\x1b[F")).toEqual(["end"]);
  });

  it("an ordinary character is its own name", () => {
    expect(feed("a")).toEqual(["a"]);
    expect(feed("Z")).toEqual(["Z"]);
    expect(feed("?")).toEqual(["?"]);
  });

  it("several keys in one chunk all come out, in order", () => {
    expect(feed("abc")).toEqual(["a", "b", "c"]);
    expect(feed("\x1b[A\x1b[Bx")).toEqual(["arrow-up", "arrow-down", "x"]);
  });

  // Everything it emits must be a name a handler can be registered under, or the
  // decoder and the vocabulary have drifted and keys fail silently.
  it("every name it produces is canonical", () => {
    const names = feed("\x1b[A\x1b[B\x1b[C\x1b[D \r\t\x7faZ?9\x1b[H\x1b[F");
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(isCanonicalKey(name)).toBe(true);
    }
  });
});

// The reason a decoder exists at all rather than a `chunk.toString()` switch.
describe("a sequence split across chunks", () => {
  it("survives being cut anywhere", () => {
    expect(feed("\x1b", "[A")).toEqual(["arrow-up"]);
    expect(feed("\x1b[", "A")).toEqual(["arrow-up"]);
    expect(feed("\x1b", "[", "A")).toEqual(["arrow-up"]);
  });

  it("does not invent keys from the halves", () => {
    // The wrong implementation reports "escape", "[", "A" — three keys for one press.
    expect(feed("\x1b", "[A")).not.toContain("escape");
  });

  it("a chunk boundary in the middle of a run loses nothing", () => {
    expect(feed("ab\x1b[", "Ccd")).toEqual(["a", "b", "arrow-right", "c", "d"]);
  });
});

describe("escape, which is also the start of every arrow", () => {
  // Reporting it immediately emits a phantom escape before every arrow; never
  // reporting it loses the key. So it waits for something that does not continue it.
  it("is held while it could still be an arrow", () => {
    const d = new KeyDecoder();
    expect(d.push(Buffer.from("\x1b"))).toEqual([]);
  });

  it("is reported when the stream goes quiet", () => {
    expect(feed("\x1b")).toEqual(["escape"]);
  });

  it("is reported when a key that cannot continue it arrives", () => {
    expect(feed("\x1ba")).toEqual(["escape", "a"]);
  });

  it("two escapes in a row are two escapes", () => {
    expect(feed("\x1b\x1b")).toEqual(["escape", "escape"]);
  });

  it("an unknown escape sequence is dropped, not spelled out", () => {
    // A terminal sends plenty this decoder does not know; emitting "[", "2", "~" as
    // three keys would be worse than silence.
    expect(feed("\x1b[2~")).toEqual([]);
    expect(feed("\x1b[15;2~x")).toEqual(["x"]);
  });
});

describe("Ctrl-C", () => {
  // Raw mode stops the terminal generating SIGINT and delivers 0x03 as data. With no
  // handler the loop becomes unkillable except by closing the terminal.
  it("is reported as its own name, not swallowed and not a character", () => {
    expect(feed("\x03")).toEqual(["ctrl-c"]);
  });

  it("comes out even in the middle of other input", () => {
    expect(feed("ab\x03cd")).toEqual(["a", "b", "ctrl-c", "c", "d"]);
  });
});

describe("the queue cap (docs/engine.md §8.2)", () => {
  it("is a real number, not the letter N", () => {
    expect(KEY_QUEUE_MAX).toBe(256);
  });
});

describe("things a terminal sends that are not keys", () => {
  it("a NUL is ignored rather than becoming a key", () => {
    expect(feed("a\x00b")).toEqual(["a", "b"]);
  });

  it("an empty chunk changes nothing", () => {
    expect(feed("", "a", "")).toEqual(["a"]);
  });

  it("a multi-byte character arrives as one key", () => {
    const d = new KeyDecoder();
    const out = d.push(Buffer.from("ñ", "utf8"));
    expect(out).toEqual(["ñ"]);
  });
});

describe("the queue cap, where it lives (docs/engine.md §8.2)", () => {
  // Recorded during an earlier release recon: the queue was unbounded and drained fully in
  // one step. 50 000 presses measured at 832 ms in a single frame — a freeze, and
  // reachable by holding an arrow under OS key repeat.
  it("holds the newest presses and drops the oldest", () => {
    // This used to assert that 256 presses of "a" produced 256 dispatches. §8.3 now
    // coalesces repeats within a frame, so the observable is different: what survives
    // is WHICH keys were pressed, oldest-dropped, not how many times.
    const src = [
      "var seen = []",
      'on key "a"',
      '    seen = push(seen, "a")',
      'on key "b"',
      '    seen = push(seen, "b")',
    ].join("\n");
    const parsed = parse(src, "t.qbsk");
    expect(parsed.errors).toEqual([]);
    const p = new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });

    // One more than the cap: the very first press must be the one that fell off, so
    // the "b" never reaches a handler.
    p.pressKey("b");
    for (let i = 0; i < KEY_QUEUE_MAX; i += 1) {
      p.pressKey("a");
    }
    p.step(1 / 60);
    const seen = p.liveEnv.get("seen") as { items: { value: string }[] };
    expect(seen.items.map((v) => v.value)).toEqual(["a"]);
  });

  it("an overflowing frame stays affordable", () => {
    const parsed = parse('on key "a"\n    var x = 1', "t.qbsk");
    const p = new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });
    for (let i = 0; i < 50_000; i += 1) {
      p.pressKey("a");
    }
    const t0 = performance.now();
    p.step(1 / 60);
    // Unbounded this took 832 ms. Capped it is bounded by the cap, and since §8.3 it
    // is bounded again by the number of DISTINCT keys — here, one dispatch.
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("repeat coalescing (docs/engine.md §8.3)", () => {
  const moveProgram = () => {
    const parsed = parse(
      [
        "var x = 0",
        "var y = 0",
        'on key "arrow-right"',
        "    x = x + 1",
        'on key "arrow-down"',
        "    y = y + 1",
      ].join("\n"),
      "t.qbsk",
    );
    expect(parsed.errors).toEqual([]);
    return new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });
  };

  const numberOf = (p: SceneProgram, name: string): number =>
    (p.liveEnv.get(name) as { value: number }).value;

  it("a held key moves once per frame, not once per press", () => {
    // The measurement that motivated the change: 20 presses landing in one frame moved
    // the player 20 cells, so the OS repeat rate set the game's speed.
    const p = moveProgram();
    for (let i = 0; i < 20; i += 1) {
      p.pressKey("arrow-right");
    }
    p.step(1 / 60);
    expect(numberOf(p, "x")).toBe(1);
  });

  it("holding across frames still moves every frame", () => {
    // Coalescing must not swallow continued input — that would be a stuck player.
    const p = moveProgram();
    for (let frame = 0; frame < 5; frame += 1) {
      p.pressKey("arrow-right");
      p.pressKey("arrow-right");
      p.step(1 / 60);
    }
    expect(numberOf(p, "x")).toBe(5);
  });

  it("different keys in the same frame all dispatch", () => {
    // Diagonal movement, and the reason this coalesces per KEY rather than per frame.
    const p = moveProgram();
    p.pressKey("arrow-right");
    p.pressKey("arrow-down");
    p.pressKey("arrow-right");
    p.step(1 / 60);
    expect(numberOf(p, "x")).toBe(1);
    expect(numberOf(p, "y")).toBe(1);
  });

  it("arrival order is preserved", () => {
    const parsed = parse(
      [
        'var log = ""',
        'on key "a"',
        '    log = log + "a"',
        'on key "b"',
        '    log = log + "b"',
      ].join("\n"),
      "t.qbsk",
    );
    const p = new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });
    p.pressKey("b");
    p.pressKey("a");
    p.pressKey("b");
    p.step(1 / 60);
    expect((p.liveEnv.get("log") as { value: string }).value).toBe("ba");
  });
});

describe("examples/keys.qbsk responds (RULE #5)", () => {
  const example = readFileSync(
    new URL("../../examples/keys.qbsk", import.meta.url),
    "utf8",
  );

  const play = (keys: string[]): string[] => {
    const parsed = parse(example, "examples/keys.qbsk");
    expect(parsed.errors).toEqual([]);
    const p = new SceneProgram(parsed.ast, { runtime: { gameTime: 0 } });
    const frames: string[] = [];
    for (const key of keys) {
      if (key !== "") {
        p.pressKey(key);
      }
      const f = p.step(1 / 20);
      expect(f.error).toBeNull();
      frames.push(f.canvas!.renderText());
    }
    return frames;
  };

  const SEQUENCE = [
    "arrow-right",
    "arrow-right",
    "arrow-right",
    "",
    "arrow-left",
    "",
  ];

  // Closes the finding recorded against an earlier release: the determinism test there would
  // pass with `on key` COMPLETELY BROKEN, because the ball moves on tick regardless.
  // This is the assertion that fails when the feature breaks.
  it("a scripted sequence differs from pressing nothing", () => {
    const withKeys = play(SEQUENCE).join("\n");
    const without = play(SEQUENCE.map(() => "")).join("\n");
    expect(withKeys).not.toBe(without);
  });

  it("the arrows move the player, and back", () => {
    const frames = play(SEQUENCE);
    const at = (frame: string): number =>
      frame.split("\n").findIndex((row) => row.includes("@"));
    expect(at(frames[0]!)).toBeGreaterThanOrEqual(0);
    // Three right then one left: the last frame's @ is not where the first one was.
    expect(frames[0]).not.toBe(frames[4]);
  });

  it("the same sequence replays identically", () => {
    expect(play(SEQUENCE).join("\n")).toBe(play(SEQUENCE).join("\n"));
  });

  // The driven-sequence golden an earlier release promised and never committed.
  it("composes byte for byte through the key queue", () => {
    const golden = readFileSync(
      new URL("../golden/keys-driven.out", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(play(SEQUENCE).join("\n")).toBe(golden);
  });
});
