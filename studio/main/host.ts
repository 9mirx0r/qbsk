// PURE host (docs/studio.md §3): loads QBSK files, runs scenes, holds the
// double buffer + diff. The only allowed imports are node builtins and ../src.
// It must never import "electron", so it stays unit-testable headless.
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { ScreenBuffer } from "../../src/engine/buffer.js";
import { computeDiff } from "../../src/engine/diff.js";
import type { DiffLine } from "../../src/engine/diff.js";
import { renderFrame } from "../../src/engine/render.js";
import { runQbsk, SceneProgram } from "../../src/interp/interpreter.js";
import { qbskStr, typeName } from "../../src/interp/value.js";
import type { GameRuntime, HostValue } from "../../src/interp/natives.js";
import type { TonePlanEntry } from "../../src/audio/tone.js";
import type {
  ConsoleTarget,
  EntityRow,
  EvalOutcome,
  InspectedValue,
} from "./console.js";
import { formatQbskError } from "../../src/interp/error.js";
import { parse } from "../../src/parser/parser.js";
import type { SceneRun, StudioFrame } from "../shared/api.js";

// Reads a scene file chosen through the Open dialog (studio/main/index.ts). Pulled out
// of the ipcMain handler so the actual read + failure handling is unit-testable headless
// — the dialog call itself is the only part that genuinely needs Electron. A file that
// vanishes between the dialog resolving and this read (or any other read failure) is not
// a crash: it returns null, which the renderer already treats the same as a user cancel.
export function readScene(file: string): { file: string; source: string } | null {
  try {
    return { file, source: readFileSync(file, "utf8") };
  } catch {
    return null;
  }
}

// Static scene: the same pipeline the CLI runs (`qbsk run --ansi`), producing
// the plain-text rows, the ANSI bytes and the diff that drives the DOM painter.
export function runStaticScene(
  source: string,
  file: string,
  cellAspect?: number,
): SceneRun {
  const t0 = performance.now();
  const result = runQbsk(source, file, { print: () => {} }, {
    baseDir: dirname(resolve(file)),
    // Absent means "the caller does not know its font", and the engine's documented
    // 2.0 stands. Passing a guess instead would make the default unfindable.
    cellAspect,
  });
  const elapsedMs = performance.now() - t0;
  if (result.error !== null) {
    return {
      ok: false,
      text: [],
      ansi: "",
      diff: [],
      cells: 0,
      width: 0,
      height: 0,
      elapsedMs,
      error: formatQbskError(source, result.error),
    };
  }
  if (result.canvas === null) {
    return {
      ok: true,
      text: [],
      ansi: "",
      diff: [],
      cells: 0,
      width: 0,
      height: 0,
      elapsedMs,
      error: null,
    };
  }
  const canvas = result.canvas;
  const buffer = new ScreenBuffer(canvas.width, canvas.height);
  buffer.paintCanvas(canvas);
  const diff: DiffLine[] = computeDiff(
    buffer.front,
    buffer.back,
    buffer.width,
    buffer.dirtyLines,
  );
  const ansi = renderFrame(diff, buffer.width);
  const cells = diff.reduce((acc, d) => acc + d.changed, 0);
  return {
    ok: true,
    text: canvas.renderText().split("\n"),
    ansi,
    diff,
    cells,
    width: canvas.width,
    height: canvas.height,
    elapsedMs,
    error: null,
  };
}

// Animated frame host: mirrors the CLI `--ansi --loop` loop (spec engine.md §7).
// The AST is parsed once and the SceneProgram runs the top level once; each frame
// the clock advances, the event handlers dispatch and the scene re-composes from
// the live environment; the double buffer + computeDiff produce the diff for the
// DOM painter.
export class StudioFrameHost implements ConsoleTarget {
  private readonly baseDir: string;
  private readonly source: string;
  private readonly file: string;
  /** The chosen font's cell shape (F0 §11.16), or undefined for the engine's 2.0. */
  private readonly cellAspect: number | undefined;
  private program: SceneProgram | null;
  private parseError: string | null;
  private readonly runtime: GameRuntime = { gameTime: 0 };
  private buffer: ScreenBuffer | null = null;
  /**
   * The tones the last frame composed (docs/audio.md §4).
   *
   * Kept beside the frame rather than inside StudioFrame: the audio device lives in
   * the same process as this host, so sending the plan over IPC to the renderer and
   * back would be pure traffic for no one.
   */
  private audio: TonePlanEntry[] = [];
  private width = 0;
  private height = 0;

  constructor(source: string, file: string, cellAspect?: number) {
    this.baseDir = dirname(resolve(file));
    this.source = source;
    this.file = file;
    this.cellAspect = cellAspect;
    const built = this.build();
    this.program = built.program;
    this.parseError = built.error;
  }

  private build(): { program: SceneProgram | null; error: string | null } {
    const parsed = parse(this.source, this.file);
    if (parsed.errors.length > 0) {
      return {
        program: null,
        error: formatQbskError(this.source, parsed.errors[0]!),
      };
    }
    return {
      program: new SceneProgram(parsed.ast, {
        baseDir: this.baseDir,
        runtime: this.runtime,
        cellAspect: this.cellAspect,
      }),
      error: null,
    };
  }

  /**
   * Replaces the data `host()` serves (docs/studio.md §14.6).
   *
   * Assigned into the SAME runtime object the program holds, so the next `step()` sees
   * it; a fresh runtime would silently detach the program from its own clock.
   */
  setHostData(data: Record<string, HostValue>): void {
    this.runtime.host = data;
  }

  // --- ConsoleTarget (docs/studio.md §14) ---
  //
  // The console reaches the LIVE program through these, and nothing else. There is no
  // filesystem here and no shell: `reload` re-runs the source this host was built with,
  // it does not read a new one.

