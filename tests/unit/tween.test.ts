// An earlier release — tweens and easings (docs/engine.md §11).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ease, EASING_NAMES, isEasingName } from "../../src/choreo/easing.js";
import { createTweenStore, readTween, resetTween } from "../../src/choreo/tween.js";
import { parse } from "../../src/parser/parser.js";
import { SceneProgram, runQbsk } from "../../src/interp/interpreter.js";

describe("easing curves are pure and land exactly", () => {
  // The one property every curve must have: an animation starts where it was told
  // and lands where it was told. Without this, `to:` is a suggestion.
  it.each(EASING_NAMES)("%s: f(0) = 0 and f(1) = 1 exactly", (name) => {
    expect(ease(name, 0)).toBe(0);
    expect(ease(name, 1)).toBe(1);
  });

  it.each(EASING_NAMES)("%s is pure: same input, same output", (name) => {
    for (const t of [0.13, 0.5, 0.77]) {
      expect(ease(name, t)).toBe(ease(name, t));
    }
  });

  it("clamps out-of-range t instead of extrapolating into nonsense", () => {
    expect(ease("linear", -5)).toBe(0);
    expect(ease("linear", 42)).toBe(1);
  });

  // Tested at real points on the curve, not only at the endpoints — endpoints alone
  // would pass even if every curve secretly were linear.
  it("ease-out is ahead of linear at the halfway point, ease-in behind", () => {
    expect(ease("ease-out", 0.5)).toBeGreaterThan(0.5);
    expect(ease("ease-in", 0.5)).toBeLessThan(0.5);
    expect(ease("linear", 0.5)).toBe(0.5);
  });

  it("bounce and elastic are allowed to overshoot mid-flight — that IS the effect", () => {
    const samples = Array.from({ length: 99 }, (_, i) => ease("elastic", (i + 1) / 100));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });

  it("rejects unknown easing names", () => {
    expect(isEasingName("linear")).toBe(true);
    expect(isEasingName("ease-in-out")).toBe(true);
    expect(isEasingName("swoosh")).toBe(false);
  });
});

describe("tweens are a pure function of (gameTime, recorded start)", () => {
  it("reading the same tween twice at the same time gives the same number", () => {
    const store = createTweenStore();
    const q = { store, name: "x", from: 0, to: 100, duration: 2, easing: "linear", now: 0.7 };
    // The scene block re-runs every frame, so a tween is read many times per frame.
    expect(readTween(q).value).toBe(readTween(q).value);
  });

  it("re-declaring with identical parameters CONTINUES rather than restarting", () => {
    const store = createTweenStore();
    const base = { store, name: "x", from: 0, to: 100, duration: 2, easing: "linear" };
    readTween({ ...base, now: 0 });
    // 60 more reads, as a running scene would do, then check the clock still rules.
    for (let i = 1; i <= 60; i += 1) {
      readTween({ ...base, now: i / 60 });
    }
    expect(readTween({ ...base, now: 1 }).value).toBeCloseTo(50, 6);
  });

  it("changing a parameter restarts the tween from now", () => {
    const store = createTweenStore();
    readTween({ store, name: "x", from: 0, to: 100, duration: 2, easing: "linear", now: 0 });
    const after = readTween({
      store, name: "x", from: 0, to: 50, duration: 2, easing: "linear", now: 1,
    });
    expect(after.value).toBe(0);
    expect(after.progress).toBe(0);
  });

  it("holds its final value past the end instead of overshooting", () => {
    const store = createTweenStore();
    const q = { store, name: "x", from: 0, to: 10, duration: 1, easing: "linear" };
    readTween({ ...q, now: 0 });
    expect(readTween({ ...q, now: 5 }).value).toBe(10);
    expect(readTween({ ...q, now: 5 }).done).toBe(true);
  });

  it("a zero duration is a jump, not a division by zero", () => {
    const store = createTweenStore();
    const r = readTween({ store, name: "x", from: 3, to: 9, duration: 0, easing: "linear", now: 0 });
    expect(r.value).toBe(9);
    expect(Number.isFinite(r.value)).toBe(true);
  });

  it("an unknown easing falls back to linear rather than throwing mid-frame", () => {
    const store = createTweenStore();
    const q = { store, name: "x", from: 0, to: 10, duration: 1, easing: "nope" };
    readTween({ ...q, now: 0 }); // the first read is what starts the clock
    expect(readTween({ ...q, now: 0.5 }).value).toBe(5);
  });

  it("reset makes the next read start over", () => {
    const store = createTweenStore();
    const q = { store, name: "x", from: 0, to: 10, duration: 1, easing: "linear" };
    readTween({ ...q, now: 0 });
    expect(readTween({ ...q, now: 0.5 }).value).toBe(5);
    expect(resetTween(store, "x")).toBe(true);
    expect(readTween({ ...q, now: 0.5 }).value).toBe(0);
  });
});

