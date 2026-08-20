import type { Span } from "../lexer/token.js";
import { Canvas } from "../engine/canvas.js";
import { cellOf } from "../engine/cell.js";
import { Env } from "./env.js";
import { QbskRuntimeError } from "./error.js";
import { closest } from "../util/suggest.js";
import { qbskEq, qbskStr, truthy, typeName, type QValue } from "./value.js";
import { serializeState } from "./saveState.js";
import { loadQbdata } from "../parser/qbdata.js";
import { mulberry32 } from "../util/random.js";
import {
  createTweenStore,
  readTween,
  resetTween,
  tweenDone,
  type TweenStore,
} from "../choreo/tween.js";
import { EASING_NAMES, isEasingName } from "../choreo/easing.js";
import { DENSITY_RAMP, intensityFromDepth, rampGlyph } from "../engine/ramp.js";
import { looksHex, NAMED_COLORS, resolveColor } from "../engine/color.js";
import { plotBrailleDot, plotHalf } from "../engine/subcell.js";
import { strokeGlyph, DEFAULT_CELL_ASPECT } from "../engine/stroke.js";
import { findPath } from "../engine/path.js";
import { computeVisible } from "../engine/fov.js";
import {
  particleAt,
  resolveParticleSpec,
  type ParticleSpec,
} from "../engine/particles.js";
import {
  project as project3d,
  DEFAULT_ASPECT,
  type Camera,
  type Vec3,
} from "../choreo/project.js";
import { castColumns, type RayCamera } from "../choreo/raycast.js";
import {
  activeAt,
  duration as stepDuration,
  parallel as tlParallel,
  sequence as tlSequence,
  step as tlStep,
  wait as tlWait,
  type Step,
} from "../choreo/timeline.js";

export class ExitSignal {
  constructor(public readonly code: number) {}
}

export interface HostIO {
  print(line: string): void;
}

/**
 * Where saves live (docs/language.md §13.5). The natives never touch the file
 * system: the host provides this, exactly as `print` goes through HostIO. A program
 * names a SLOT; where it lives — disk, memory, nowhere — is the host's business.
 */
export interface SaveStore {
  /** The slot's `.qbdata` text, or null if the slot does not exist. */
  read(slot: string): string | null;
  write(slot: string, text: string): void;
  /** Sorted slot names; [] when there are none. */
  list(): string[];
}

// Shared state between the frame loop and the interpreter: the game clock
// (spec language.md §7.6). The loop mutates it each frame; tick() reads it.
export interface GameRuntime {
  gameTime: number;
  /**
   * Live tweens (docs/engine.md §11). Host-side ON PURPOSE: keeping the start time
   * out of the interpreter is what makes a tween a pure function of
   * (gameTime, start), so re-composing the scene many times in one frame always
   * yields the same number and goldens stay byte-exact.
   */
  tweens?: TweenStore;
  /**
   * Data the host hands the program (docs/studio.md §14.6), read with `host(key)`.
   *
   * ONE DIRECTION, and that is the whole design: the host puts values here before a
   * step, the program reads them during it, and the program has no way to write back
   * or to call out of the sandbox. A console can therefore be a QBSK scene that draws
   * text the engine produced, without the scene gaining the ability to reach the
   * outside world.
   *
   * Determinism survives (docs/language.md §7.7) because the values are fixed before
   * the step: the same data and the same clock still produce byte-identical frames.
   */
  host?: Record<string, HostValue>;
  /**
   * The simulation clock and the entity id counter (docs/engine.md §12).
   *
   * Host-side for the same reason tweens are: keeping it out of the interpreter is
   * what lets a turn be a fixed point in the frame rather than a number a program
   * increments whenever it likes. Created lazily, so a program that never mentions
   * turns pays nothing for them.
   */
  sim?: SimState;
}

/** Turn number, turns requested but not yet run, and the next entity id. */
export interface SimState {
  turn: number;
  pending: number;
  nextId: number;
}

/** What a host may hand a program. Plain JS values — the native does the conversion. */
export type HostValue = string | number | boolean | string[] | null;

export interface NativeOptions {
  scriptArgs?: string[];
  runtime?: GameRuntime;
  // Interpreter bridge: lets higher-order natives (map/filter/
  // reduce) call QBSK functions and other natives. Provided by the Interpreter.
  call?: (fn: QValue, args: QValue[], span: Span) => QValue;
  // Save storage (docs/language.md §13.5). Absent = this host has no save storage,
  // and save_state/list_saves say so honestly instead of no-opping.
  saveStore?: SaveStore;
  /**
   * The cell's height over its width (§11.16), for the natives that measure an angle.
   *
   * Absent means `DEFAULT_CELL_ASPECT`, exactly as it does everywhere else. This exists
   * because `stroke_glyph` was the last place in the category still assuming 2.0 while
   * `line ... style: stroke` — the same feature's other documented form — was already
   * taking the program's real number. One feature answering two ways is worse than both
   * being wrong the same way.
   */
  cellAspect?: number;
}

/** Fallback sim state for a program with no runtime — coherent, just never stepped. */
const orphanSim: SimState = { turn: 0, pending: 0, nextId: 1 };