  /**
   * The names the SCENE defined, sorted.
   *
   * Natives are filtered out. Unfiltered, `vars` answered with
   * `canvas fill box put line print len type str int float bool clock…` — the
   * language's own built-ins, which the user already knows and did not ask about,
   * burying the handful of names they actually wanted. The most useful command in
   * the console was returning noise.
   */
  varNames(): string[] {
    const env = this.program?.liveEnv;
    if (env === undefined) {
      return [];
    }
    return env
      .names()
      .filter((name) => env.kindOf(name) !== "native")
      .sort();
  }

  inspect(name: string): InspectedValue | null {
    const value = this.program?.liveEnv.get(name);
    if (value === undefined) {
      return null;
    }
    return { type: typeName(value), text: qbskStr(value) };
  }

  evalSnippet(source: string): EvalOutcome {
    if (this.program === null) {
      return { out: [], error: "no program is running", value: null };
    }
    const res = this.program.evalSnippet(source, "console.qbsk");
    return {
      out: res.out,
      error: res.error === null ? null : formatQbskError(source, res.error),
      // A statement evaluates to nothing, and printing "null" after every assignment
      // would bury the output that matters.
      value:
        res.value === null || res.value.type === "null"
          ? null
          : qbskStr(res.value),
    };
  }

  /** The turn clock, or null for a program that never advances one. */
  simState(): { turn: number; pending: number } | null {
    const sim = this.runtime.sim;
    return sim === undefined ? null : { turn: sim.turn, pending: sim.pending };
  }

  /**
   * Reads a variable as a list of entities (docs/engine.md §12.2).
   *
   * Null when it is not one, so the console can say so instead of printing an empty
   * table — a table with no rows looks like "there are none", which is a different
   * and much more misleading answer than "that is not a list of entities".
   */
  entities(name: string): EntityRow[] | null {
    const value = this.program?.liveEnv.get(name);
    if (value === undefined || value.type !== "list") {
      return null;
    }
    const rows: EntityRow[] = [];
    for (const item of value.items) {
      if (item.type !== "dict") {
        return null;
      }
      const id = item.map.get("id");
      if (id === undefined || id.type !== "int") {
        return null;
      }
      const components: Record<string, string | number | boolean> = {};
      for (const [key, component] of item.map) {
        if (key === "id") {
          continue;
        }
        // Rendered with the language's own str(), so what the table shows is what the
        // program would print — one representation, not a second one to keep in step.
        components[key] = qbskStr(component);
      }
      rows.push({ id: id.value, components });
    }
    return rows;
  }

  reload(): void {
    const built = this.build();
    this.program = built.program;
    this.parseError = built.error;
    // Force a full repaint: the new program starts at gameTime 0 and the old diff
    // baseline would make the first frame look like nothing changed.
    this.buffer = null;
    this.runtime.gameTime = 0;
  }

  get error(): string | null {
    if (this.parseError !== null) {
      return this.parseError;
    }
    if (this.program !== null && this.program.error !== null) {
      return formatQbskError(this.source, this.program.error);
    }
    return null;
  }

  /**
   * Queues a key for the next frame (docs/studio.md §14.5).
   *
   * The name must already be canonical — `keyFromDom` in `src/engine/keys.ts` is what
   * turns a DOM `KeyboardEvent.key` into one. Matching downstream is an exact lookup
   * with no normalisation, so a host that spells a key its own way produces a handler
   * that silently never fires.
   *
   * A press before the first `next()` is kept, not dropped: the queue drains inside
   * `step()`, so the very first frame already reflects it.
   */
  pressKey(name: string): void {
    this.program?.pressKey(name);
  }

  /** The tones the last `next()` composed, for a host that owns an AudioDevice. */
  get audioPlan(): TonePlanEntry[] {
    return this.audio;
  }

  /** The program clock, which the audio device needs to time its triggers. */
  get gameTime(): number {
    return this.runtime.gameTime;
  }

  /** Queues a resize for the next frame. Same contract as `pressKey`. */
  resize(width: number, height: number): void {
    this.program?.resize(width, height);
  }

  next(dt: number): StudioFrame | null {
    if (this.program === null || this.parseError !== null) {
      return null;
    }
    // gameTime is advanced by SceneProgram.step (interpreter.ts): the clock
    // belongs to the program, so no host has to remember to tick it.
    const t0 = performance.now();
    const frame = this.program.step(dt);
    this.audio = frame.audioPlan;
    const t1 = performance.now();
    if (frame.error !== null || frame.canvas === null) {
      return null;
    }
    const canvas = frame.canvas;
    const t2 = performance.now();
    if (
      this.buffer === null ||
      this.buffer.width !== canvas.width ||
      this.buffer.height !== canvas.height
    ) {
      this.buffer = new ScreenBuffer(canvas.width, canvas.height);
      this.width = canvas.width;
      this.height = canvas.height;
    }
    this.buffer.paintCanvas(canvas);
    const t3 = performance.now();
    const diff = computeDiff(
      this.buffer.front,
      this.buffer.back,
      this.buffer.width,
      this.buffer.dirtyLines,
    );
    const ansi = renderFrame(diff, this.buffer.width);
    const t4 = performance.now();
    const cells = diff.reduce((acc, d) => acc + d.changed, 0);
    const text = canvas.renderText().split("\n");
    this.buffer.swap();
    return {
      width: this.width,
      height: this.height,
      diff,
      text,
      ansi,
      metrics: {
        scriptMs: t1 - t0,
        composeMs: t2 - t1,
        diffMs: t3 - t2,
        emitMs: t4 - t3,
        cells,
        bytes: ansi.length,
      },
    };
  }
}