describe("the animate native (docs/engine.md §11)", () => {
  const SCENE = `scene T(width: 20, height: 3)
layer a z: 1
    fill "."
    put "o" at (round(animate("x", 1.0, 15.0, 1.0, "linear")), 1)
`;

  function drive(frames: number, dt: number): string[] {
    const program = new SceneProgram(parse(SCENE, "t.qbsk").ast);
    const out: string[] = [];
    for (let i = 0; i < frames; i += 1) {
      const f = program.step(dt);
      expect(f.error).toBeNull();
      out.push(f.canvas!.renderText().split("\n")[1]!);
    }
    return out;
  }

  // Criterion 4: a tween produces floats, the canvas takes integer cells. The scene
  // must round EXPLICITLY with int(...) — RULE #4 keeps int and float distinct, and
  // a tween is not allowed to smuggle a silent truncation past it.
  it("returns a float, so the scene has to round on purpose", () => {
    const r = runQbsk(`print(type(animate("x", 0.0, 1.0, 1.0)))`, "t.qbsk");
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["float"]);
  });

  it("a float coordinate is still an error — the tween did not weaken RULE #4", () => {
    const r = runQbsk(
      `var c = canvas(10, 3)\nput(c, "o", animate("x", 0.0, 5.0, 1.0), 1)`,
      "t.qbsk",
    );
    expect(r.error).not.toBeNull();
  });

  it("rejects an unknown easing with a span, naming the ones that exist", () => {
    const r = runQbsk(`print(animate("x", 0.0, 1.0, 1.0, "swoosh"))`, "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("swoosh");
    expect(r.error!.message).toContain("linear");
  });

  // These two natives gate every pacing loop in the examples (jail.qbsk's pace,
  // awakening.qbsk's patrol, lighting.qbsk's torch swing), so a regression here
  // breaks real scenes — the two are driven through the interpreter below with a
  // real game clock, not just through the pure store.
  it("animate_done is false before the tween ends and true after", () => {
    const src = `scene T(width: 20, height: 2)
var y = animate("x", 0.0, 10.0, 1.0, "linear")
on tick(dt)
    print("done:" + str(animate_done("x")))
`;
    const out: string[] = [];
    const program = new SceneProgram(parse(src, "t.qbsk").ast, {
      print: (line) => out.push(line),
    });
    for (let i = 0; i < 12; i += 1) {
      const f = program.step(0.1);
      expect(f.error).toBeNull();
    }
    // The tween spans gameTime 0..1; 10 steps of 0.1 s end exactly at 1.0, so the
    // final step reports done — the same boundary readTween uses.
    expect(out.slice(0, 9).every((line) => line === "done:false")).toBe(true);
    expect(out[9]).toBe("done:false");
    expect(out[10]).toBe("done:true");
    expect(out[11]).toBe("done:true");
  });

  it("animate_done on a name that was never declared is false, not an error", () => {
    const r = runQbsk(`print(animate_done("ghost"))`, "t.qbsk");
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["false"]);
  });

  it("animate_reset restarts the tween from the beginning", () => {
    const src = `scene T(width: 20, height: 2)
var y = animate("x", 0.0, 10.0, 1.0, "linear")
on tick(dt)
    print(int(animate("x", 0.0, 10.0, 1.0, "linear")))
`;
    const out: string[] = [];
    const program = new SceneProgram(parse(src, "t.qbsk").ast, {
      print: (line) => out.push(line),
    });
    // 5 steps of 0.1 s: gameTime 0.5, value 5.
    for (let i = 0; i < 5; i += 1) program.step(0.1);
    expect(out[4]).toBe("5");
    const r = runQbsk(`print(animate_reset("x"))`, "t.qbsk");
    // A one-shot run has its own interpreter: it cannot see the program's tween
    // store, so reset returns false there. The restart is tested below in-process.
    expect(r.error).toBeNull();
  });

  it("animate_reset in-process: the next read starts over", () => {
    const src = `scene T(width: 20, height: 2)
var y = animate("x", 0.0, 10.0, 1.0, "linear")
`;
    const program = new SceneProgram(parse(src, "t.qbsk").ast);
    program.step(0.5); // gameTime 0.5 → value 5
    // The snippet's expression value is read, not its print output: a snippet runs
    // in the live environment, whose `print` native belongs to the host program.
    const mid = program.evalSnippet(`int(animate("x", 0.0, 10.0, 1.0, "linear"))`, "s.qbsk");
    expect(mid.error).toBeNull();
    expect(mid.value).toEqual({ type: "int", value: 5 });
    const reset = program.evalSnippet(`animate_reset("x")`, "s.qbsk");
    expect(reset.error).toBeNull();
    expect(reset.value).toEqual({ type: "bool", value: true });
    const after = program.evalSnippet(`int(animate("x", 0.0, 10.0, 1.0, "linear"))`, "s.qbsk");
    expect(after.error).toBeNull();
    expect(after.value).toEqual({ type: "int", value: 0 });
  });

  it("animate_reset on a name that was never declared is false, not an error", () => {
    const r = runQbsk(`print(animate_reset("ghost"))`, "t.qbsk");
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["false"]);
  });

  it("animate_done and animate_reset type errors carry a span", () => {
    for (const bad of [`print(animate_done(5))`, `print(animate_reset(true))`]) {
      const r = runQbsk(bad, "t.qbsk");
      expect(r.error).not.toBeNull();
      expect(r.error!.span.file).toBe("t.qbsk");
    }
  });

  it("animate_done and animate_reset arity errors carry a span", () => {
    for (const bad of [`print(animate_done())`, `print(animate_reset("a", "b"))`]) {
      const r = runQbsk(bad, "t.qbsk");
      expect(r.error).not.toBeNull();
      expect(r.error!.span.file).toBe("t.qbsk");
    }
  });

  it("animates over frames, and the motion is deterministic", () => {
    const a = drive(10, 0.1);
    const b = drive(10, 0.1);
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(a[9]);
  });

  // The clock lives in SceneProgram.step now. If a host ALSO advanced it, the
  // animation would run at DOUBLE speed — this is the test that would catch that.
  //
  // Compared at mid-flight, not at the endpoint. gameTime accumulates dt as a
  // float, so 10 x 0.1 = 0.9999999999999999 while 20 x 0.05 = 1.0000000000000002.
  // The 3e-16 gap is meaningless as time, but exactly at a tween's final instant it
  // decides which side of an int() boundary the value lands on. Frame-exact
  // equality across different frame rates is therefore only guaranteed away from
  // those boundaries — documented in docs/engine.md §11 rather than papered over.
  it("the same game time gives the same frame regardless of frame rate", () => {
    const slow = drive(10, 0.1); // 10 fps
    const fast = drive(20, 0.05); // 20 fps
    expect(fast[9]).toBe(slow[4]); // both at gameTime 0.5
    expect(fast[5]).toBe(slow[2]); // both at gameTime 0.3
    expect(fast[3]).toBe(slow[1]); // both at gameTime 0.2
    // Double-speed would show up as the fast run being far ahead, not one cell.
    expect(fast[19]).not.toBe(fast[9]);
  });
});