export function createNatives(io: HostIO, opts: NativeOptions = {}): Env {
  const env = new Env(null);
  const cellAspect = opts.cellAspect ?? DEFAULT_CELL_ASPECT;

  const native = (
    name: string,
    fn: (args: QValue[], span: Span) => QValue,
  ): void => {
    env.define(name, { type: "native", name, fn }, "native");
  };

  const expectArgs = (
    name: string,
    args: QValue[],
    count: number,
    span: Span,
  ): void => {
    if (args.length !== count) {
      throw new QbskRuntimeError(
        `function '${name}' expects ${count} arguments, got ${args.length}`,
        span,
      );
    }
  };

  const expectCanvas = (
    name: string,
    v: QValue,
    span: Span,
  ): { type: "canvas"; canvas: Canvas } => {
    if (v.type !== "canvas") {
      throw new QbskRuntimeError(
        `'${name}' expects a canvas (canvas(w, h)), got '${typeName(v)}'`,
        span,
      );
    }
    return v;
  };

  const expectInt = (name: string, v: QValue, span: Span): number => {
    if (v.type !== "int") {
      throw new QbskRuntimeError(
        `'${name}' expects an int, got '${typeName(v)}'`,
        span,
      );
    }
    return v.value;
  };

  const expectStr = (name: string, v: QValue, span: Span): string => {
    if (v.type !== "str") {
      throw new QbskRuntimeError(
        `'${name}' expects a string, got '${typeName(v)}'`,
        span,
      );
    }
    return v.value;
  };

  const expectChar = (name: string, v: QValue, span: Span): string => {
    const s = expectStr(name, v, span);
    if (s.length !== 1) {
      throw new QbskRuntimeError(
        `'${name}' expects a single character, got ${s.length}`,
        span,
      );
    }
    return s;
  };

  const expectPoint = (name: string, v: QValue, span: Span): [number, number] => {
    if (v.type !== "tuple") {
      throw new QbskRuntimeError(
        `'${name}' expects a coordinate (x, y), got '${typeName(v)}'`,
        span,
      );
    }
    if (v.x.type !== "int" || v.y.type !== "int") {
      throw new QbskRuntimeError(
        `'${name}' expects integers in the coordinate (int, int)`,
        span,
      );
    }
    return [v.x.value, v.y.value];
  };

  const expectList = (
    name: string,
    v: QValue,
    span: Span,
  ): { type: "list"; items: QValue[] } => {
    if (v.type !== "list") {
      throw new QbskRuntimeError(
        `'${name}' expects a list, got '${typeName(v)}'`,
        span,
      );
    }
    return v;
  };

  const expectDict = (
    name: string,
    v: QValue,
    span: Span,
  ): { type: "dict"; map: Map<string, QValue> } => {
    if (v.type !== "dict") {
      throw new QbskRuntimeError(
        `'${name}' expects a dict, got '${typeName(v)}'`,
        span,
      );
    }
    return v;
  };

  const expectCallable = (name: string, v: QValue, span: Span): QValue => {
    if (v.type !== "func" && v.type !== "native") {
      throw new QbskRuntimeError(
        `'${name}' expects a function, got '${typeName(v)}'`,
        span,
      );
    }
    return v;
  };

  const invoke = (name: string, fn: QValue, args: QValue[], span: Span): QValue => {
    if (opts.call === undefined) {
      throw new QbskRuntimeError(
        `'${name}' cannot call the function without an interpreter`,
        span,
      );
    }
    return opts.call(fn, args, span);
  };

  native("canvas", (args, span) => {
    expectArgs("canvas", args, 2, span);
    const w = expectInt("canvas", args[0]!, span);
    const h = expectInt("canvas", args[1]!, span);
    if (w < 1 || h < 1) {
      throw new QbskRuntimeError(
        "canvas() expects width and height >= 1",
        span,
      );
    }
    return { type: "canvas", canvas: new Canvas(w, h) };
  });

  native("fill", (args, span) => {
    expectArgs("fill", args, 2, span);
    const c = expectCanvas("fill", args[0]!, span);
    c.canvas.fill(expectChar("fill", args[1]!, span));
    return { type: "null" };
  });

  native("box", (args, span) => {
    expectArgs("box", args, 4, span);
    const c = expectCanvas("box", args[0]!, span);
    const [x1, y1] = expectPoint("box", args[1]!, span);
    const [x2, y2] = expectPoint("box", args[2]!, span);
    c.canvas.border(x1, y1, x2, y2, cellOf(expectChar("box", args[3]!, span)));
    return { type: "null" };
  });

  native("put", (args, span) => {
    expectArgs("put", args, 3, span);
    const c = expectCanvas("put", args[0]!, span);
    const text = expectStr("put", args[1]!, span);
    if (text.includes("\n")) {
      throw new QbskRuntimeError(
        "'put' expects single-line text",
        span,
      );
    }
    const [x, y] = expectPoint("put", args[2]!, span);
    c.canvas.text(x, y, text);
    return { type: "null" };
  });

  native("line", (args, span) => {
    expectArgs("line", args, 4, span);
    const c = expectCanvas("line", args[0]!, span);
    const [x1, y1] = expectPoint("line", args[1]!, span);
    const [x2, y2] = expectPoint("line", args[2]!, span);
    c.canvas.line(x1, y1, x2, y2, cellOf(expectChar("line", args[3]!, span)));
    return { type: "null" };
  });

  // Subcell resolution (docs/engine.md §11.14). A cell is one wide and two tall, so
  // halving it vertically makes each subpixel square — that is the whole visual win,
  // and it is why `plot`'s y runs over 2h rather than h.
  native("plot", (args, span) => {
    expectArgs("plot", args, 3, span);
    const c = expectCanvas("plot", args[0]!, span);
    const [x, y] = expectPoint("plot", args[1]!, span);
    const name = expectStr("plot", args[2]!, span);
    const colour = resolveColor(name);
    if (colour === null) {
      if (looksHex(name)) {
        throw new QbskRuntimeError(
          `'${name}' is not a colour — a truecolor literal is #rrggbb, six hexadecimal digits`,
          span,
        );
      }
      const near = closest(name, Object.keys(NAMED_COLORS));
      throw new QbskRuntimeError(
        `unknown color '${name}'` + (near !== null ? ` — did you mean '${near}'?` : ""),
        span,
      );
    }
    // Off-grid clips rather than throwing, as the canvas itself does.
    const row = Math.floor(y / 2);
    if (x < 0 || row < 0 || x >= c.canvas.width || row >= c.canvas.height) {
      return { type: "null" };
    }
    const index = row * c.canvas.width + x;
    const half: 0 | 1 = (y % 2 === 0 ? 0 : 1);
    c.canvas.cells[index] = plotHalf(c.canvas.cells[index]!, half, colour);
    return { type: "null" };
  });

  // Orientation glyphs (docs/engine.md §11.16). A ramp says how MUCH ink a cell holds;
  // this says which way it runs. The cell's shape is corrected inside, so the caller
  // passes grid deltas and gets the glyph the reader will actually perceive.
  //
  // The shape is the PROGRAM'S, not a constant: `line ... style: stroke` has taken it
  // since F0 and this native had not, so the two documented forms of one feature
  // disagreed as soon as Studio began sending a real font's cell.
  native("stroke_glyph", (args, span) => {
    expectArgs("stroke_glyph", args, 2, span);
    const dx = expectNum("stroke_glyph", args[0]!, span).value;
    const dy = expectNum("stroke_glyph", args[1]!, span).value;
    return { type: "str", value: strokeGlyph(dx, dy, cellAspect) };
  });

  // Braille trades colour for density: 2 x 4 dots per cell, one foreground between them.
  native("braille", (args, span) => {
    expectArgs("braille", args, 2, span);
    const c = expectCanvas("braille", args[0]!, span);
    const [x, y] = expectPoint("braille", args[1]!, span);
    const col = Math.floor(x / 2);
    const row = Math.floor(y / 4);
    if (col < 0 || row < 0 || col >= c.canvas.width || row >= c.canvas.height) {
      return { type: "null" };
    }
    const index = row * c.canvas.width + col;
    const dotCol: 0 | 1 = (x % 2 === 0 ? 0 : 1);
    const dotRow = (y % 4) as 0 | 1 | 2 | 3;
    c.canvas.cells[index] = plotBrailleDot(c.canvas.cells[index]!, dotCol, dotRow);
    return { type: "null" };
  });

  native("print", (args) => {
    io.print(args.map(qbskStr).join(" "));
    return { type: "null" };
  });

  native("len", (args, span) => {
    expectArgs("len", args, 1, span);
    const v = args[0]!;
    if (v.type === "str") {
      // §15.6 — code points, the same unit indexing returns. UTF-16 length made
      // `len(s) - 1` wrong for any text outside the BMP: `len("a💚b")` said 4 while
      // the string had 3 indexable characters, and the two disagreeing about what
      // position 1 is is worse than either answer alone.
      return { type: "int", value: [...v.value].length };
    }
    if (v.type === "list") {
      return { type: "int", value: v.items.length };
    }
    if (v.type === "dict") {
      return { type: "int", value: v.map.size };
    }
    throw new QbskRuntimeError(`len() does not support the type '${typeName(v)}'`, span);
  });

  native("type", (args, span) => {
    expectArgs("type", args, 1, span);
    return { type: "str", value: typeName(args[0]!) };
  });

  native("str", (args, span) => {
    expectArgs("str", args, 1, span);
    return { type: "str", value: qbskStr(args[0]!) };
  });

  native("int", (args, span) => {
    expectArgs("int", args, 1, span);
    const v = args[0]!;
    if (v.type === "int") {
      return v;
    }
    if (v.type === "float") {
      return { type: "int", value: Math.trunc(v.value) };
    }
    if (v.type === "str") {
      const n = Number(v.value);
      if (v.value.trim() !== "" && Number.isInteger(n)) {
        return { type: "int", value: n };
      }
    }
    const label = v.type === "str" ? v.value : typeName(v);
    throw new QbskRuntimeError(`cannot convert '${label}' to int`, span);
  });

  native("float", (args, span) => {
    expectArgs("float", args, 1, span);
    const v = args[0]!;
    if (v.type === "float") {
      return v;
    }
    if (v.type === "int") {
      return { type: "float", value: v.value };
    }
    if (v.type === "str") {
      const n = Number(v.value);
      if (v.value.trim() !== "" && !Number.isNaN(n)) {
        return { type: "float", value: n };
      }
    }
    const label = v.type === "str" ? v.value : typeName(v);
    throw new QbskRuntimeError(`cannot convert '${label}' to float`, span);
  });

  native("bool", (args, span) => {
    expectArgs("bool", args, 1, span);
    return { type: "bool", value: truthy(args[0]!) };
  });

  native("clock", () => ({
    type: "float",
    value: performance.now() / 1000,
  }));

  native("gameTime", () => ({
    type: "float",
    value: opts.runtime?.gameTime ?? 0,
  }));

  // --- Tweens (docs/engine.md §11) ---
  //
  // animate(name, from, to, duration)            -> float
  // animate(name, from, to, duration, easing)    -> float
  //
  // Returns a FLOAT, always. The canvas takes integer cells, so a scene must round
  // explicitly with int(...) — QBSK keeps int and float distinct (RULE #4) and a
  // tween is not allowed to smuggle a silent truncation past that rule.
  const tweenStore = (): TweenStore => {
    const rt = opts.runtime;
    if (rt === undefined) {
      // No game loop (a one-shot `qbsk run`): give the tween a private store so it
      // still evaluates, deterministically, at gameTime 0.
      return createTweenStore();
    }
    rt.tweens ??= createTweenStore();
    return rt.tweens;
  };

  native("animate", (args, span) => {
    if (args.length !== 4 && args.length !== 5) {
      throw new QbskRuntimeError(
        `function 'animate' expects 4 or 5 arguments (name, from, to, duration[, easing]), got ${args.length}`,
        span,
      );
    }
    const nameArg = args[0]!;
    if (nameArg.type !== "str") {
      throw new QbskRuntimeError(
        `'animate' expects a string name, got '${typeName(nameArg)}'`,
        span,
      );
    }
    const from = expectNum("animate", args[1]!, span).value;
    const to = expectNum("animate", args[2]!, span).value;
    const duration = expectNum("animate", args[3]!, span).value;
    let easing = "linear";
    if (args.length === 5) {
      const e = args[4]!;
      if (e.type !== "str") {
        throw new QbskRuntimeError(
          `'animate' expects the easing as a string, got '${typeName(e)}'`,
          span,
        );
      }
      if (!isEasingName(e.value)) {
        const near = closest(e.value, EASING_NAMES);
        throw new QbskRuntimeError(
          `unknown easing '${e.value}'` +
            (near !== null ? ` — did you mean '${near}'?` : "") +
            `; expected one of ${EASING_NAMES.join(", ")}`,
          span,
        );
      }
      easing = e.value;
    }
    const res = readTween({
      store: tweenStore(),
      name: nameArg.value,
      from,
      to,
      duration,
      easing,
      now: opts.runtime?.gameTime ?? 0,
    });
    return { type: "float", value: res.value };
  });

  native("animate_done", (args, span) => {
    expectArgs("animate_done", args, 1, span);
    const nameArg = args[0]!;
    if (nameArg.type !== "str") {
      throw new QbskRuntimeError(
        `'animate_done' expects a string name, got '${typeName(nameArg)}'`,
        span,
      );
    }
    const rec = tweenStore().get(nameArg.value);
    if (rec === undefined) {
      return { type: "bool", value: false };
    }
    // The SAME definition of done-ness the tween itself uses (readTween →
    // tweenDone). This recomputed its own formula once, and a drift between the
    // two would have broken every pacing loop silently — the animation reached
    // its end while animate_done still said false.
    const now = opts.runtime?.gameTime ?? 0;
    return { type: "bool", value: tweenDone(rec, now) };
  });

  native("animate_reset", (args, span) => {
    expectArgs("animate_reset", args, 1, span);
    const nameArg = args[0]!;
    if (nameArg.type !== "str") {
      throw new QbskRuntimeError(
        `'animate_reset' expects a string name, got '${typeName(nameArg)}'`,
        span,
      );
    }
    return { type: "bool", value: resetTween(tweenStore(), nameArg.value) };
  });

  // --- Glyph density ramps (docs/engine.md §11.9) ---
  //
  //   glyph(intensity)          -> a character from the default ramp
  //   glyph(intensity, ramp)    -> ... from a ramp given as a string
  //   lit(depth, near, far)     -> intensity in [0, 1], 1 near and 0 far
  //
  // Returns a CHARACTER; colour is shade()'s job. Keeping them apart lets a scene
  // shade by glyph alone on a monochrome terminal, or by colour without touching
  // glyphs, or both.

  native("glyph", (args, span) => {
    if (args.length !== 1 && args.length !== 2) {
      throw new QbskRuntimeError(
        `function 'glyph' expects 1 or 2 arguments, got ${args.length}`,
        span,
      );
    }
    const intensity = expectNum("glyph", args[0]!, span);
    let ramp = DENSITY_RAMP;
    if (args.length === 2) {
      const r = args[1]!;
      if (r.type !== "str") {
        throw new QbskRuntimeError(
          `'glyph' expects the ramp as a string, got '${typeName(r)}'`,
          span,
        );
      }
      if (r.value.length === 0) {
        throw new QbskRuntimeError("the ramp cannot be empty", span);
      }
      ramp = r.value;
    }
    return { type: "str", value: rampGlyph(intensity.value, ramp) };
  });

  native("lit", (args, span) => {
    expectArgs("lit", args, 3, span);
    const depth = expectNum("lit", args[0]!, span);
    const near = expectNum("lit", args[1]!, span);
    const far = expectNum("lit", args[2]!, span);
    return {
      type: "float",
      value: intensityFromDepth(depth.value, near.value, far.value),
    };
  });

  // --- 3D projection (docs/engine.md §11.7) ---
  //
  //   project([x, y, z], camera, width, height) -> [u, v, depth, visible]
  //
  // The camera is an ordinary dict, so this needs no new syntax: keys x/y/z for the
  // eye, tx/ty/tz for the target, fov (degrees) and an optional aspect.
  //
  // Returns a LIST rather than a dict because a caller almost always destructures
  // it straight into a put: `put "!" at (p[0], p[1])`.

  const vecOf = (v: QValue, what: string, span: Span): Vec3 => {
    if (v.type !== "list" || v.items.length !== 3) {
      throw new QbskRuntimeError(
        `${what} must be a list of three numbers [x, y, z]`,
        span,
      );
    }
    const nums = v.items.map((item) => {
      if (item.type !== "int" && item.type !== "float") {
        throw new QbskRuntimeError(
          `${what} must contain numbers, found '${typeName(item)}'`,
          span,
        );
      }
      return item.value;
    });
    return { x: nums[0]!, y: nums[1]!, z: nums[2]! };
  };

  const cameraOf = (v: QValue, span: Span): Camera => {
    if (v.type !== "dict") {
      throw new QbskRuntimeError(
        `the camera must be a dict, got '${typeName(v)}'`,
        span,
      );
    }
    const num = (key: string, fallback: number): number => {
      const item = v.map.get(key);
      if (item === undefined) {
        return fallback;
      }
      if (item.type !== "int" && item.type !== "float") {
        throw new QbskRuntimeError(
          `camera '${key}' must be a number, got '${typeName(item)}'`,
          span,
        );
      }
      return item.value;
    };
    return {
      pos: { x: num("x", 0), y: num("y", 0), z: num("z", -10) },
      target: { x: num("tx", 0), y: num("ty", 0), z: num("tz", 0) },
      fov: num("fov", 60),
      aspect: num("aspect", DEFAULT_ASPECT),
    };
  };

  native("project", (args, span) => {
    expectArgs("project", args, 4, span);
    const point = vecOf(args[0]!, "the point", span);
    const camera = cameraOf(args[1]!, span);
    const width = expectInt("project", args[2]!, span);
    const height = expectInt("project", args[3]!, span);
    const p = project3d(point, camera, width, height);
    return {
      type: "list",
      items: [
        { type: "int", value: p.u },
        { type: "int", value: p.v },
        { type: "float", value: Number.isFinite(p.depth) ? p.depth : -1 },
        { type: "bool", value: p.visible },
      ],
    };
  });

  // A camera for the wall caster: 2D, not the 3D one `project` takes.
  //
  // They are deliberately different shapes. `project` needs an eye, a target and a cell
  // aspect because it answers where a point in a room lands on screen. A wall caster
  // walks a tile grid, so it needs a position, a facing and how wide it sees — and
  // asking it for a `target` would be asking for a number it has no use for.
  const rayCameraOf = (v: QValue, span: Span): RayCamera => {
    if (v.type !== "dict") {
      throw new QbskRuntimeError(
        `the camera must be a dict, got '${typeName(v)}'`,
        span,
      );
    }
    const num = (key: string, fallback: number): number => {
      const item = v.map.get(key);
      if (item === undefined) {
        return fallback;
      }
      if (item.type !== "int" && item.type !== "float") {
        throw new QbskRuntimeError(
          `camera '${key}' must be a number, got '${typeName(item)}'`,
          span,
        );
      }
      return item.value;
    };
    // Missing keys default rather than error, matching `project`. A camera at the origin
    // facing east with a 60-degree view is a usable camera, and refusing to build one
    // from `{"x": 3.0}` would make the common case the verbose one.
    return { x: num("x", 0), y: num("y", 0), angle: num("angle", 0), fov: num("fov", 60) };
  };

  // --- First-person wall casting (docs/engine.md §11.21) ---
  //
  //   raycast(rows, camera, columns, range, blocked)
  //     -> [[distance, side, tile, hit], ...] one row per screen column
  //
  // The DDA is here because QBSK cannot run it per column per frame. The DRAWING is not:
  // a column is a `line` whose height falls with distance and whose glyph comes from a
  // ramp, and QBSK says all three already.
  native("raycast", (args, span) => {
    expectArgs("raycast", args, 5, span);
    const rows = mapRows("raycast", args[0]!, span);
    const camera = rayCameraOf(args[1]!, span);
    const columns = expectInt("raycast", args[2]!, span);
    if (columns < 1) {
      throw new QbskRuntimeError(
        `'raycast' needs at least one column, got ${columns}`,
        span,
      );
    }
    const rangeValue = args[3]!;
    if (rangeValue.type !== "int" && rangeValue.type !== "float") {
      throw new QbskRuntimeError(
        `'raycast' expects the range as a number, got '${typeName(rangeValue)}'`,
        span,
      );
    }
    if (!(rangeValue.value > 0)) {
      throw new QbskRuntimeError(
        `the range must be positive, got ${rangeValue.value}`,
        span,
      );
    }
    const blockedValue = args[4]!;
    if (blockedValue.type !== "str") {
      throw new QbskRuntimeError(
        `'raycast' expects the blocked characters as a string, got '${typeName(blockedValue)}'`,
        span,
      );
    }
    return {
      type: "list",
      items: castColumns(rows, camera, columns, rangeValue.value, blockedValue.value)
        .map((h) => ({
          type: "list" as const,
          items: [
            { type: "float" as const, value: h.distance },
            { type: "str" as const, value: h.side },
            { type: "str" as const, value: h.tile },
            { type: "bool" as const, value: h.hit },
          ],
        })),
    };
  });

  // --- Turns and entities (docs/engine.md §12) ---
  //
  //   turn()                 the current turn number
  //   advance()              request one turn; it runs in stage 4 of this frame
  //   spawn(components)      the dict plus a fresh, stable "id"
  //   find(entities, id)     that entity, or null
  //   without(entities, id)  the list minus that entity
  //
  // A turn is NOT a frame. `gameTime()` advances because seconds passed; the turn
  // advances because the player acted. Conflating the two is the mistake this whole
  // group exists to prevent.

  const simState = (): SimState => {
    const runtime = opts.runtime;
    if (runtime === undefined) {
      // No runtime at all (a plain `qbsk run`, no loop): the counters still have to
      // exist and stay coherent, they just have nobody to advance the frame.
      return orphanSim;
    }
    runtime.sim ??= { turn: 0, pending: 0, nextId: 1 };
    return runtime.sim;
  };

  native("turn", (args, span) => {
    expectArgs("turn", args, 0, span);
    return { type: "int", value: simState().turn };
  });

  native("advance", (args, span) => {
    expectArgs("advance", args, 0, span);
    // REQUESTS a turn; it does not run the handlers. Running them here would make
    // advance() re-entrant from inside a turn handler, which is a one-line infinite
    // loop. The frame drains the request at a fixed point instead.
    simState().pending += 1;
    return { type: "null" };
  });

  native("spawn", (args, span) => {
    expectArgs("spawn", args, 1, span);
    const components = args[0]!;
    if (components.type !== "dict") {
      throw new QbskRuntimeError(
        `spawn expects the components as a dict, got '${typeName(components)}'`,
        span,
      );
    }
    if (components.map.has("id")) {
      // Renumbering would destroy exactly the identity spawn exists to provide.
      throw new QbskRuntimeError(
        "this entity already has an 'id' — spawn assigns it, so do not set it yourself",
        span,
      );
    }
    const sim = simState();
    const map = new Map(components.map);
    map.set("id", { type: "int", value: sim.nextId });
    sim.nextId += 1;
    return { type: "dict", map };
  });

  const entityId = (v: QValue, span: Span): number => {
    if (v.type !== "int") {
      throw new QbskRuntimeError(
        `an entity id is an int, got '${typeName(v)}'`,
        span,
      );
    }
    return v.value;
  };

  /** An entity is what `spawn` returns: a dict carrying an int `id`. */
  const idOf = (item: QValue): number | null => {
    if (item.type !== "dict") {
      return null;
    }
    const id = item.map.get("id");
    return id !== undefined && id.type === "int" ? id.value : null;
  };

  /**
   * The items of a list that really does hold entities (§15.11).
   *
   * The message below has PROMISED entities since it was written and only checked that
   * the value was a list. `idOf` answers `null` for anything else, and both callers read
   * that `null` as "does not match" — so `without` filtered a list of ints to itself and
   * returned it unchanged, exit 0, no message, and `find` answered `null`, which is what
   * a dead entity legitimately answers. Anti-pattern 1 in its purest form: it parses, it
   * runs, it reports success, and it does nothing.
   *
   * Found reaching for `without` as "remove this element" —
   * the reading its name invites. A GOAP planner's frontier never shrank and the search
   * ran to its expansion cap.
   *
   * Checked HERE and not in each native, because the defect was never in either of them.
   * An empty list still passes: every entity dying is a simulation event, not an error.
   */
  const entityList = (name: string, v: QValue, span: Span): QValue[] => {
    if (v.type !== "list") {
      throw new QbskRuntimeError(
        `'${name}' expects a list of entities, got '${typeName(v)}'`,
        span,
      );
    }
    for (let i = 0; i < v.items.length; i += 1) {
      if (idOf(v.items[i]!) === null) {
        // The INDEX, not just the call: §8 promises the error points at the mistake, and
        // "expects entities" on a list of two hundred sends the author to read all of them.
        throw new QbskRuntimeError(
          `'${name}' expects a list of entities, but element ${i} is a '${typeName(v.items[i]!)}'` +
            ` — an entity is what 'spawn' returns, a dict carrying an int 'id'`,
          span,
        );
      }
    }
    return v.items;
  };

  native("find", (args, span) => {
    expectArgs("find", args, 2, span);
    const items = entityList("find", args[0]!, span);
    const id = entityId(args[1]!, span);
    for (const item of items) {
      if (idOf(item) === id) {
        return item;
      }
    }
    // A corpse is not a bug: an entity that died is the normal case in a simulation,
    // so this answers null rather than reporting.
    return { type: "null" };
  });

  native("without", (args, span) => {
    expectArgs("without", args, 2, span);
    const items = entityList("without", args[0]!, span);
    const id = entityId(args[1]!, span);
    return { type: "list", items: items.filter((item) => idOf(item) !== id) };
  });

  // --- Pathfinding (docs/engine.md §13) ---
  //
  //   path(map, (x, y), (x, y), blocked [, diagonal: false]) -> [(x, y), ...]
  //
  // The map is the list of strings the game already draws, so there is no parallel
  // structure to keep in step. Both ends are included in the route, which is what makes
  // "already there" (one step) distinguishable from "no way through" (empty).

  native("path", (args, span) => {
    if (args.length < 4 || args.length > 5) {
      throw new QbskRuntimeError(
        `function 'path' expects 4 arguments (map, from, to, blocked), got ${args.length}`,
        span,
      );
    }
    const mapValue = args[0]!;
    if (mapValue.type !== "list") {
      throw new QbskRuntimeError(
        `'path' expects the map as a list of strings, got '${typeName(mapValue)}'`,
        span,
      );
    }
    const rows: string[] = [];
    for (const row of mapValue.items) {
      if (row.type !== "str") {
        throw new QbskRuntimeError(
          `the map must be a list of strings, found '${typeName(row)}' in it`,
          span,
        );
      }
      rows.push(row.value);
    }
    const [fx, fy] = expectPoint("path", args[1]!, span);
    const [tx, ty] = expectPoint("path", args[2]!, span);
    const blockedValue = args[3]!;
    if (blockedValue.type !== "str") {
      throw new QbskRuntimeError(
        `'path' expects the blocked characters as a string, got '${typeName(blockedValue)}'`,
        span,
      );
    }
    let diagonal = true;
    if (args.length === 5) {
      const flag = args[4]!;
      if (flag.type !== "bool") {
        throw new QbskRuntimeError(
          `'diagonal' must be true or false, got '${typeName(flag)}'`,
          span,
        );
      }
      diagonal = flag.value;
    }
    const route = findPath(rows, [fx, fy], [tx, ty], blockedValue.value, diagonal);
    return {
      type: "list",
      items: route.map(
        ([x, y]) =>
          ({
            type: "tuple",
            x: { type: "int", value: x },
            y: { type: "int", value: y },
          }) as QValue,
      ),
    };
  });

  // --- Field of view (docs/engine.md §14) ---
  //
  //   sight(map, (x, y), radius, blocked) -> a mask shaped like the map
  //
  // "." you can see, " " you cannot, so a lookup is `lit[y][x]` — one index rather than
  // a search through a list of coordinates, which is what a scene needs when it asks the
  // question once per creature and once per tile.

  const mapRows = (name: string, v: QValue, span: Span): string[] => {
    if (v.type !== "list") {
      throw new QbskRuntimeError(
        `'${name}' expects the map as a list of strings, got '${typeName(v)}'`,
        span,
      );
    }
    const rows: string[] = [];
    for (const row of v.items) {
      if (row.type !== "str") {
        throw new QbskRuntimeError(
          `the map must be a list of strings, found '${typeName(row)}' in it`,
          span,
        );
      }
      rows.push(row.value);
    }
    return rows;
  };

  native("sight", (args, span) => {
    expectArgs("sight", args, 4, span);
    const rows = mapRows("sight", args[0]!, span);
    const [fx, fy] = expectPoint("sight", args[1]!, span);
    const radius = expectInt("sight", args[2]!, span);
    if (radius < 0) {
      throw new QbskRuntimeError(
        `the radius cannot be negative, got ${radius}`,
        span,
      );
    }
    const blockedValue = args[3]!;
    if (blockedValue.type !== "str") {
      throw new QbskRuntimeError(
        `'sight' expects the blocked characters as a string, got '${typeName(blockedValue)}'`,
        span,
      );
    }
    const mask = computeVisible(rows, [fx, fy], radius, blockedValue.value);
    return {
      type: "list",
      items: mask.map((row) => ({ type: "str", value: row }) as QValue),
    };
  });

  // --- Host data (docs/studio.md §14.6) ---
  //
  //   host(key) -> the value the host put there, or null
  //
  // The one way data enters a program from outside. There is deliberately no setter:
  // a program can read what the host offers and can never write back or call out, so
  // a console can be a QBSK scene without the scene gaining reach into the machine.

  native("host", (args, span) => {
    expectArgs("host", args, 1, span);
    const key = args[0]!;
    if (key.type !== "str") {
      throw new QbskRuntimeError(
        `'host' expects the key as a string, got '${typeName(key)}'`,
        span,
      );
    }
    const data = opts.runtime?.host;
    if (data === undefined) {
      return { type: "null" };
    }
    const value = data[key.value];
    if (value === undefined || value === null) {
      // Absent is null, not an error: a scene must be able to draw before the host
      // has anything to say, the same way it composes once before the first tick.
      return { type: "null" };
    }
    if (typeof value === "string") {
      return { type: "str", value };
    }
    if (typeof value === "boolean") {
      return { type: "bool", value };
    }
    if (typeof value === "number") {
      // Whole numbers arrive as int so they can index and position without a cast;
      // anything else is a float.
      return Number.isInteger(value)
        ? { type: "int", value }
        : { type: "float", value };
    }
    return {
      type: "list",
      items: value.map((item) => ({ type: "str", value: item }) as QValue),
    };
  });

  // --- Time-indexed particles (docs/engine.md §11.10) ---
  //
  //   particle(index, t, spec) -> [x, y, age]
  //
  // Closed form, like tweens and frame-swapping: nothing accumulates between frames,
  // so the effect is seekable and a golden can pin it. The emitter is an ordinary
  // dict, so this needs no new syntax either.

  native("particle", (args, span) => {
    expectArgs("particle", args, 3, span);
    const index = expectInt("particle", args[0]!, span);
    const t = expectNum("particle", args[1]!, span);
    const raw = args[2]!;
    if (raw.type !== "dict") {
      throw new QbskRuntimeError(
        `the emitter must be a dict, got '${typeName(raw)}'`,
        span,
      );
    }

    const given: Record<string, number> = {};
    for (const [key, item] of raw.map) {
      if (item.type !== "int" && item.type !== "float") {
        throw new QbskRuntimeError(
          `emitter '${key}' must be a number, got '${typeName(item)}'`,
          span,
        );
      }
      given[key] = item.value;
    }

    let spec: ParticleSpec;
    try {
      spec = resolveParticleSpec(given);
    } catch (err) {
      // The engine throws plain Errors; a QBSK user must never see one (RULE #4).
      throw new QbskRuntimeError(
        err instanceof Error ? err.message : String(err),
        span,
      );
    }

    if (index < 0 || index >= spec.count) {
      throw new QbskRuntimeError(
        `particle ${index} does not exist — this emitter has ${spec.count}, numbered 0 to ${spec.count - 1}`,
        span,
      );
    }

    const p = particleAt(index, t.value, spec);
    // Rounded to cells like project() does, so the result drops straight into a
    // `put ... at (p[0], p[1])`.
    return {
      type: "list",
      items: [
        { type: "int", value: Math.round(p.x) },
        { type: "int", value: Math.round(p.y) },
        { type: "float", value: p.age },
      ],
    };
  });

  // --- Timelines (docs/engine.md §11.5) ---
  //
  // Built on lists, which the language already has, rather than on new syntax:
  //   timeline_sequence([...])  timeline_parallel([...])
  //   timeline_step(name, secs) timeline_wait(secs)
  //   timeline_active(tl, t) -> list of names   timeline_progress(tl, name, t)
  //
  // A timeline is a VALUE that is queried, not a scheduler that runs. Asking the
  // same timeline the same time twice always gives the same answer, so it composes
  // with the per-frame re-evaluation model and keeps goldens byte-exact.
  //
  // Represented as an opaque dict so it round-trips through QBSK values without a
  // new runtime type: { "__timeline": <json> }.
  const TL_KEY = "__timeline";

  const toStep = (v: QValue, span: Span): Step => {
    if (v.type !== "dict") {
      throw new QbskRuntimeError(
        `expected a timeline value, got '${typeName(v)}'`,
        span,
      );
    }
    const raw = v.map.get(TL_KEY);
    if (raw === undefined || raw.type !== "str") {
      throw new QbskRuntimeError("expected a timeline value", span);
    }
    try {
      return JSON.parse(raw.value) as Step;
    } catch {
      throw new QbskRuntimeError("invalid timeline JSON", span);
    }
  };

  const fromStep = (s: Step): QValue => ({
    type: "dict",
    map: new Map<string, QValue>([
      [TL_KEY, { type: "str", value: JSON.stringify(s) }],
    ]),
  });

  const childSteps = (v: QValue, span: Span): Step[] => {
    if (v.type !== "list") {
      throw new QbskRuntimeError(
        `expected a list of timeline steps, got '${typeName(v)}'`,
        span,
      );
    }
    return v.items.map((item) => toStep(item, span));
  };

  native("timeline_wait", (args, span) => {
    expectArgs("timeline_wait", args, 1, span);
    return fromStep(tlWait(expectNum("timeline_wait", args[0]!, span).value));
  });

  native("timeline_step", (args, span) => {
    expectArgs("timeline_step", args, 2, span);
    const name = args[0]!;
    if (name.type !== "str") {
      throw new QbskRuntimeError(
        `'timeline_step' expects a string name, got '${typeName(name)}'`,
        span,
      );
    }
    return fromStep(
      tlStep(name.value, expectNum("timeline_step", args[1]!, span).value),
    );
  });

  native("timeline_sequence", (args, span) => {
    expectArgs("timeline_sequence", args, 1, span);
    return fromStep(tlSequence(...childSteps(args[0]!, span)));
  });

  native("timeline_parallel", (args, span) => {
    expectArgs("timeline_parallel", args, 1, span);
    return fromStep(tlParallel(...childSteps(args[0]!, span)));
  });

  native("timeline_duration", (args, span) => {
    expectArgs("timeline_duration", args, 1, span);
    return { type: "float", value: stepDuration(toStep(args[0]!, span)) };
  });

  // Returns the names active at time t, in declaration order. A `wait` contributes
  // nothing, which is what makes a sequence read the way it looks.
  native("timeline_active", (args, span) => {
    expectArgs("timeline_active", args, 2, span);
    const t = expectNum("timeline_active", args[1]!, span).value;
    return {
      type: "list",
      items: activeAt(toStep(args[0]!, span), t).map((a) => ({
        type: "str" as const,
        value: a.name,
      })),
    };
  });

  // Progress of one named step in [0, 1], or -1.0 when it is not running. Returns a
  // float so the caller must decide how to round (RULE #4), same as animate().
  native("timeline_progress", (args, span) => {
    expectArgs("timeline_progress", args, 3, span);
    const name = args[1]!;
    if (name.type !== "str") {
      throw new QbskRuntimeError(
        `'timeline_progress' expects a string name, got '${typeName(name)}'`,
        span,
      );
    }
    const t = expectNum("timeline_progress", args[2]!, span).value;
    const hit = activeAt(toStep(args[0]!, span), t).find(
      (a) => a.name === name.value,
    );
    return { type: "float", value: hit === undefined ? -1 : hit.progress };
  });

  native("args", () => ({
    type: "list",
    items: (opts.scriptArgs ?? []).map((a) => ({ type: "str", value: a })),
  }));

  /**
   * `fail(message)` — the author's own error (§17.1).
   *
   * QBSK could CATCH an error and never RAISE one. `try`/`catch` has existed since L9 and
   * every error it caught came from the engine, so a library written in QBSK had exactly
   * two answers to a bad argument: return `null`, or return something wrong. Both are the
   * ghost feature this project hunts first, and §15's whole doctrine — report, never
   * silently no-op — was therefore unavailable to programs written in the language that
   * states it.
   *
   * Found writing a lookup module that wanted to say "no anatomical
   * region 'elbow_middle'" and could only answer null.
   *
   * A NATIVE and not a keyword: the 51 keywords are frozen (§17.1) and adding one could
   * break a program using `error` as a name, while "adding is not breaking" is stated of
   * natives exactly. It raises an ordinary `QbskRuntimeError`, so the span points at the
   * `fail(...)` call and `try`/`catch` handles it like any other — which is the half that
   * makes it useful rather than a louder `exit`.
   *
   * Deliberately NOT `assert(cond, message)`. A condition is what `if` is for, and an
   * assert that takes one invites `assert(x)` with no message, which reports that
   * something was false rather than what the author meant.
   */
  native("fail", (args, span) => {
    expectArgs("fail", args, 1, span);
    const message = expectStr("fail", args[0]!, span);
    throw new QbskRuntimeError(message, span);
  });

  native("exit", (args, span) => {
    if (args.length > 1) {
      throw new QbskRuntimeError(
        `function 'exit' expects 0 or 1 arguments, got ${args.length}`,
        span,
      );
    }
    const code = args[0];
    if (code !== undefined && code.type !== "int") {
      throw new QbskRuntimeError("exit() expects an integer code", span);
    }
    throw new ExitSignal(code === undefined ? 0 : code.value);
  });

  // --- Persistence (docs/language.md §13) ---------------------------------
  //
  // The natives never touch the file system: they call the SaveStore the host
  // provides (§13.5). No store = an honest error at the call site, never a silent
  // no-op — a program that believes it saved and did not is the worst outcome.

  const SLOT_NAME = /^[A-Za-z0-9_-]+$/;

  const expectSlot = (name: string, v: QValue, span: Span): string => {
    const slot = expectStr(name, v, span);
    if (!SLOT_NAME.test(slot)) {
      throw new QbskRuntimeError(
        `'${name}' expects a slot name (letters, digits, '_', '-'), got '${slot}' — a slot is a name, not a path`,
        span,
      );
    }
    return slot;
  };

  const expectStore = (name: string, span: Span): SaveStore => {
    if (opts.saveStore === undefined) {
      throw new QbskRuntimeError(
        `'${name}' has nowhere to save — this host provides no save storage`,
        span,
      );
    }
    return opts.saveStore;
  };

  native("save_state", (args, span) => {
    expectArgs("save_state", args, 2, span);
    const slot = expectSlot("save_state", args[0]!, span);
    const state = expectDict("save_state", args[1]!, span);
    const store = expectStore("save_state", span);
    let text: string;
    try {
      text = serializeState(state);
    } catch (err) {
      throw new QbskRuntimeError(
        `'${slot}' ${(err as Error).message}`,
        span,
      );
    }
    store.write(slot, text);
    return { type: "null" };
  });

  native("load_state", (args, span) => {
    expectArgs("load_state", args, 1, span);
    const slot = expectSlot("load_state", args[0]!, span);
    const store = expectStore("load_state", span);
    const text = store.read(slot);
    // A missing slot is the NORMAL state of a fresh install (§13.4): null, and the
    // Continue menu is an `if`. A slot that exists but cannot be read is the
    // opposite — erasing a player's game without a word is not an option.
    if (text === null) {
      return { type: "null" };
    }
    const result = loadQbdata(text, `${slot}.qbdata`);
    const problem = result.errors[0];
    if (problem !== undefined) {
      throw new QbskRuntimeError(
        `slot '${slot}' is corrupt: ${problem.message} (${slot}.qbdata:${problem.span.start.line})`,
        span,
      );
    }
    return { type: "dict", map: new Map(result.entries) };
  });

  native("list_saves", (args, span) => {
    expectArgs("list_saves", args, 0, span);
    // No storage means no saves — [] is the honest answer and lets a menu render
    // on a host that cannot save at all.
    if (opts.saveStore === undefined) {
      return { type: "list", items: [] };
    }
    return {
      type: "list",
      items: opts.saveStore.list().map((slot) => ({ type: "str", value: slot })),
    };
  });

  const expectNum = (
    name: string,
    v: QValue,
    span: Span,
  ): { type: "int" | "float"; value: number } => {
    if (v.type !== "int" && v.type !== "float") {
      throw new QbskRuntimeError(
        `'${name}' expects a number (int or float), got '${typeName(v)}'`,
        span,
      );
    }
    return v;
  };

  // --- Stdlib L3a: String ------------------------------------------------

  native("upper", (args, span) => {
    expectArgs("upper", args, 1, span);
    return { type: "str", value: expectStr("upper", args[0]!, span).toUpperCase() };
  });

  native("lower", (args, span) => {
    expectArgs("lower", args, 1, span);
    return { type: "str", value: expectStr("lower", args[0]!, span).toLowerCase() };
  });

  native("trim", (args, span) => {
    expectArgs("trim", args, 1, span);
    return { type: "str", value: expectStr("trim", args[0]!, span).trim() };
  });

  native("split", (args, span) => {
    expectArgs("split", args, 2, span);
    const s = expectStr("split", args[0]!, span);
    const sep = expectStr("split", args[1]!, span);
    if (sep === "") {
      throw new QbskRuntimeError("'split' expects a non-empty separator", span);
    }
    return {
      type: "list",
      items: s.split(sep).map((x) => ({ type: "str", value: x })),
    };
  });

  native("join", (args, span) => {
    expectArgs("join", args, 2, span);
    const l = args[0]!;
    const sep = expectStr("join", args[1]!, span);
    if (l.type !== "list") {
      throw new QbskRuntimeError(
        `'join' expects a list of strings, got '${typeName(l)}'`,
        span,
      );
    }
    const parts: string[] = [];
    for (const item of l.items) {
      if (item.type !== "str") {
        throw new QbskRuntimeError(
          "'join' expects all elements to be strings",
          span,
        );
      }
      parts.push(item.value);
    }
    return { type: "str", value: parts.join(sep) };
  });

  native("replace", (args, span) => {
    expectArgs("replace", args, 3, span);
    const s = expectStr("replace", args[0]!, span);
    const from = expectStr("replace", args[1]!, span);
    const to = expectStr("replace", args[2]!, span);
    return { type: "str", value: s.replaceAll(from, to) };
  });

  // §15.18 — a string OR a list. It was string-only, and nothing in the language could ask
  // whether a list held a value, so the four-line loop got written by hand in two modules
  // of one codebase three weeks apart. A rule a language makes you re-derive is a rule the
  // language has not learned.
  //
  // Not a §17.1 break: a list argument used to REPORT, so no program that ran can tell the
  // difference. Widening an error into an answer cannot change what a working program does.
  const COMPARABLE = new Set(["int", "float", "str", "bool", "null"]);
  native("contains", (args, span) => {
    expectArgs("contains", args, 2, span);
    const haystack = args[0]!;
    if (haystack.type === "list") {
      const needle = args[1]!;
      if (!COMPARABLE.has(needle.type)) {
        throw new QbskRuntimeError(
          `'contains' compares values the way '==' does, and cannot compare a ` +
            `'${typeName(needle)}' — use a loop and decide what "the same" means`,
          span,
        );
      }
      return {
        type: "bool",
        value: haystack.items.some((item) => qbskEq(item, needle)),
      };
    }
    const s = expectStr("contains", haystack, span);
    const sub = expectStr("contains", args[1]!, span);
    return { type: "bool", value: s.includes(sub) };
  });

  native("starts_with", (args, span) => {
    expectArgs("starts_with", args, 2, span);
    const s = expectStr("starts_with", args[0]!, span);
    const pref = expectStr("starts_with", args[1]!, span);
    return { type: "bool", value: s.startsWith(pref) };
  });

  native("ends_with", (args, span) => {
    expectArgs("ends_with", args, 2, span);
    const s = expectStr("ends_with", args[0]!, span);
    const suf = expectStr("ends_with", args[1]!, span);
    return { type: "bool", value: s.endsWith(suf) };
  });

  // --- Stdlib L3a: Math --------------------------------------------------

  native("abs", (args, span) => {
    expectArgs("abs", args, 1, span);
    const n = expectNum("abs", args[0]!, span);
    return { type: n.type, value: Math.abs(n.value) };
  });

  const minMax = (
    name: string,
    fn: (a: number, b: number) => number,
  ): void => {
    native(name, (args, span) => {
      expectArgs(name, args, 2, span);
      const a = expectNum(name, args[0]!, span);
      const b = expectNum(name, args[1]!, span);
      const type: "int" | "float" =
        a.type === "float" || b.type === "float" ? "float" : "int";
      return { type, value: fn(a.value, b.value) };
    });
  };

  minMax("min", Math.min);
  minMax("max", Math.max);

  const roundLike = (name: string, fn: (n: number) => number): void => {
    native(name, (args, span) => {
      expectArgs(name, args, 1, span);
      const n = expectNum(name, args[0]!, span);
      return { type: "int", value: fn(n.value) };
    });
  };

  roundLike("round", Math.round);
  roundLike("floor", Math.floor);
  roundLike("ceil", Math.ceil);

  native("sqrt", (args, span) => {
    expectArgs("sqrt", args, 1, span);
    const n = expectNum("sqrt", args[0]!, span);
    if (n.value < 0) {
      throw new QbskRuntimeError("'sqrt' does not accept negative numbers", span);
    }
    return { type: "float", value: Math.sqrt(n.value) };
  });

  /**
   * `exp` and `log` (§17.1). The reason they arrived is worth keeping.
   *
   * The GDD's two central modulation formulas are sigmoids — §5.1's stress-induced
   * analgesia, which decides whether a wounded body still answers its owner, and
   * §9.2's utility curves, which are the whole middle layer of the AI. Neither could be
   * written: there was no e^x, no natural log and no power operator, and every way to
   * fake one is an approximation that hides the gap instead of reporting it.
   *
   * Both REPORT rather than answering a non-finite number, which is the `sqrt` precedent
   * and the §15 rule behind it. `Infinity` and `NaN` do not fail — they poison every
   * number computed after them, and a physiological simulation is exactly where that is
   * least visible.
   *
   * `pow` is deliberately NOT added. It has no consumer yet, and `exp`/`log` are what a
   * caller who needs one can build it from; the GDD's own powers are integers (`r^4` in
   * the Poiseuille flow of §4.1) and multiply out.
   */
  native("exp", (args, span) => {
    expectArgs("exp", args, 1, span);
    const n = expectNum("exp", args[0]!, span);
    const value = Math.exp(n.value);
    if (!Number.isFinite(value)) {
      throw new QbskRuntimeError(
        `'exp' of ${n.value} is too large to represent`,
        span,
      );
    }
    return { type: "float", value };
  });

  native("log", (args, span) => {
    expectArgs("log", args, 1, span);
    const n = expectNum("log", args[0]!, span);
    if (n.value <= 0) {
      // Zero would answer -Infinity and a negative would answer NaN. Both are silent.
      throw new QbskRuntimeError(
        `'log' expects a positive number, got ${n.value}`,
        span,
      );
    }
    return { type: "float", value: Math.log(n.value) };
  });

  // Trigonometry. Angles are in RADIANS, like every maths library and unlike the
  // camera's `fov`, which is in degrees because that is how a human states a field
  // of view. `PI` is provided so a scene need not spell out 3.14159 to convert.
  const trig = (name: string, fn: (n: number) => number): void => {
    native(name, (args, span) => {
      expectArgs(name, args, 1, span);
      const n = expectNum(name, args[0]!, span);
      return { type: "float", value: fn(n.value) };
    });
  };

  trig("sin", Math.sin);
  trig("cos", Math.cos);
  trig("tan", Math.tan);

  native("atan2", (args, span) => {
    expectArgs("atan2", args, 2, span);
    const y = expectNum("atan2", args[0]!, span);
    const x = expectNum("atan2", args[1]!, span);
    return { type: "float", value: Math.atan2(y.value, x.value) };
  });

  native("pi", (args, span) => {
    expectArgs("pi", args, 0, span);
    return { type: "float", value: Math.PI };
  });

  native("random", (args, span) => {
    expectArgs("random", args, 0, span);
    return { type: "float", value: Math.random() };
  });

  // --- Seeded randomness (L4, docs/language.md §6.5) ----------------------
  //
  // The SAME mulberry32 the host uses for audio noise and particles
  // (src/util/random.ts): one PRNG in the whole project, zero golden drift.
  // `random()` above stays the only non-deterministic source, untouched.

  const expectRng = (name: string, v: QValue, span: Span): () => number => {
    if (v.type !== "rng") {
      throw new QbskRuntimeError(
        `'${name}' expects a generator (rng(seed)), got '${typeName(v)}'`,
        span,
      );
    }
    return v.next;
  };

  native("rng", (args, span) => {
    expectArgs("rng", args, 1, span);
    const seed = expectInt("rng", args[0]!, span);
    return { type: "rng", next: mulberry32(seed) };
  });

  native("roll_float", (args, span) => {
    expectArgs("roll_float", args, 1, span);
    return { type: "float", value: expectRng("roll_float", args[0]!, span)() };
  });

  native("roll_int", (args, span) => {
    expectArgs("roll_int", args, 3, span);
    const next = expectRng("roll_int", args[0]!, span);
    const lo = expectInt("roll_int", args[1]!, span);
    const hi = expectInt("roll_int", args[2]!, span);
    if (lo >= hi) {
      throw new QbskRuntimeError(
        `'roll_int' needs lo < hi, got [${lo}, ${hi})`,
        span,
      );
    }
    return { type: "int", value: lo + Math.floor(next() * (hi - lo)) };
  });

  // --- Stdlib L3b: List -------------------------------------------------

  native("push", (args, span) => {
    expectArgs("push", args, 2, span);
    const l = expectList("push", args[0]!, span);
    l.items.push(args[1]!);
    return l;
  });

  native("pop", (args, span) => {
    expectArgs("pop", args, 1, span);
    const l = expectList("pop", args[0]!, span);
    if (l.items.length === 0) {
      throw new QbskRuntimeError(
        "'pop' cannot operate on an empty list",
        span,
      );
    }
    return l.items.pop()!;
  });

  native("sort", (args, span) => {
    expectArgs("sort", args, 1, span);
    const l = expectList("sort", args[0]!, span);
    const isNum = (
      v: QValue,
    ): v is { type: "int" | "float"; value: number } =>
      v.type === "int" || v.type === "float";
    l.items.sort((a, b) => {
      if (isNum(a) && isNum(b)) {
        return a.value - b.value;
      }
      if (a.type === "str" && b.type === "str") {
        return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
      }
      throw new QbskRuntimeError(
        "'sort' expects a homogeneous list of numbers or strings",
        span,
      );
    });
    return l;
  });

  native("reverse", (args, span) => {
    expectArgs("reverse", args, 1, span);
    const l = expectList("reverse", args[0]!, span);
    l.items.reverse();
    return l;
  });

  native("map", (args, span) => {
    expectArgs("map", args, 2, span);
    const l = expectList("map", args[0]!, span);
    const fn = expectCallable("map", args[1]!, span);
    return {
      type: "list",
      items: l.items.map((el) => invoke("map", fn, [el], span)),
    };
  });

  native("filter", (args, span) => {
    expectArgs("filter", args, 2, span);
    const l = expectList("filter", args[0]!, span);
    const fn = expectCallable("filter", args[1]!, span);
    return {
      type: "list",
      items: l.items.filter((el) => truthy(invoke("filter", fn, [el], span))),
    };
  });

  native("reduce", (args, span) => {
    expectArgs("reduce", args, 3, span);
    const l = expectList("reduce", args[0]!, span);
    const fn = expectCallable("reduce", args[1]!, span);
    let acc = args[2]!;
    for (const el of l.items) {
      acc = invoke("reduce", fn, [acc, el], span);
    }
    return acc;
  });

  /**
   * `format(x, places)` — a number with a fixed number of decimals (§15.19).
   *
   * Without it every line that wanted three decimals wrote `str(int(x * 1000.0))` and then
   * had no way to put the point back. That shape appears about a hundred times across one
   * codebase, and it is wrong twice over: `int` TRUNCATES, so 0.0006 printed as 0 and
   * 2.9999 as 2999. This rounds.
   */
  const MAX_PLACES = 12;
  native("format", (args, span) => {
    expectArgs("format", args, 2, span);
    const value = args[0]!;
    if (value.type !== "int" && value.type !== "float") {
      throw new QbskRuntimeError(
        `'format' formats a number, got '${typeName(value)}'`,
        span,
      );
    }
    const places = expectInt("format", args[1]!, span);
    if (places < 0 || places > MAX_PLACES) {
      throw new QbskRuntimeError(
        `'format' takes 0 to ${MAX_PLACES} decimal places, got ${places}`,
        span,
      );
    }
    return { type: "str", value: value.value.toFixed(places) };
  });

  native("slice", (args, span) => {
    if (args.length !== 2 && args.length !== 3) {
      throw new QbskRuntimeError(
        `'slice' expects 2 or 3 arguments, got ${args.length}`,
        span,
      );
    }
    // §15.19 — a string or a list. It was list-only while `[]` already indexed strings,
    // an asymmetry with no reason behind it whose workaround was a `while` loop
    // concatenating one character at a time. A string used to REPORT here, so widening it
    // cannot change what any working program does.
    const subject = args[0]!;
    if (subject.type === "str") {
      const text = subject.value;
      const from = expectInt("slice", args[1]!, span);
      const to = args.length === 3 ? expectInt("slice", args[2]!, span) : text.length;
      // Clamped, like the list form: a substring that runs off the end is a normal thing
      // to ask for and an error there would be pedantry.
      const a = Math.max(0, Math.min(text.length, from));
      const b = Math.max(a, Math.min(text.length, to));
      return { type: "str", value: text.slice(a, b) };
    }
    const l = expectList("slice", subject, span);
    const from = expectInt("slice", args[1]!, span);
    const to =
      args.length === 3 ? expectInt("slice", args[2]!, span) : l.items.length;
    const start = Math.max(0, from);
    const end = Math.min(l.items.length, to);
    return {
      type: "list",
      items: start >= end ? [] : l.items.slice(start, end),
    };
  });

  // --- Stdlib L3b: Dict -------------------------------------------------

  native("keys", (args, span) => {
    expectArgs("keys", args, 1, span);
    const d = expectDict("keys", args[0]!, span);
    return {
      type: "list",
      items: [...d.map.keys()].map((k) => ({ type: "str", value: k })),
    };
  });

  native("values", (args, span) => {
    expectArgs("values", args, 1, span);
    const d = expectDict("values", args[0]!, span);
    return { type: "list", items: [...d.map.values()] };
  });

  native("has", (args, span) => {
    expectArgs("has", args, 2, span);
    const d = expectDict("has", args[0]!, span);
    const k = expectStr("has", args[1]!, span);
    return { type: "bool", value: d.map.has(k) };
  });

  return env;
}
