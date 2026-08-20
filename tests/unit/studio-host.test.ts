import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readScene, runStaticScene, StudioFrameHost } from "../../studio/main/host.js";
import { keyFromDom } from "../../src/engine/keys.js";

// an earlier release, criterion 5, headless: a QBSK file renders through the Studio host
// exactly as the terminal renders it, and the host reuses src/engine/diff.ts
// (docs/studio.md §4/§7). No Electron is involved — host.ts is pure.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hello = resolve(root, "examples", "hello.qbsk");
const bounce = resolve(root, "examples", "bounce.qbsk");

const golden = (name: string): string =>
  readFileSync(new URL(`../golden/${name}.out`, import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );

describe("studio host: a QBSK scene reaches the grid (docs/studio.md §4)", () => {
  it("hello.qbsk renders byte-identical to the terminal golden", () => {
    const source = readFileSync(hello, "utf8");
    const res = runStaticScene(source, hello);
    expect(res.ok).toBe(true);
    expect(res.width).toBe(80);
    expect(res.height).toBe(24);
    expect(res.text.join("\n")).toBe(golden("hello.qbsk"));
  });

  it("the host diff comes from computeDiff and reports real changed cells", () => {
    const source = readFileSync(hello, "utf8");
    const res = runStaticScene(source, hello);
    const changed = res.diff.reduce((acc, d) => acc + d.changed, 0);
    expect(changed).toBe(res.cells);
    expect(res.cells).toBeGreaterThan(0);
    expect(res.ansi.length).toBeGreaterThan(0);
  });

  it("every changed cell carries a packed RGB or -1 (ANSI and CSS agree)", () => {
    const source = readFileSync(hello, "utf8");
    const res = runStaticScene(source, hello);
    for (const line of res.diff) {
      for (const run of line.runs) {
        for (const cell of run.cells) {
          expect(cell.fg).toBeGreaterThanOrEqual(-1);
          expect(cell.bg).toBeGreaterThanOrEqual(-1);
        }
      }
    }
  });

  it("a parse error crosses the boundary as formatted text with a span", () => {
    const res = runStaticScene("scene X(width: 10)\n  layer", hello);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("syntax");
    expect(res.error).toContain(hello);
  });

  it("frame host: bounce.qbsk animates and a repeated frame emits 0 changed cells", () => {
    const source = readFileSync(bounce, "utf8");
    const host = new StudioFrameHost(source, bounce);
    expect(host.error).toBeNull();

    const f1 = host.next(1 / 30);
    expect(f1).not.toBeNull();
    expect(f1!.metrics.cells).toBeGreaterThan(0);
    const firstText = f1!.text.join("\n");

    // Same clock value -> identical frame -> empty diff (double buffer + diffing).
    const f2 = host.next(1 / 30);
    expect(f2).not.toBeNull();
    expect(f2!.metrics.cells).toBe(0);
    expect(f2!.text.join("\n")).toBe(firstText);

    // The clock advances, so the ball eventually moves.
    let moved = false;
    for (let i = 0; i < 30; i += 1) {
      const f = host.next(1 / 30);
      if (f !== null && f.text.join("\n") !== firstText) {
        moved = true;
        break;
      }
    }
    expect(moved).toBe(true);
  });

  it("frame host: a var mutated in on tick persists across frames (an earlier release)", () => {
    const source = [
      "var n = 0",
      "on tick(dt)",
      "    n += 1",
      "scene P(width: n + 3, height: 3)",
      "  layer l z: 1",
      "    fill \".\"",
    ].join("\n");
    const host = new StudioFrameHost(source, "persist.qbsk");
    expect(host.error).toBeNull();

    const f1 = host.next(1 / 30);
    expect(f1).not.toBeNull();
    expect(f1!.width).toBe(4); // n=1
    const f2 = host.next(1 / 30);
    expect(f2).not.toBeNull();
    expect(f2!.width).toBe(5); // n=2 — the mutation survived the frame boundary
  });
});

describe("StudioFrameHost key input (docs/studio.md §14.5)", () => {
  const KEYS = [
    "var x = 0",
    'on key "arrow-right"',
    "    x += 1",
    'on key "arrow-left"',
    "    x -= 1",
    'on key "a"',
    "    x += 10",
    "scene P(width: 12, height: 3)",
    "  layer l z: 1",
    '    fill "."',
    '    put "@" at (x, 1)',
  ].join("\n");

  const at = (frame: { text: string[] } | null): number =>
    frame!.text[1]!.indexOf("@");

  it("a pressed key moves the program in the SAME frame it is pressed", () => {
    // Keys drain inside step(), after tick handlers and before composition
    // (docs/language.md §7.7), so a press does not lag a frame behind.
    const host = new StudioFrameHost(KEYS, "k.qbsk");
    expect(host.error).toBeNull();
    expect(at(host.next(1 / 60))).toBe(0);

    host.pressKey("arrow-right");
    expect(at(host.next(1 / 60))).toBe(1);
  });

  it("presses queued between frames all land, in order, coalesced per key", () => {
    // This used to assert 3 rights + 1 left = 2, when every queued press dispatched.
    // Since docs/engine.md §8.3 a repeated key dispatches ONCE per frame, so the same
    // burst is one right and one left — net zero. What the test still proves is that
    // both distinct keys landed and that order was preserved.
    const host = new StudioFrameHost(KEYS, "k.qbsk");
    host.next(1 / 60);
    host.pressKey("arrow-right");
    host.pressKey("arrow-right");
    host.pressKey("arrow-right");
    host.pressKey("arrow-left");
    expect(at(host.next(1 / 60))).toBe(0);

    // And a key held across frames keeps moving, one step per frame.
    host.pressKey("arrow-right");
    expect(at(host.next(1 / 60))).toBe(1);
    host.pressKey("arrow-right");
    expect(at(host.next(1 / 60))).toBe(2);
  });

  it("a key with no handler is harmless", () => {
    const host = new StudioFrameHost(KEYS, "k.qbsk");
    host.next(1 / 60);
    host.pressKey("page-up");
    expect(host.error).toBeNull();
    expect(at(host.next(1 / 60))).toBe(0);
  });

  // The whole point of the vocabulary: two hosts must not disagree on spelling.
  it("takes the name a DOM key decodes to, end to end", () => {
    const host = new StudioFrameHost(KEYS, "k.qbsk");
    host.next(1 / 60);
    host.pressKey(keyFromDom("ArrowRight")!);
    host.pressKey(keyFromDom("a")!);
    expect(at(host.next(1 / 60))).toBe(11);
  });

  it("pressing before the first frame is not lost", () => {
    const host = new StudioFrameHost(KEYS, "k.qbsk");
    host.pressKey("arrow-right");
    expect(at(host.next(1 / 60))).toBe(1);
  });

  it("a host whose program failed to parse ignores keys instead of throwing", () => {
    const host = new StudioFrameHost("scene ((", "bad.qbsk");
    expect(host.error).not.toBeNull();
    expect(() => host.pressKey("a")).not.toThrow();
  });
});

describe("the console scene, byte by byte (docs/studio.md §14.3)", () => {
  // The console is a QBSK scene, so it is golden-testable exactly like any other —
  // which is one of the reasons for drawing it with the engine instead of in CSS.
  //
  // The clock is fixed and the host data is fixed, so this pins the LAYOUT: the frame,
  // where scrollback starts, where the prompt sits, where the caret lands after the
  // text you typed. A change to any of those is a deliberate act, and this is what
  // makes it one.
  const golden = readFileSync(
    new URL("../golden/console.qbsk.out", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");

  const HOST = {
    lines: [
      "QBSK engine console - type help",
      "Nothing is running yet - press Run to start a program.",
      "> vars",
      "cam  playerX  score",
    ],
    input: "get playerX",
    cursor: 11,
    ready: true,
    sound: null,
  };

  const render = (): string[] => {
    const source = readFileSync(
      new URL("../../examples/console.qbsk", import.meta.url),
      "utf8",
    );
    const host = new StudioFrameHost(source, "examples/console.qbsk");
    expect(host.error).toBeNull();
    host.setHostData(HOST);
    let frame = null;
    // Two frames: the caret blinks off the game clock, and the golden is taken at a
    // point where it is on. Pinning a blink is the point — it proves the blink is a
    // function of time and not of luck.
    for (let i = 0; i < 2; i += 1) {
      frame = host.next(1 / 30);
    }
    expect(frame).not.toBeNull();
    return frame!.text;
  };

  it("composes byte for byte", () => {
    expect(render().join("\n")).toBe(golden);
  });

  it("puts the caret right after what you typed", () => {
    const rows = render();
    // Prompt is "> " at column 2, so the text starts at 4 and the caret follows it.
    expect(rows[23]!.slice(2, 4)).toBe("> ");
    expect(rows[23]![4 + HOST.cursor]).toBe("_");
  });

  it("the same host data and clock always give the same frame", () => {
    expect(render().join("\n")).toBe(render().join("\n"));
  });

  it("different host data gives a different frame — the path actually carries", () => {
    const source = readFileSync(
      new URL("../../examples/console.qbsk", import.meta.url),
      "utf8",
    );
    const host = new StudioFrameHost(source, "examples/console.qbsk");
    // The cursor goes to the END of the new text: leaving it at 11 would drop the
    // caret in the middle of the string and split it, which is correct behaviour and
    // a broken assertion.
    const input = "something else entirely";
    host.setHostData({ ...HOST, input, cursor: input.length });
    host.next(1 / 30);
    const other = host.next(1 / 30)!.text.join("\n");
    expect(other).not.toBe(golden);
    expect(other).toContain("something else entirely");
  });
});

describe("StudioFrameHost varNames filtering (host.ts:157-166)", () => {
  it("varNames filters out natives, only returns scene-defined names", () => {
    const source = `scene T(width: 10, height: 2)
var playerX = 5
const score = 42
func double(x)
    return x * 2
layer L z: 1
    fill "."
    put "@" at (playerX, 1)
`;
    const host = new StudioFrameHost(source, "test.qbsk");
    // First step to populate the live env
    host.next(1 / 60);
    const names = host.varNames();
    // Scene name "T" is a const, func "double", var "playerX", const "score"
    // Natives (print, len, etc.) are filtered out
    expect(names).toEqual(["T", "double", "playerX", "score"]);
  });

  it("varNames returns empty array when no program loaded", () => {
    const host = new StudioFrameHost("", "test.qbsk");
    const names = host.varNames();
    expect(names).toEqual([]);
  });
});

// The Open toolbar button (commit 6a1e930) was wired to a real dialog -> read -> editor
// path but shipped with zero tests: the dialog itself needs Electron, but the read +
// failure handling this pulls apart from it does not (docs/studio.md's own convention
// for host.ts). Pinned here so a regression in the read path — the thing a real Open
// click actually exercises after the dialog resolves a path — fails a test instead of
// only ever being caught by clicking the button.
describe("readScene (the Open button's read path, docs/studio.md host.ts convention)", () => {
  it("reads an existing scene file and returns it with its path", () => {
    const result = readScene(hello);
    expect(result).not.toBeNull();
    expect(result!.file).toBe(hello);
    expect(result!.source).toBe(readFileSync(hello, "utf8"));
  });

  it("a file that does not exist returns null, not a thrown error", () => {
    const missing = resolve(root, "examples", "does-not-exist.qbsk");
    expect(readScene(missing)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The font picker's cell shape survives the trip (F0 criterion 4b).
//
// The value crosses five files — renderer, preload, main, host, interpreter — and every
// hop is a place it can be accepted and dropped, which is invariant I2 and this project's
// first anti-pattern. `studio-play.test.ts` pins the arithmetic that produces it; this
// pins that a program run through the HOST actually draws differently because of it.
//
// A hand-traced chain is not evidence. This is the assertion that fails if a later edit
// adds a parameter to one signature and forgets the next.
// ---------------------------------------------------------------------------

describe("the cell shape reaches the scene the host runs (F0 §11.16)", () => {
  /**
   * A scene whose only content is one stroked diagonal in the disagreement band.
   *
   * 5/17 = 0.2941, and the rule is that `cellAspect * slope < 0.5668` reads horizontal —
   * so 2.0 calls it diagonal (0.588) and Studio's 1.92 calls it horizontal (0.564). The
   * band between those two cells is 0.2834 to 0.2957, narrow enough that the coordinates
   * have to be chosen rather than guessed: `(10, 2.9)` looks like it lands inside it and
   * does not, because a line's endpoints are grid cells and the 2.9 floors to 2, putting
   * the real slope at 0.2. That version of this test passed while asserting nothing.
   */
  const source = [
    "scene S(width: 20, height: 8)",
    "layer l z: 0",
    '    fill "."',
    "    line (0, 0) to (17, 5) style: stroke",
  ].join("\n");

  it("draws the same line differently under a different font's cell", () => {
    const flat = runStaticScene(source, resolve(root, "t.qbsk"), 2.0);
    const wide = runStaticScene(source, resolve(root, "t.qbsk"), 1.15 / 0.6);
    expect(flat.ok, flat.error ?? "").toBe(true);
    expect(wide.ok, wide.error ?? "").toBe(true);
    expect(wide.text).not.toEqual(flat.text);
  });

  it("keeps the engine's 2.0 when no aspect is sent", () => {
    // Absent must mean the documented default and not "whatever was last used": every
    // golden in the repo was produced without an aspect.
    const bare = runStaticScene(source, resolve(root, "t.qbsk"));
    const flat = runStaticScene(source, resolve(root, "t.qbsk"), 2.0);
    expect(bare.text).toEqual(flat.text);
  });

  it("carries the same shape into a LIVE program, not only a static run", () => {
    // Two separate paths into `SceneProgram` — `runStaticScene` and `StudioFrameHost` —
    // and the second is the one the window actually uses for anything animated.
    const flat = new StudioFrameHost(source, resolve(root, "t.qbsk"), 2.0);
    const wide = new StudioFrameHost(source, resolve(root, "t.qbsk"), 1.15 / 0.6);
    expect(flat.error).toBeNull();
    expect(wide.error).toBeNull();
    expect(wide.next(0.05)!.text).not.toEqual(flat.next(0.05)!.text);
  });
});