// Criterion 5: goldens for INTERMEDIATE animation frames. Tweens are deterministic
// functions of game time, so the frames are too — which is the whole reason this
// can be byte-exact rather than approximate.
describe("tween goldens (docs/engine.md §11)", () => {
  it("examples/tweens.qbsk at frame 38 matches its golden byte for byte", () => {
    const src = readFileSync(
      new URL("../../examples/tweens.qbsk", import.meta.url),
      "utf8",
    );
    const golden = readFileSync(
      new URL("../golden/tweens-frame38.out", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const program = new SceneProgram(parse(src, "tweens.qbsk").ast);
    let frame = program.step(1 / 30);
    for (let i = 1; i < 38; i += 1) {
      frame = program.step(1 / 30);
    }
    expect(frame.error).toBeNull();
    expect(frame.canvas!.renderText()).toBe(golden);
  });

  it("the same frame reached at a different frame rate is the same bytes", () => {
    const src = readFileSync(
      new URL("../../examples/tweens.qbsk", import.meta.url),
      "utf8",
    );
    const at = (steps: number, dt: number): string => {
      const p = new SceneProgram(parse(src, "tweens.qbsk").ast);
      let f = p.step(dt);
      for (let i = 1; i < steps; i += 1) f = p.step(dt);
      return f.canvas!.renderText();
    };
    // 30 fps for 1s vs 60 fps for 1s.
    expect(at(60, 1 / 60)).toBe(at(30, 1 / 30));
  });
});
