import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { KEYWORDS } from "../lexer/token.js";
import { QUEUE_LIMIT } from "../engine/keys.js";
import type { Span } from "../lexer/token.js";
import type { Assign, Block, EventDecl, Expr, LayerDecl, NamedArg, Program, PutStmt, SceneDecl, Stmt, UseStmt } from "../parser/ast.js";
import { NAMEABLE_DSL_WORDS, parse } from "../parser/parser.js";
import { loadQbdata } from "../parser/qbdata.js";
import { closest } from "../util/suggest.js";
import { Env } from "./env.js";
import type { QbskError, QbskFrame } from "./error.js";
import { QbskRuntimeError } from "./error.js";
import { createNatives, ExitSignal, type GameRuntime, type HostIO, type SaveStore } from "./natives.js";
import { mountScene } from "./sceneMount.js";
import {
  ANCHOR_NAMES,
  anchorOffset,
  loadQba,
  QbaError,
  scaleArt,
  type QbaSprite,
} from "../engine/sprite.js";
import { pickFrame } from "../choreo/frames.js";
import { isWaveName, WAVE_NAMES, type TonePlanEntry, type WaveName } from "../audio/tone.js";
import { isShadeName, SHADE_NAMES, applyShades, type ShadeName, type ShadeSpec } from "../engine/shade.js";
import { composeScene } from "../choreo/scene.js";
import { StaticLayerCache } from "../choreo/scene.js";
import { analyzeLayerStaticity } from "../analyze/analyzer.js";
import { looksHex, NAMED_COLORS, resolveColor } from "../engine/color.js";
import type { Canvas } from "../engine/canvas.js";
import { assertCellAspect, DEFAULT_CELL_ASPECT } from "../engine/stroke.js";

/**
 * Natives that edit their argument rather than returning a new value.
 *
 * Read out of `natives.ts` by hand and pinned by a test, because a mutator missing from
 * this set is a layer held stale -- the §14 failure shape, arriving silently. The test
 * calls each one and checks the epoch moved, so adding a mutator without listing it here
 * fails rather than passes.
 */
const MUTATING_NATIVES = new Set(["push", "pop", "sort", "reverse"]);

/**
 * Statement kinds that BIND A NAME in the block they appear in.
 *
 * A kind missing here means a declaration landing in the enclosing scope instead of its
 * own. That failure is LOUD — the second execution reports "already defined in this
 * scope" — so the conservative direction is to add a kind when unsure: an extra entry
 * costs one allocation, a missing one is a bug.
 */
const DECLARING_STATEMENTS: ReadonlySet<string> = new Set([
  "VarDecl", "ConstDecl", "FuncDecl", "UseStmt", "CanvasDecl",
  "SceneDecl", "LayerDecl", "EventDecl",
]);


import {
  isNumber,
  qbskAdd,
  qbskBitwise,
  qbskCmp,
  qbskDiv,
  qbskEq,
  qbskMod,
  qbskMul,
  qbskNeg,
  qbskStr,
  qbskSub,
  truthy,
  typeName,
  type DslStyle,
  type LayerEffects,
  type MaskedCells,
  type QValue,
} from "./value.js";

/**
 * The named-argument vocabularies (§15, invariant I1).
 *
 * Written together, deliberately: these ARE the closed sets, and keeping them in one
 * place is what makes "did anyone forget a construct?" answerable by looking rather than
 * by auditing. A primitive that takes `key: value` and is not listed here is a primitive
 * that accepts anything — which is how five of them ended up silently ignoring keys.
 */
const SPRITE_PROPS = ["anchor", "scale", "frames", "fps", "loop"] as const;
const TONE_PROPS = ["wave", "duration", "volume", "loop"] as const;
const SHADE_PROPS = ["x", "y", "radius", "tint", "strength", "speed"] as const;
const COLOR_PROPS = ["fg", "bg"] as const;

/**
 * The call-depth ceiling (§15.4). A language constant, not a JavaScript accident: the
 * same program fails at the same depth with the same message on every host, instead of
 * wherever V8 happens to run out of frames.
 *
 * MEASURED, not guessed. One QBSK call costs several JS frames — since F6 the chain is
 * `exprThunk → callValue → execBody → blockThunk → stmtThunk → exprThunk…`, one frame
 * per compiled node rather than per switch arm, but the same order of magnitude and
 * re-checked at 240 deep with a 120-deep nested expression per frame after the rewrite.
 * On Node's default stack V8 gives out between 400 and 600 QBSK frames, so
 * a "safe-looking" 2000 would never be reached and the raw RangeError would win the race
 * — which is the bug this constant exists to prevent. 250 leaves room for the frames the
 * host itself is using when the limit is hit.
 */
const MAX_CALL_DEPTH = 250;

class ReturnSignal {
  constructor(public readonly value: QValue) {}
}

class BreakSignal {
  /**
   * §15.22 — the loop named, or null for the innermost one.
   *
   * The span travels with it because the error for a signal that leaves a function is
   * raised at the FUNCTION boundary, and it has to point at the `break`, not at the call.
   */
  constructor(
    readonly label: string | null,
    readonly span: Span,
  ) {}
}

class ContinueSignal {
  constructor(
    readonly label: string | null,
    readonly span: Span,
  ) {}
}

export interface RunResult {
  out: string[];
  error: QbskError | null;
  exitCode: number | null;
  canvas: Canvas | null;
  /** How many in-place edits the run performed (§11.19). Zero means nothing was edited. */
  mutationEpoch: number;
  /**
   * What the composed scene declared about itself (§14.3): `{ title, fps }`, each
   * `null` when the program did not say. `null` when no scene composed at all.
   *
   * This exists because `title:`/`fps:` were in the grammar and in the examples while
   * nothing in the implementation ever read them. A host needs a way to receive them
   * or they are decoration.
   */
  sceneInfo: SceneInfo | null;
  /**
   * The tones this composition triggered (docs/audio.md §5). Deterministic: the
   * same (scene, game time) always yields the same list. Playback is wall-clock
   * and never part of a golden — the plan is what gets asserted.
   */
  audioPlan: TonePlanEntry[];
}

/** Scene metadata as declared, never defaulted (§14.3). */
export interface SceneInfo {
  title: string | null;
  fps: number | null;
}

export interface InterpOptions {
  baseDir?: string;
  /**
   * The screen cell's height over its width, for the glyph choices that depend on it
   * (docs/engine.md §11.16). Defaults to DEFAULT_CELL_ASPECT.
   *
   * It arrives here rather than being read from the font because `src/` cannot import
   * from `studio/` (docs/studio.md §2), and because the terminal renderer cannot know
   * the user's terminal font at all. Whoever knows the number passes it.
   *
   * Fixed for the lifetime of a run: the static-layer cache holds cells already
   * composed at this aspect, so letting it change mid-run would replay a layer drawn
   * at one cell shape into a scene using another.
   */
  cellAspect?: number;
  scriptArgs?: string[];
  runtime?: GameRuntime;
  // an earlier release: called when an EventDecl is evaluated in the entry program (never in
  // modules) — lets the persistent SceneProgram collect the handlers it dispatches.
  onEvent?: (decl: EventDecl) => void;
  // an earlier release: print sink for `print` calls from the persistent top level and from
  // event handlers. Falls back to a no-op when unset.
  print?: (line: string) => void;
  // Studio MCP (docs/studio.md §11.4): when set, this becomes the interpreter's
  // base environment instead of a fresh native env. Used by SceneProgram.evalSnippet
  // so a snippet reads the live top-level bindings while its own declarations stay
  // scoped to the native env's parent chain.
  liveEnv?: Env;
  // Save storage (docs/language.md §13.5): where save_state/load_state/list_saves
  // read and write. Absent = this host has no save storage.
  saveStore?: SaveStore;
  /** Internal static-layer test switch; production ScenePrograms leave caching enabled. */
  staticLayerCache?: boolean;
  /** Parsed layer identity to cache key, supplied by SceneProgram after analysis. */
  staticLayerKeys?: ReadonlyMap<LayerDecl, number>;
  /**
   * Top-level names each DYNAMIC, read-tracked layer depends on (§11.19).
   *
   * Only layers the analyzer reports as `readTracked` belong here. A layer whose reads
   * do not explain why it moves — `gameTime()`, an animated sprite — must be absent, or
   * it is reused forever.
   */
  layerReads?: ReadonlyMap<LayerDecl, readonly string[]>;
}

export function runQbsk(
  source: string,
  file = "test.qbsk",
  io?: HostIO,
  opts?: InterpOptions,
): RunResult {
  const out: string[] = [];
  const sink: HostIO = io ?? { print: (line) => out.push(line) };
  const result: RunResult = {
    out, error: null, exitCode: null, canvas: null, sceneInfo: null,
    audioPlan: [], mutationEpoch: 0,
  };
  const parsed = parse(source, file);
  if (parsed.errors.length > 0) {
    result.error = parsed.errors[0] ?? null;
    return result;
  }
  const interpreter = new Interpreter(sink, {
    baseDir: opts?.baseDir ?? dirname(file),
    scriptArgs: opts?.scriptArgs ?? [],
    runtime: opts?.runtime,
    saveStore: opts?.saveStore,
    cellAspect: opts?.cellAspect,
  });
  try {
    interpreter.evalProgram(parsed.ast);
    result.audioPlan = interpreter.audioPlan;
    if (interpreter.lastScene !== null) {
      const def = mountScene(interpreter.lastScene);
      if (def !== null) {
        result.sceneInfo = { title: def.title ?? null, fps: def.fps ?? null };
        result.canvas = composeScene(def, undefined, interpreter.cellAspect);
        applyShades(result.canvas, interpreter.shadePlan, opts?.runtime?.gameTime ?? 0);
        for (const line of result.canvas.renderText().split("\n")) {
          sink.print(line);
        }
      }
    }
    result.mutationEpoch = interpreter.mutationEpoch;
  } catch (err) {
    result.mutationEpoch = interpreter.mutationEpoch;
    if (err instanceof ExitSignal) {
      result.exitCode = err.code;
      return result;
    }
    if (err instanceof QbskRuntimeError) {
      result.error = err;
      return result;
    }
    throw err;
  }
  return result;
}

// Per-frame evaluation for the frame loop (spec language.md §7.7): ONE persistent
// interpreter runs the top level ONCE; per frame the event handlers run and the scene
// re-composes from the live environment. The host advances runtime.gameTime (fixed
// timestep) before each step — step() never touches the clock itself.
export interface SceneFrame {
  canvas: Canvas | null;
  error: QbskError | null;
  exitCode: number | null;
  /** Tones visible on this frame (docs/audio.md §5). */
  audioPlan: TonePlanEntry[];
}

// Result of evaluating an arbitrary snippet against the live environment
// (docs/studio.md §11.4, the `qbsk_eval` tool). The snippet runs in the live
// top-level environment: reads see live values, declarations that collide with an
// existing binding are rejected (never clobber program state), `print` is captured,
// and if the snippet declares a scene it is composed into a canvas the caller can
// render as a grid snapshot.
export interface SnippetRun {
  out: string[];
  error: QbskError | null;
  exitCode: number | null;
  canvas: Canvas | null;
  value: QValue | null;
}

export class SceneProgram {
  private readonly interp: Interpreter;
  private readonly runtime_owned: GameRuntime;
  private readonly program: Program;
  private readonly startHandlers: EventDecl[] = [];
  private readonly tickHandlers: EventDecl[] = [];
  private readonly turnHandlers: EventDecl[] = [];
  private readonly keyHandlers = new Map<string, EventDecl[]>();
  private readonly resizeHandlers: EventDecl[] = [];
  private readonly keyQueue: string[] = [];
  private readonly resizeQueue: { w: number; h: number }[] = [];
  /** Where the program's own output goes. */
  private readonly programPrint: (line: string) => void;
  /**
   * Where `print` currently writes. Normally the program's sink; during a snippet it
   * is the snippet's, so an eval owns the lines it produced and the program's mirror
   * is not shown text the program never printed.
   */
  private printTarget: ((line: string) => void) | null = null;
  private readonly staticLayerKeys: ReadonlyMap<LayerDecl, number>;
  private readonly layerReads: ReadonlyMap<LayerDecl, readonly string[]>;
  private readonly staticLayerCache: StaticLayerCache | null;
  private started = false;
  // Only events evaluated during bootstrap (the top-level run) are collected;
  // per-frame re-composition re-visits the scene body and must not re-register.
  private collecting = true;
  public error: QbskError | null;
  public exitCode: number | null;

  // The runtime clock the host advances between frames (docs/studio.md §5).
  get runtime(): GameRuntime {
    return this.runtime_owned;
  }

  private printSink(line: string): void {
    if (this.printTarget !== null) {
      this.printTarget(line);
      return;
    }
    this.programPrint(line);
  }

  // The live top-level environment (docs/studio.md §11.4): what qbsk_inspect reads.
  get liveEnv(): Env {
    return this.interp.liveEnv;
  }

  /**
   * Whether any `on key` handler is bound to this name (docs/studio.md §16.2).
   *
   * A host needs this to answer "was the key handled" without inferring it from side
   * effects, because "no handler is bound" and "the handler ran and did nothing" look
   * identical from outside and are different facts. Read-only: it reports the binding,
   * it does not create or dispatch one.
   */
  hasKeyHandler(name: string): boolean {
    return this.keyHandlers.has(name);
  }

  constructor(program: Program, opts: InterpOptions = {}) {
    this.program = program;
    this.runtime_owned = opts.runtime ?? { gameTime: 0 };
    // One analysis, two populations. E1 takes the layers proven static; F4 takes the
    // dynamic ones whose reads explain why they move (§11.19). The third group — dynamic
    // and NOT read-tracked — belongs to neither and is composed every frame, which is
    // the whole point of asking `readTracked` rather than settling for `reads`.
    const analysis = opts.staticLayerCache === false ? [] : analyzeLayerStaticity(program);
    this.staticLayerKeys = new Map(
      analysis.filter((layer) => layer.static)
        .map((layer, index) => [layer.layer, index] as const),
    );
    this.layerReads = new Map(
      analysis.filter((layer) => !layer.static && layer.readTracked)
        .map((layer) => [layer.layer, [...layer.reads]] as const),
    );
    this.staticLayerCache = opts.staticLayerCache === false ? null : new StaticLayerCache();
    // The program's print sink is REDIRECTABLE, and evalSnippet is why. `print` is a
    // native resolved through the env chain, so a snippet sharing `liveEnv` finds this
    // interpreter's native — not its own. Rebuilding natives for the snippet cannot fix
    // that (the shared env is the point), so the sink itself moves for the duration of
    // the snippet instead. Everything downstream keeps calling one `print` and the
    // lines land wherever the current owner of the interpreter says.
    this.programPrint = opts.print ?? (() => {});
    this.interp = new Interpreter({ print: (line) => this.printSink(line) }, {
      baseDir: opts.baseDir,
      cellAspect: opts.cellAspect,
      scriptArgs: opts.scriptArgs,
      runtime: this.runtime_owned,
      saveStore: opts.saveStore,
      onEvent: (decl) => {
        if (this.collecting) {
          this.register(decl);
          return;
        }
        // §14.4 — the registration window closed. This is reached when a handler is
        // declared by code that runs AFTER the top-level pass: a function called
        // from another handler, for instance. The declaration evaluates fine and
        // then went nowhere, so the key simply never responded and nothing said why.
        //
        // Not reached by per-frame re-composition: that re-visits the scene body,
        // whose EventDecls were already registered during bootstrap, and it is
        // exactly why this window exists. Re-registering them each frame would stack
        // duplicate handlers, so the flag stays and only its silence is removed.
        throw new QbskRuntimeError(
          "an 'on' handler declared here can never register — handlers register while the top-level program runs (§7.7)",
          decl.span,
        );
      },
      staticLayerKeys: this.staticLayerKeys,
      layerReads: this.layerReads,
    });
    let error: QbskError | null = null;
    let exitCode: number | null = null;
    try {
      // The top-level program runs ONCE here (spec language.md §7.7).
      this.interp.evalProgram(program);
    } catch (err) {
      if (err instanceof ExitSignal) {
        exitCode = err.code;
      } else if (err instanceof QbskRuntimeError) {
        error = err;
      } else {
        throw err;
      }
    } finally {
      this.collecting = false;
    }
    this.error = error;
    this.exitCode = exitCode;
  }

  // Evaluates a QBSK snippet against the live top-level environment, sharing this
  // program's baseDir and runtime clock. The snippet's top level is evaluated ONCE
  // (never re-runs the host program, never re-dispatches the host events); its own
  // scene is composed if it declares one. Existing live bindings win over the
  // snippet's declarations (`define` raises, exactly like a normal redefinition).
  evalSnippet(source: string, file = "eval.qbsk"): SnippetRun {
    const out: string[] = [];
    // Studio snippets share live references with the program and can mutate indexed
    // data beside a const binding. Invalidate before even parsing: every attempted eval
    // is an editing boundary, and correctness is cheaper than proving what it changed.
    if (this.staticLayerCache !== null) {
      this.staticLayerCache.invalidate();
      this.interp.invalidateStaticLayers();
    }
    const parsed = parse(source, file);
    if (parsed.errors.length > 0) {
      return {
        out,
        error: parsed.errors[0] ?? null,
        exitCode: null,
        canvas: null,
        value: null,
      };
    }
    const interp = new Interpreter({ print: (line) => out.push(line) }, {
      baseDir: this.interp.baseDir,
      cellAspect: this.interp.cellAspect,
      runtime: this.runtime_owned,
      liveEnv: this.liveEnv,
    });
    let canvas: Canvas | null = null;
    // `print` resolves through the shared live env to the PROGRAM's native, so the
    // snippet's own natives never see the call. Redirecting the program's sink for the
    // duration is what makes the output the snippet's. Restored in `finally`: a snippet
    // that throws must not leave every later `print` writing into a dead array.
    this.printTarget = (line) => out.push(line);
    try {
      interp.evalProgram(parsed.ast);
      if (interp.lastScene !== null) {
        const def = mountScene(interp.lastScene);
        if (def !== null) {
          canvas = composeScene(def, undefined, this.interp.cellAspect);
        }
      } else {
        // The snippet declared no scene of its own: re-compose the live program's
        // scene from the live environment so the agent sees the effect of its eval
        // on what the window is actually drawing (docs/studio.md §11.4).
        this.interp.audioPlan = [];
        this.interp.shadePlan = [];
        const scene = this.interp.recomposeScene(this.program);
        if (scene !== null) {
          const def = mountScene(scene, this.staticLayerCache ?? undefined);
          if (def !== null) {
            canvas = composeScene(
              def,
              this.staticLayerCache ?? undefined,
              this.interp.cellAspect,
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof ExitSignal) {
        return { out, error: null, exitCode: err.code, canvas: null, value: null };
      }
      if (err instanceof QbskRuntimeError) {
        return { out, error: err, exitCode: null, canvas: null, value: null };
      }
      throw err;
    } finally {
      this.printTarget = null;
    }
    return {
      out,
      error: null,
      exitCode: null,
      canvas,
      value: interp.lastExprValue,
    };
  }

  // Input for `on key` handlers: FIFO, drained at the next step. The terminal
  // raw-mode binding is M19; Studio feeds Electron key events through this queue.
  pressKey(name: string): void {
    // Capped, dropping the OLDEST (docs/engine.md §8.2). The queue was unbounded and
    // drained fully in one step: 50 000 presses measured at 832 ms in a single frame,
    // which a held arrow under OS key repeat can reach. Keeping the newest is the
    // right end to keep — it is the input the player still means.
    if (this.keyQueue.length >= QUEUE_LIMIT) {
      this.keyQueue.shift();
    }
    this.keyQueue.push(name);
  }

  resize(w: number, h: number): void {
    this.resizeQueue.push({ w, h });
  }

  private register(decl: EventDecl): void {
    switch (decl.event) {
      case "start":
        this.startHandlers.push(decl);
        break;
      case "tick":
        this.tickHandlers.push(decl);
        break;
      case "key": {
        const key = decl.keyName ?? "";
        const list = this.keyHandlers.get(key);
        if (list === undefined) {
          this.keyHandlers.set(key, [decl]);
        } else {
          list.push(decl);
        }
        break;
      }
      case "turn":
        this.turnHandlers.push(decl);
        break;
      case "resize":
        this.resizeHandlers.push(decl);
        break;
    }
  }

  // One logical frame: dispatch start (once) → tick → queued keys → queued resizes,
  // then re-compose the scene from the live environment (spec language.md §7.7).
  step(dt: number): SceneFrame {
    if (this.error !== null) {
      return { canvas: null, error: this.error, exitCode: null, audioPlan: [] };
    }
    if (this.exitCode !== null) {
      return { canvas: null, error: null, exitCode: this.exitCode, audioPlan: [] };
    }
    // The clock belongs to the program, not to whoever is driving it. It used to
    // be the host's job (three separate call sites all doing `gameTime += dt`), so
    // any new host — or any test — that forgot it got a frozen clock, and with
    // tweens that means frozen animation. Advancing here makes it impossible to
    // forget, and it happens BEFORE handlers so `on tick` sees the new time.
    this.runtime_owned.gameTime += dt;
    try {
      if (!this.started) {
        this.started = true;
        // Guards (§6.6) are evaluated for ALL handlers of a delivery BEFORE any of
        // them runs — a handler's state change affects the next event, never the
        // one being answered. The same two-phase shape at every dispatch site.
        for (const h of this.startHandlers.filter((h) => this.interp.guardHolds(h))) {
          this.interp.dispatchEvent(h, []);
        }
      }
      for (const h of this.tickHandlers.filter((h) => this.interp.guardHolds(h))) {
        this.interp.dispatchEvent(h, [{ type: "float", value: dt }]);
      }
      // Repeat coalescing (docs/engine.md §8.3): within ONE frame, repeated presses of
      // the same key dispatch once. A held arrow under OS auto-repeat used to move the
      // player once per PRESS — measured at 20 cells for 20 presses landing in a single
      // frame — which let the operating system's repeat rate set the game's movement
      // speed, differently on every machine. Now a held key moves one cell per frame, a
      // rate the game controls through `fps:`.
      //
      // Order is preserved: different keys in the same frame all dispatch, in arrival
      // order. The queue is drained completely either way, so §8.2's cap still bounds
      // the memory; this bounds the WORK.
      const pressed = new Set<string>();
      const order: string[] = [];
      while (this.keyQueue.length > 0) {
        const name = this.keyQueue.shift()!;
        if (!pressed.has(name)) {
          pressed.add(name);
          order.push(name);
        }
      }
      for (const name of order) {
        const handlers = this.keyHandlers.get(name);
        if (handlers !== undefined) {
          for (const h of handlers.filter((h) => this.interp.guardHolds(h))) {
            this.interp.dispatchEvent(h, []);
          }
        }
      }
      // Turns (docs/engine.md §12.3). The pending count is taken and CLEARED before
      // dispatching, so an `advance()` called from inside a turn handler lands on the
      // next frame instead of extending this one. That makes an infinite loop within a
      // single frame impossible to write by accident, and it falls out of the ordering
      // rather than needing a guard.
      const sim = this.runtime_owned.sim;
      if (sim !== undefined) {
        const due = sim.pending;
        sim.pending = 0;
        for (let i = 0; i < due; i += 1) {
          sim.turn += 1;
          for (const handler of this.turnHandlers.filter((h) => this.interp.guardHolds(h))) {
            this.interp.dispatchEvent(handler, [
              { type: "int", value: sim.turn },
            ]);
          }
        }
      }
      while (this.resizeQueue.length > 0) {
        const { w, h } = this.resizeQueue.shift()!;
        for (const handler of this.resizeHandlers.filter((h) => this.interp.guardHolds(h))) {
          this.interp.dispatchEvent(handler, [
            { type: "int", value: w },
            { type: "int", value: h },
          ]);
        }
      }
      // Clear before composing: the plan is a pure function of THIS frame, never an
      // accumulation across frames (docs/audio.md §5).
      this.interp.audioPlan = [];
      this.interp.shadePlan = [];
      const scene = this.interp.recomposeScene(this.program);
      if (scene === null) {
        return { canvas: null, error: null, exitCode: null, audioPlan: [] };
      }
      const def = mountScene(scene, this.staticLayerCache ?? undefined);
      if (def === null) {
        return { canvas: null, error: null, exitCode: null, audioPlan: [] };
      }
      // The plan the composition just produced. Read AFTER composing, because it is
      // filled while the layers evaluate (docs/audio.md §5).
      // Shades run on the composed canvas, before the caller diffs it: they change
      // colour only, so the diff still sees a normal grid (docs/engine.md §11.6).
      const canvas = composeScene(
        def,
        this.staticLayerCache ?? undefined,
        this.interp.cellAspect,
      );
      applyShades(canvas, this.interp.shadePlan, this.runtime.gameTime);
      return {
        canvas,
        error: null,
        exitCode: null,
        audioPlan: this.interp.audioPlan,
      };
    } catch (err) {
      if (err instanceof ExitSignal) {
        this.exitCode = err.code;
        return { canvas: null, error: null, exitCode: err.code, audioPlan: [] };
      }
      if (err instanceof QbskRuntimeError) {
        this.error = err;
        return { canvas: null, error: err, exitCode: null, audioPlan: [] };
      }
      throw err;
    }
  }

  /** Focused headless evidence for static-layer; not exposed to the QBSK language. */
  staticCacheStats(): {
    staticLayers: number;
    hits: number;
    misses: number;
    invalidations: number;
  } {
    const stats = this.staticLayerCache?.stats() ?? { hits: 0, misses: 0, invalidations: 0 };
    return { staticLayers: this.staticLayerKeys.size, ...stats };
  }

  /** Focused headless evidence for an earlier release; not exposed to the QBSK language. */
  invalidationStats(): { eligible: number; hits: number; misses: number } {
    return this.interp.invalidationStats();
  }
}

/**
 * A compiled expression: a function OF an interpreter, never a closure OVER one.
 *
 * The compiled tree is memoised on the syntax tree, which is the only place reachable
 * without a lookup per evaluation — and a syntax tree outlives the interpreter that
 * first ran it. The studio reloads a program, `use` caches a module, a test parses once
 * and runs twice. Taking `ip` as an argument is what makes that cache sound; capturing
 * `this` would let the second run read the first run's variables, silently.
 * `tests/unit/compiled-tree.test.ts` is that property written down.
 *
 * The same reasoning licenses sharing one QValue per literal: `Env.write` rebinds a
 * `Binding`, it never writes through to the value, so no QValue is ever edited in place
 * — and the invalidation cache (§11.19) compares scalars by value, so a shared literal
 * is indistinguishable from a fresh one except in what it costs to make.
 */
type Thunk = (ip: Interpreter) => QValue;

/** An expression node with its compiled form attached. */
type Compilable = Expr & { compiled?: Thunk };

/** A compiled statement. `null` unless it produced a drawing primitive (§11.11). */
type StmtThunk = (ip: Interpreter) => QValue | null;

/** A compiled block: its statements, and its scope decision, settled at compile time. */
type BlockThunk = (ip: Interpreter) => void;

/** A statement node with its compiled form attached. */
type CompilableStmt = Stmt & { compiledStmt?: StmtThunk };

/** A block node with its compiled form attached. */
type CompilableBlock = Block & { compiledBlock?: BlockThunk };
/**
 * "must be an int" plus, when the value is a float, what to write instead (§15.17).
 *
 * `/` returns a float whatever its operands and §17.1 freezes that, so the fix is the
 * diagnosis rather than the arithmetic. The advice is attached ONLY to floats: on a string
 * or a bool index it would be noise, and noise is how a good diagnostic stops being read.
 *
 * One function for all four index sites — a list read, a list write, a string and a tuple.
 * Written for one of them and not the others it would be the same defect with better odds.
 */
function indexTypeError(what: string, index: QValue): string {
  const base = `a ${what} index must be an int, got '${typeName(index)}'`;
  if (index.type !== "float") {
    return base;
  }
  return (
    base +
    " — `/` is float division whatever its operands, so wrap the arithmetic: int(a / b)"
  );
}

export class Interpreter {
  private env: Env;
  private readonly nativeEnv: Env;
  private loopDepth = 0;
  private functionDepth = 0;
  private readonly baseDir_owned: string;
  /** Cell shape for glyph choices that depend on it (§11.16). Fixed for this run. */
  readonly cellAspect: number;

  /**
   * Bumped whenever a value is edited IN PLACE, as opposed to rebound.
   *
   * Invalidation caching (§11.19) compares what a layer read between frames, and
   * identity cannot answer the question on its own: `d["k"] = v` and `push(l, x)` change
   * contents while the object stays the same one. Module dicts are mutable too, despite
   * the spec (tests/unit/module-mutability.test.ts), so this covers them as well.
   *
   * A single counter for the whole program rather than one per value: it is conservative
   * in the safe direction — any edit anywhere invalidates every invalidation-cached
   * layer — and cheap enough that the conservatism costs nothing on a frame where
   * nothing was edited, which is the frame this cache exists for. Per-value versions
   * would be less blunt and would need every mutation site to know which value it
   * touched; that is a bigger surface for the failure that matters here, a layer held
   * stale because one site forgot to report.
   */
  mutationEpoch = 0;
  /**
   * Containers created during the evaluation of the layer now being composed.
   *
   * A mutation of one of these cannot be observed by any CACHED layer: every such entry
   * was written before this layer began, so none of them can reach a container that did
   * not exist then. For it to become observable it must first be attached to something
   * older — and attaching is itself a mutation of that older thing, which does bump.
   *
   * That is what makes the epoch usable. Without it, `cinematic.qbsk`'s `wrap` calling
   * `push` on a list it just built invalidated every cached layer in the frame, and
   * cell_block.qbsk measured 0 hits against 922 misses on layers with no connection to
   * any of it.
   *
   * ⚠️ **Per LAYER, not per composition**, and the difference is the whole soundness
   * argument. Scoped to the composition, a list created at the top level is exempt while
   * a layer evaluated after it is cached holding a reference — so an edit later in that
   * same top-level run bumps nothing and the layer is reused stale. `mutation-epoch.test.ts`
   * caught exactly that, on the first attempt at this.
   *
   * MISSING an entry here is safe: an unrecorded container is treated as old, the epoch
   * bumps, and the cache is merely more conservative. So only the interpreter's own list
   * and dict literals are recorded — natives returning fresh lists (`split`, `map`,
   * `slice`) are not, and adding them later can only improve the hit rate, never
   * correctness.
   */
  private bornThisLayer: WeakSet<object> | null = null;

  /**
   * Records an in-place edit, unless the thing edited was born this composition.
   *
   * Every mutation goes through here rather than touching `mutationEpoch` directly, so
   * the exemption cannot be applied at three sites and forgotten at the fourth.
   */
  private noteMutation(target: object): void {
    // `null` means "not inside a layer", where nothing is exempt. A tick handler editing
    // a top-level list must always bump: the handler runs between compositions, so every
    // cached layer predates it and any of them may hold that list.
    if (this.bornThisLayer === null || !this.bornThisLayer.has(target)) {
      this.mutationEpoch += 1;
    }
  }
  private currentDir: string;
  private readonly scriptArgs: string[];
  private readonly onEvent: ((decl: EventDecl) => void) | undefined;
  // The game clock, for frame-swapping (docs/engine.md §11.4). Held rather than
  // read through natives so a sprite frame cannot accidentally end up following
  // the render clock instead.
  private readonly gameRuntime: { gameTime: number } | undefined;
  // L5: module path -> cached module value (init runs once); `loading` detects cycles.
  private readonly modules = new Map<string, QValue>();
  private readonly loading = new Set<string>();
  private currentModule: QValue | null = null;
  // Tones composed by the current pass (docs/audio.md §5). Cleared per composition
  // so the plan is a pure function of (scene, game time), never an accumulation.
  public audioPlan: TonePlanEntry[] = [];
  // Shades composed by the current pass (docs/engine.md §11.6). Cleared with the
  // audio plan, for the same reason: a pure function of this composition.
  public shadePlan: ShadeSpec[] = [];

  /**
   * Set only while a layer body is being evaluated (docs/engine.md §11.11).
   *
   * A primitive produced inside a loop, an `if`, or a function called from the body
   * is handed here instead of being discarded, which is what lets a layer draw a
   * variable number of things. Null everywhere else, so nothing outside a layer
   * changes behaviour.
   */
  private layerSink: ((v: QValue) => void) | null = null;
  private readonly staticLayerKeys: ReadonlyMap<LayerDecl, number>;
  private readonly staticLayerValues = new Map<number, QValue>();
  private readonly layerReads: ReadonlyMap<LayerDecl, readonly string[]>;
  /**
   * The last composition of each eligible dynamic layer, with what it was reading then.
   *
   * Validity is two questions, because QBSK answers "did it change?" two ways. A name
   * can be REBOUND, which the recorded values catch; a list or dict can be edited IN
   * PLACE without any name moving, which only the mutation epoch catches. Either alone
   * leaves a hole: `names = push(names, x)` rebinds, `map["k"] = v` does not.
   */
  private readonly layerCache = new Map<LayerDecl, {
    epoch: number;
    reads: Map<string, QValue>;
    value: QValue;
  }>();
  private layerReuseHits = 0;
  private layerReuseMisses = 0;
  public lastExprValue: QValue | null = null;
  public lastScene: QValue | null = null;

  constructor(io: HostIO, opts: InterpOptions = {}) {
    this.baseDir_owned = opts.baseDir ?? ".";
    this.cellAspect = opts.cellAspect ?? DEFAULT_CELL_ASPECT;
    assertCellAspect(this.cellAspect);
    this.scriptArgs = opts.scriptArgs ?? [];
    this.onEvent = opts.onEvent;
    this.gameRuntime = opts.runtime;
    this.staticLayerKeys = opts.staticLayerKeys ?? new Map();
    this.layerReads = opts.layerReads ?? new Map();
    this.nativeEnv = createNatives(io, {
      scriptArgs: this.scriptArgs,
      runtime: opts.runtime,
      call: (fn, args, span) => this.callValue(fn, args, null, span),
      saveStore: opts.saveStore,
      // The validated one, not `opts.cellAspect`: a native must measure angles in the
      // same cell the compositor draws them in.
      cellAspect: this.cellAspect,
    });
    // §15.5 — the entry program gets its OWN scope, a child of the natives.
    //
    // It used to define straight into `nativeEnv`, and a module's scope chains to that
    // same env — so a module could read the entry program's variables, contradicting §9
    // ("top-level var/const/func never leak into the importer"). The leak was in the
    // entry program, not in the module loader, which was already correct.
    //
    // The visible half of the same bug: `var len = 5` collided with the native instead
    // of shadowing it. A program's own top level is a scope; shadowing is what scopes
    // are for. `liveEnv` (the Studio MCP snippet path) still wins when supplied.
    this.env = opts.liveEnv ?? new Env(this.nativeEnv);
    this.currentDir = this.baseDir_owned;
  }

  evalProgram(program: Program): void {
    this.lastExprValue = null;
    for (const stmt of program.body) {
      const v = this.visitStmt(stmt);
      if (v !== null && v.type === "layer") {
        if (this.lastScene === null || this.lastScene.type !== "scene") {
          this.runtime(
            `layer '${v.name}' must be declared after a scene`,
            stmt.span,
          );
        }
        this.lastScene.layers.push(v);
      }
    }
  }

  // The live top-level environment. Between frames (and between tool calls) the
  // interpreter has restored this as `this.env`, so reads here see exactly what the
  // running program sees. Used by the Studio MCP server (docs/studio.md §11).
  get liveEnv(): Env {
    return this.env;
  }

  get baseDir(): string {
    return this.baseDir_owned;
  }

  private runtime(message: string, span: Span): never {
    const err = new QbskRuntimeError(message, span);
    // Captured at THROW time: by the time an error reaches a handler the stack has
    // unwound and `functionDepth` has been restored by the `finally` in `callValue`.
    err.trace = this.captureTrace();
    throw err;
  }

  /**
   * The " — did you mean 'x'?" tail, or nothing (§8.1).
   *
   * §8 has promised a suggestion on a runtime error since the error model was written,
   * and it was only kept in `qbsk check`: the better message lived on the opt-in path
   * while `qbsk run` — how the language is actually met — gave the bare one. Of 80
   * runtime error sites, exactly one offered a hint.
   *
   * ONE place, so a new error inherits it. `closest` returns null past distance 2, and a
   * bare message is the correct answer then: a hint that is not actually similar sends
   * the author to fix working code.
   */
  private hint(name: string, candidates: Iterable<string>): string {
    const best = closest(name, candidates);
    return best !== null ? ` — did you mean '${best}'?` : "";
  }

  /**
   * The names that ACTUALLY exist where execution stopped.
   *
   * The runtime's advantage over a static pass, and why this is not a copy of the
   * analyzer's candidate list: `Env.names()` walks the live scope chain, so the set is
   * what is in scope at that point rather than everything the program declares
   * somewhere. Suggesting a variable from another function would be a lie with a
   * helpful tone.
   */
  private namesInScope(): string[] {
    return this.env.names();
  }

  /**
   * §15.2, invariant I2 — a primitive draws into a layer or it says so.
   *
   * `layerSink === null` IS "outside a layer": the sink is installed while a layer body
   * is being collected and removed after. Written at the top level or straight into a
   * `scene` body, a primitive used to evaluate correctly and then be dropped by the
   * caller — the program printed nothing, drew nothing, and exited 0.
   *
   * One guard for every drawing statement, checked before the statement does any work,
   * so a primitive added later inherits it. State directives are included: a `z:` with
   * nothing to apply to is the same silence in a smaller shape.
   */
  private requireLayer(what: string, span: Span): void {
    if (this.layerSink === null) {
      this.runtime(
        `'${what}' draws into a layer — put it inside a 'layer' block`,
        span,
      );
    }
  }

  // an earlier release: evaluates a SceneDecl into a scene value (width/height params are
  // validated) without mutating `lastScene` or defining the name — recomposeScene
  // calls it per frame to rebuild the scene from the live environment.
  private evalSceneValue(stmt: SceneDecl): QValue {
    const params = new Map<string, QValue>();
    for (const p of stmt.params) {
      params.set(p.name, this.visitExpr(p.value));
    }
    const width = params.get("width");
    const height = params.get("height");
    if (
      width === undefined ||
      height === undefined ||
      width.type !== "int" ||
      height.type !== "int"
    ) {
      this.runtime("the scene needs width and height as int", stmt.span);
    }
    // §14.3 — `title` and `fps` are READ, so their types are checked. While nothing
    // consumed them a wrong type was invisible, which is the whole shape of the bug:
    // a parameter nobody reads cannot be wrong, and cannot be right either.
    const title = params.get("title");
    if (title !== undefined && title.type !== "str") {
      this.runtime(
        `the scene title must be a str, not ${title.type}`,
        this.paramSpan(stmt, "title"),
      );
    }
    const fps = params.get("fps");
    if (fps !== undefined && (fps.type !== "int" || fps.value < 1)) {
      this.runtime(
        fps.type === "int"
          ? `the scene fps must be at least 1, not ${fps.value}`
          : `the scene fps must be an int, not ${fps.type}`,
        this.paramSpan(stmt, "fps"),
      );
    }
    const layers: QValue[] = [];
    if (stmt.body) {
      for (const s of stmt.body.statements) {
        const v = this.visitStmt(s);
        if (v !== null && v.type === "layer") {
          layers.push(v);
        }
      }
    }
    return { type: "scene", name: stmt.name, params, layers };
  }

  /**
   * The span of one scene parameter, falling back to the whole declaration.
   *
   * §8 requires an error to point at the mistake, and `scene G(width: 40, height: 12,
   * fps: "fast")` is a long line: underlining all of it tells the author where the
   * program is, not where the problem is.
   */
  private paramSpan(stmt: SceneDecl, name: string): Span {
    return stmt.params.find((p) => p.name === name)?.value.span ?? stmt.span;
  }

  /**
   * §15, invariant I1 — every named argument belongs to a closed set.
   *
   * ONE place, on purpose. §14 wrote a whitelist for `scene` and left `sprite`, `tone`,
   * `shade` and `color` open, so four constructs went on accepting keys nobody read: the
   * author wrote a property, the language nodded, and nothing happened. That was not
   * four bugs, it was one bug with four addresses.
   *
   * Every construct that takes `key: value` routes through here, so a primitive added
   * later inherits the rule instead of waiting for the next review to notice it does not.
   */
  private checkNamedArgs(
    construct: string,
    args: readonly NamedArg[],
    allowed: readonly string[],
  ): void {
    const seen = new Set<string>();
    for (const arg of args) {
      if (!allowed.includes(arg.name)) {
        const near = closest(arg.name, allowed);
        this.runtime(
          `'${arg.name}:' is not a property of '${construct}'` +
            (near !== null
              ? ` — did you mean '${near}:'?`
              : ` (${allowed.join(", ")})`),
          arg.span,
        );
      }
      if (seen.has(arg.name)) {
        // Last-one-wins would decide what gets drawn by declaration order, in silence.
        this.runtime(
          `'${arg.name}:' is repeated on this '${construct}'`,
          arg.span,
        );
      }
      seen.add(arg.name);
    }
  }

  /**
   * Flattens a canvas into cells for a bulk blit (§11.13).
   *
   * Every cell is taken, spaces among them: a canvas is an image with an extent the
   * author chose, so its blanks are part of what it says. That is the opposite of a
   * mask, and deliberately so — a mask marks absence, a canvas has none to mark.
   */
  private canvasCellsAt(canvas: Canvas, ox: number, oy: number): MaskedCells {
    const cells: MaskedCells["cells"] = [];
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const cell = canvas.cells[y * canvas.width + x]!;
        // -1 is "no opinion" by the cell model's own definition, and 0 attrs is the
        // same. Passing those through as values would make the layer's `color`
        // directive a silent no-op above a blit — a value computed and dropped, which
        // is exactly what invariant I2 forbids. Omitting them lets the layer's style
        // apply, while a cell that really carries a colour keeps it.
        cells.push({
          x: ox + x,
          y: oy + y,
          ch: cell.char,
          fg: cell.fg === -1 ? undefined : cell.fg,
          bg: cell.bg === -1 ? undefined : cell.bg,
          attrs: cell.attrs === 0 ? undefined : cell.attrs,
        });
      }
    }
    return { kind: "maskedCells", cells };
  }

  /**
   * Resolves `put MAP at (x, y) mask: SEEN` into the cells it draws (§11.12).
   *
   * Done here rather than at mount because this is where the spans are, and an author
   * whose mask does not fit their map must be told which is which (I3), not handed a
   * host error or — worse — a silently wrong picture.
   */
  private resolveMaskedCells(
    map: QValue,
    mask: QValue,
    ox: number,
    oy: number,
    stmt: PutStmt,
  ): MaskedCells {
    const rows = this.rowsOf(map, "a masked put's map", stmt.text.span);
    const maskRows = this.rowsOf(mask, "the mask", stmt.mask!.span);
    if (maskRows.length < rows.length) {
      this.runtime(
        `the mask has ${maskRows.length} row${maskRows.length === 1 ? "" : "s"} ` +
          `but the map has ${rows.length} — the mask must cover the map`,
        stmt.mask!.span,
      );
    }
    const cells: { x: number; y: number; ch: string }[] = [];
    for (let row = 0; row < rows.length; row += 1) {
      const line = rows[row]!;
      const maskLine = maskRows[row]!;
      if (maskLine.length < line.length) {
        this.runtime(
          `mask row ${row} is ${maskLine.length} character${maskLine.length === 1 ? "" : "s"} ` +
            `but the map row is ${line.length} — the mask must cover the map`,
          stmt.mask!.span,
        );
      }
      for (let col = 0; col < line.length; col += 1) {
        // The whole rule: a space hides, anything else shows.
        if (maskLine[col] === " ") {
          continue;
        }
        cells.push({ x: ox + col, y: oy + row, ch: line[col]! });
      }
    }
    return { kind: "maskedCells", cells };
  }

  /** Shared shape check for the map and the mask; the same one `sight` applies. */
  private rowsOf(value: QValue, what: string, span: Span): string[] {
    if (value.type !== "list") {
      this.runtime(
        `${what} must be a list of strings, got '${typeName(value)}'`,
        span,
      );
    }
    const rows: string[] = [];
    for (const row of (value as { type: "list"; items: QValue[] }).items) {
      if (row.type !== "str") {
        this.runtime(
          `${what} must be a list of strings, found '${typeName(row)}' in it`,
          span,
        );
      }
      rows.push((row as { type: "str"; value: string }).value);
    }
    return rows;
  }

  // an earlier release: evaluates a LayerDecl into a layer value, applying inherited state
  // (M15 directives: z/visible/color propagate to following primitives).
  private evalLayerValue(stmt: LayerDecl): QValue {
    const staticKey = this.staticLayerKeys.get(stmt);
    if (staticKey !== undefined) {
      const cached = this.staticLayerValues.get(staticKey);
      if (cached !== undefined) {
        // Reuse is not just the value. A layer that registered a tone or a shade when it
        // was built has to register it again now, or the frame that reuses it is a frame
        // where the torch stopped burning and the tone stopped sounding (§11.20).
        this.replayLayerEffects(cached);
        return cached;
      }
    }
    // §11.19 — the invalidation cache. Only layers the analyzer reported as dynamic AND
    // read-tracked are in `layerReads` at all, so ineligibility is expressed by absence
    // rather than by a test here.
    const readNames = this.layerReads.get(stmt);
    if (readNames !== undefined) {
      const entry = this.layerCache.get(stmt);
      if (entry !== undefined && entry.epoch === this.mutationEpoch && this.readsMatch(entry.reads)) {
        this.layerReuseHits += 1;
        this.replayLayerEffects(entry.value);
        return entry.value;
      }
      this.layerReuseMisses += 1;
      const value = this.evalLayerFresh(stmt);
      this.layerCache.set(stmt, {
        epoch: this.mutationEpoch,
        reads: this.snapshotReads(readNames),
        value,
      });
      return value;
    }
    return this.evalLayerFresh(stmt);
  }

  /** What each tracked name resolves to right now. Unresolvable names are simply absent. */
  private snapshotReads(names: readonly string[]): Map<string, QValue> {
    const snapshot = new Map<string, QValue>();
    for (const name of names) {
      const value = this.env.get(name);
      if (value !== undefined) {
        snapshot.set(name, value);
      }
    }
    return snapshot;
  }

  /**
   * Whether every recorded read still resolves to the same thing.
   *
   * Scalars compare BY VALUE and everything else by identity. Value comparison is not an
   * optimisation of identity here, it is the difference between a cache that fires and
   * one that does not: `beat = beat_at(...)` rebinds a fresh box every frame and holds
   * the same integer for seconds at a time, which is the exact shape a dialogue scene
   * has. Identity alone would miss on every frame of it.
   *
   * Identity is right for the rest. A list or dict compared by contents would cost the
   * O(size) walk the cache exists to avoid, and in-place edits are the mutation epoch's
   * job, not this one's.
   */
  private readsMatch(recorded: ReadonlyMap<string, QValue>): boolean {
    for (const [name, was] of recorded) {
      const now = this.env.get(name);
      if (now === undefined) {
        return false;
      }
      if (now === was) {
        continue;
      }
      if (now.type !== was.type) {
        return false;
      }
      if (now.type === "int" || now.type === "float") {
        if (now.value !== (was as { value: number }).value) return false;
        continue;
      }
      if (now.type === "str") {
        if (now.value !== (was as { value: string }).value) return false;
        continue;
      }
      if (now.type === "bool") {
        if (now.value !== (was as { value: boolean }).value) return false;
        continue;
      }
      if (now.type === "null") {
        continue;
      }
      return false;
    }
    return true;
  }

  /** Composes a layer from scratch. The two caches above decide whether to call it. */
  private evalLayerFresh(stmt: LayerDecl): QValue {
    // Anything born before this point is old as far as this layer is concerned. Saved
    // rather than dropped, so a nested evaluation (evalSnippet) hands its caller's view
    // back instead of leaving `null` behind.
    const outerBorn = this.bornThisLayer;
    this.bornThisLayer = new WeakSet<object>();
    try {
      return this.composeLayer(stmt);
    } finally {
      this.bornThisLayer = outerBorn;
    }
  }

  private composeLayer(stmt: LayerDecl): QValue {
    const cacheKey = this.staticLayerKeys.get(stmt);
    const z = this.visitExpr(stmt.z);
    if (z.type !== "int") {
      this.runtime("the z of a layer must be int", stmt.z.span);
    }
    let at: QValue | null = null;
    if (stmt.at !== null) {
      at = this.visitExpr(stmt.at);
      if (
        at.type !== "tuple" ||
        at.x.type !== "int" ||
        at.y.type !== "int"
      ) {
        this.runtime(
          "the layer offset must be a tuple (x, y) with ints",
          stmt.span,
        );
      }
    }
    const primitives: QValue[] = [];
    // Collected rather than pushed onto the interpreter, so the layer OWNS what it
    // registered and can hand it over again the next time it is reused.
    const effects: LayerEffects = { shades: [], tones: [] };
    let fg: string | null = null;
    let bg: string | null = null;
    let zState: QValue | null = null;
    let visibleState: QValue | null = null;
    // A layer's drawing is COLLECTED rather than returned, so a primitive may come
    // from a loop, an `if`, or a function called from the body — not only from a
    // statement written directly in the layer (docs/engine.md §11.11). Nested
    // primitives arrive through `layerSink` in execution order, so the state
    // directives above them apply exactly as they do to a primitive written in place.
    let idx = 0;
    let nested = 0;
    const consume = (v: QValue, id: string): void => {
      if (v.type === "primitive") {
        if (v.kind === "color") {
          fg = typeof v.props.fg === "string" ? v.props.fg : fg;
          bg = typeof v.props.bg === "string" ? v.props.bg : bg;
          return;
        }
        if (v.kind === "z") {
          zState = v.props.value as QValue;
          return;
        }
        if (v.kind === "visible") {
          visibleState = v.props.value as QValue;
          return;
        }
        if (zState !== null) {
          v.props.z = zState;
        }
        if (visibleState !== null) {
          v.props.visible = visibleState;
        }
        if (fg !== null || bg !== null) {
          v.props.dslStyle = { fg, bg };
        }
      }
      if (v.type === "sprite") {
        if (zState !== null) {
          v.z = zState;
        }
        if (visibleState !== null) {
          v.visible = visibleState;
        }
        if (fg !== null || bg !== null) {
          v.style = { fg, bg };
        }
      }
      // A tone writes no cells; it contributes to the frame's audio plan instead
      // (docs/audio.md §4). Identity is layer name + declaration position, which is
      // what lets the device tell "the same tone, re-composed" from "a new tone".
      if (v.type === "primitive" && v.kind === "shade") {
        const vis = v.props.visible;
        const off =
          vis !== undefined && vis !== null && typeof vis === "object" &&
          "type" in vis && vis.type === "bool" && vis.value === false;
        if (!off) {
          effects.shades.push(v.props.spec as unknown as ShadeSpec);
        }
        return;
      }
      if (v.type === "primitive" && v.kind === "tone") {
        const vis = v.props.visible;
        const hidden =
          vis !== undefined &&
          vis !== null &&
          typeof vis === "object" &&
          "type" in vis &&
          vis.type === "bool" &&
          vis.value === false;
        if (!hidden) {
          effects.tones.push({
            id,
            freq: (v.props.freq as { value: number }).value,
            wave: (v.props.wave as unknown as WaveName),
            duration: (v.props.duration as { value: number }).value,
            volume: (v.props.volume as { value: number }).value,
            loop: (v.props.loop as { value: boolean }).value,
          });
        }
        return;
      }
      if (
        v.type === "primitive" ||
        v.type === "event" ||
        v.type === "sprite"
      ) {
        primitives.push(v);
      }
    };

    const prevSink = this.layerSink;
    // A tone born inside a loop still needs a stable identity, so it is numbered
    // within its statement rather than sharing the statement's own id.
    this.layerSink = (v) => {
      nested += 1;
      consume(v, `${stmt.name}#${idx}:${nested}`);
    };
    // The body gets its OWN scope, like any other block. A layer is re-evaluated on
    // every frame, so a `var` declared here without a scope of its own would land in
    // the enclosing environment and the SECOND composition would die with "already
    // defined". Lookups and assignments still walk up, so a layer keeps seeing and
    // mutating top-level state; only its declarations are local.
    const parentEnv = this.env;
    this.env = new Env(parentEnv);
    try {
      for (idx = 0; idx < stmt.body.statements.length; idx += 1) {
        nested = 0;
        const v = this.visitStmt(stmt.body.statements[idx]!);
        if (v !== null) {
          consume(v, `${stmt.name}#${idx}`);
        }
      }
    } finally {
      this.env = parentEnv;
      this.layerSink = prevSink;
    }
    const layer: QValue = { type: "layer", name: stmt.name, z, at, primitives, cacheKey, effects };
    if (cacheKey !== undefined) {
      this.staticLayerValues.set(cacheKey, layer);
    }
    // Registered through the same path a cache hit takes, so "built" and "reused" cannot
    // drift apart: there is one way for a layer's effects to reach the frame.
    this.replayLayerEffects(layer);
    return layer;
  }

  /**
   * Contributes a layer's recorded effects to the frame being composed.
   *
   * Called on both paths — once when the layer is built, once for every frame that
   * reuses it. Visibility was already resolved when the effects were recorded, so a
   * `tone` marked `visible: false` is absent from the list rather than filtered here;
   * replay never re-decides what registration decided.
   */
  private replayLayerEffects(layer: QValue): void {
    if (layer.type !== "layer") {
      return;
    }
    for (const spec of layer.effects.shades) {
      this.shadePlan.push(spec);
    }
    for (const tone of layer.effects.tones) {
      this.audioPlan.push(tone);
    }
  }

  invalidateStaticLayers(): void {
    this.staticLayerValues.clear();
    // The snippet that invalidated the static layers can have redefined anything, so a
    // recorded read set is no longer evidence about a world it may not describe.
    this.layerCache.clear();
  }

  /** Focused headless evidence for F4; not exposed to the QBSK language. */
  invalidationStats(): { eligible: number; hits: number; misses: number } {
    return {
      eligible: this.layerReads.size,
      hits: this.layerReuseHits,
      misses: this.layerReuseMisses,
    };
  }

  // an earlier release: runs an event handler body with its parameters bound in a fresh child
  // scope of the live top-level env, so assignments (`x += 1`) walk up and mutate
  // the persistent variable while locals stay scoped to the dispatch.
  dispatchEvent(decl: EventDecl, args: QValue[]): void {
    const callEnv = new Env(this.env);
    decl.params.forEach((p, i) => {
      callEnv.define(p.name, args[i] ?? { type: "null" }, "var");
    });
    const parentEnv = this.env;
    this.env = callEnv;
    try {
      this.execBody(decl.body);
    } finally {
      this.env = parentEnv;
    }
  }

  /**
   * Evaluates a handler's `when` guard (docs/language.md §6.6) in the live top-level
   * environment. Unguarded handlers are always eligible. Called for EVERY handler of
   * a delivery BEFORE any of them runs, so a handler's state change can never
   * re-route the event it is answering.
   */
  guardHolds(decl: EventDecl): boolean {
    if (decl.guard === null) {
      return true;
    }
    return truthy(this.visitExpr(decl.guard));
  }

  // an earlier release: rebuilds the scene from the live environment without re-running the
  // top level. Only the SceneDecl and top-level LayerDecls re-evaluate (spec
  // language.md §7.7: per frame the handlers run and the scene re-composes).
  recomposeScene(program: Program): QValue | null {
    let scene: QValue | null = null;
    for (const stmt of program.body) {
      if (stmt.kind === "SceneDecl") {
        scene = this.evalSceneValue(stmt);
      } else if (stmt.kind === "LayerDecl") {
        if (scene === null || scene.type !== "scene") {
          this.runtime(
            `layer '${stmt.name}' must be declared after a scene`,
            stmt.span,
          );
        }
        scene.layers.push(this.evalLayerValue(stmt));
      }
    }
    return scene;
  }

  // L4: converts a QbskRuntimeError into the dict the catch exposes as `e`.
  private tryErrorValue(err: QbskRuntimeError): QValue {
    return {
      type: "dict",
      map: new Map<string, QValue>([
        ["message", { type: "str", value: err.message }],
        ["file", { type: "str", value: err.span.file }],
        ["line", { type: "int", value: err.span.start.line }],
        ["col", { type: "int", value: err.span.start.col }],
      ]),
    };
  }

  private define(
    name: string,
    value: QValue,
    kind: "var" | "const",
    span: Span,
  ): void {
    try {
      this.env.define(name, value, kind);
    } catch (err) {
      throw new QbskRuntimeError((err as Error).message, span);
    }
  }

  private defineModuleBinding(stmt: UseStmt, mod: QValue): void {
    if (mod.type !== "module") {
      throw new Error("internal: module value expected");
    }
    const alias = stmt.alias ?? mod.name;
    // §15.15: the twenty-six scene words are contextual, so they are legal names here.
    // This tested all fifty-one, which meant the parser accepted `use "x.qbsk" as line`
    // and then this refused to bind it — the same rule enforced in two places, widened in
    // only one of them.
    const reserved =
      (KEYWORDS as Record<string, string>)[alias] !== undefined &&
      !NAMEABLE_DSL_WORDS.has(alias);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) || reserved) {
      this.runtime(
        `cannot bind module '${stmt.path}' as '${alias}': the module name must be a plain identifier (use 'use "..." as name')`,
        stmt.span,
      );
    }
    const local = this.env.local(alias);
    if (local !== undefined) {
      if (local === mod) {
        return; // idempotent: same module already bound in this scope
      }
      this.runtime(`name '${alias}' is already bound in this scope`, stmt.span);
    }
    this.define(alias, mod, "const", stmt.span);
  }

  /**
   * Run a statement, compiling it the first time it is reached.
   *
   * Control flow and binding are specialised by `buildStmt`; everything else — the whole
   * scene DSL and the module machinery — compiles to a single call into
   * `execDeclarative`, which still holds those arms and holds them only once. The split
   * is by frequency, not by taste: a `while` body dispatches on every iteration, while a
   * `sprite` statement dispatches once per layer and then does far more work than the
   * dispatch cost.
   */
  private visitStmt(stmt: Stmt): QValue | null {
    const done = (stmt as CompilableStmt).compiledStmt;
    return (done ?? Interpreter.compileStmt(stmt))(this);
  }

  /** Compile once and remember it on the node. */
  private static compileStmt(stmt: Stmt): StmtThunk {
    const thunk = Interpreter.buildStmt(stmt);
    (stmt as CompilableStmt).compiledStmt = thunk;
    return thunk;
  }

  /** Run a block, compiling it the first time it is reached. */
  private execBody(body: Block): void {
    const done = (body as CompilableBlock).compiledBlock;
    (done ?? Interpreter.compileBlock(body))(this);
  }

  private static compileBlock(body: Block): BlockThunk {
    const thunk = Interpreter.buildBlock(body);
    (body as CompilableBlock).compiledBlock = thunk;
    return thunk;
  }

  /**
   * Compile a block: its statements, and whether it needs a scope at all.
   *
   * Two decisions that used to be made on every execution are made here once.
   *
   * The scope decision is rung 3's, and it was costing a `WeakMap` probe per pass
   * through a loop body to re-derive an answer that is a property of the syntax. A block
   * that declares nothing has no use for a scope and paid for one twice: the `Map`
   * allocated and discarded, and a link every `lookup` from inside it had to walk.
   *
   * `DECLARING_STATEMENTS` is the list to keep true: a declaring kind missing from it
   * lands its name in the enclosing scope, and the second execution reports "already
   * defined in this scope". Loud, which is the good case.
   */
  private static buildBlock(body: Block): BlockThunk {
    const stmts = body.statements.map((s) => Interpreter.compileStmt(s));
    const count = stmts.length;
    const needsScope = body.statements.some((s) => DECLARING_STATEMENTS.has(s.kind));
    if (!needsScope) {
      return (ip) => {
        for (let i = 0; i < count; i += 1) {
          Interpreter.drain(ip, stmts[i]!(ip));
        }
      };
    }
    return (ip) => {
      const parent = ip.env;
      ip.env = new Env(parent);
      try {
        for (let i = 0; i < count; i += 1) {
          Interpreter.drain(ip, stmts[i]!(ip));
        }
      } finally {
        ip.env = parent;
      }
    };
  }

  /**
   * Inside a layer, a primitive produced in a nested block is drawn rather than dropped
   * (docs/engine.md §11.11). Outside one the sink is null and this is exactly the old
   * behaviour: a `put` in a plain function still evaluates to a value nobody keeps.
   */
  private static drain(ip: Interpreter, v: QValue | null): void {
    if (
      v !== null &&
      ip.layerSink !== null &&
      (v.type === "primitive" || v.type === "sprite")
    ) {
      ip.layerSink(v);
    }
  }

  /**
   * Build the closure for one statement.
   *
   * Same contract as `buildExpr`: everything that can be decided from the syntax is
   * decided here, and everything that reads interpreter state goes inside the returned
   * closure. `default` is not a hole — it is the whole declarative half of the language,
   * routed to the one switch that still holds it.
   */
  private static buildStmt(stmt: Stmt): StmtThunk {
    switch (stmt.kind) {
      case "ExprStmt": {
        const expr = Interpreter.compileExpr(stmt.expr);
        return (ip: Interpreter) => {
          ip.lastExprValue = expr(ip);
          return null;
        };
      }
      case "VarDecl": {
        const name = stmt.name;
        const span = stmt.span;
        const init = stmt.init === null ? null : Interpreter.compileExpr(stmt.init);
        return (ip: Interpreter) => {
          const value: QValue = init === null ? { type: "null" } : init(ip);
          ip.define(name, value, "var", span);
          return null;
        };
      }
      case "ConstDecl": {
        const name = stmt.name;
        const span = stmt.span;
        const exported = stmt.exported;
        const init = stmt.init === null ? null : Interpreter.compileExpr(stmt.init);
        return (ip: Interpreter) => {
          const value: QValue = init === null ? { type: "null" } : init(ip);
          ip.define(name, value, "const", span);
          const mod = ip.currentModule;
          if (exported && mod !== null && mod.type === "module") {
            mod.exports.set(name, value);
          }
          return null;
        };
      }
      case "FuncDecl": {
        const name = stmt.name;
        const span = stmt.span;
        const params = stmt.params;
        const body = stmt.body;
        const exported = stmt.exported;
        return (ip: Interpreter) => {
          // `closure` is read here, not hoisted: a func declared inside a function
          // captures the environment of the call that declared it.
          const fn: QValue = { type: "func", name, params, body, closure: ip.env };
          ip.define(name, fn, "var", span);
          const mod = ip.currentModule;
          if (exported && mod !== null && mod.type === "module") {
            mod.exports.set(name, fn);
          }
          return null;
        };
      }
      case "Assign":
        return Interpreter.buildAssign(stmt);
      case "IfStmt": {
        const branches = stmt.branches.map((branch) => ({
          cond: Interpreter.compileExpr(branch.cond),
          body: Interpreter.compileBlock(branch.body),
        }));
        const count = branches.length;
        const elseBody =
          stmt.elseBody === null ? null : Interpreter.compileBlock(stmt.elseBody);
        return (ip: Interpreter) => {
          for (let i = 0; i < count; i += 1) {
            const branch = branches[i]!;
            if (truthy(branch.cond(ip))) {
              branch.body(ip);
              return null;
            }
          }
          if (elseBody !== null) {
            elseBody(ip);
          }
          return null;
        };
      }
      case "MatchStmt": {
        const subject = Interpreter.compileExpr(stmt.subject);
        const arms = stmt.arms.map((arm) => ({
          pattern: Interpreter.compileExpr(arm.pattern),
          body: Interpreter.compileBlock(arm.body),
        }));
        const count = arms.length;
        const elseBody =
          stmt.elseBody === null ? null : Interpreter.compileBlock(stmt.elseBody);
        return (ip: Interpreter) => {
          const value = subject(ip);
          for (let i = 0; i < count; i += 1) {
            const arm = arms[i]!;
            if (qbskEq(value, arm.pattern(ip))) {
              arm.body(ip);
              return null;
            }
          }
          if (elseBody !== null) {
            elseBody(ip);
          }
          return null;
        };
      }
      case "TryStmt": {
        const tryBody = Interpreter.compileBlock(stmt.tryBody);
        const catchBody = Interpreter.compileBlock(stmt.catchBody);
        const catchParam = stmt.catchParam;
        return (ip: Interpreter) => {
          try {
            tryBody(ip);
          } catch (err) {
            if (!(err instanceof QbskRuntimeError)) {
              throw err;
            }
            const parent = ip.env;
            ip.env = new Env(parent);
            ip.env.define(catchParam, ip.tryErrorValue(err), "var");
            try {
              catchBody(ip);
            } finally {
              ip.env = parent;
            }
          }
          return null;
        };
      }
      case "ForRange": {
        const span = stmt.span;
        const name = stmt.name;
        const from = Interpreter.compileExpr(stmt.from);
        const to = Interpreter.compileExpr(stmt.to);
        const body = Interpreter.compileBlock(stmt.body);
        return (ip: Interpreter) => {
          const lo = from(ip);
          const hi = to(ip);
          if (!isNumber(lo)) {
            ip.runtime(
              `'for' start bound must be int or float, got '${typeName(lo)}'`,
              span,
            );
          }
          if (!isNumber(hi)) {
            ip.runtime(
              `'for' end bound must be int or float, got '${typeName(hi)}'`,
              span,
            );
          }
          const start = Math.ceil(lo.value);
          const end = Math.floor(hi.value);
          const label = stmt.label;
          ip.loopDepth += 1;
          // Pushed only when there IS a name: an unlabelled loop pays one null check on
          // entry and nothing else, and the stack is read only by a labelled break.
          if (label !== null) {
            ip.loopLabels.push(label);
          }
          try {
            for (let i = start; i < end; i += 1) {
              const parent = ip.env;
              ip.env = new Env(parent);
              try {
                ip.env.define(name, { type: "int", value: i }, "var");
                try {
                  body(ip);
                } catch (err) {
                  // §15.22 — a signal with no label belongs to the innermost
                  // loop, which is this one. A labelled signal belongs to this loop only
                  // if the name matches; otherwise it keeps going outward, and some
                  // enclosing loop claims it.
                  if (err instanceof BreakSignal) {
                    if (err.label === null || err.label === label) {
                      break;
                    }
                    throw err;
                  }
                  if (err instanceof ContinueSignal) {
                    if (err.label === null || err.label === label) {
                      continue;
                    }
                    throw err;
                  }
                  throw err;
                }
              } finally {
                ip.env = parent;
              }
            }
          } finally {
            if (label !== null) {
              ip.loopLabels.pop();
            }
            ip.loopDepth -= 1;
          }
          return null;
        };
      }
      case "ForList": {
        const span = stmt.span;
        const name = stmt.name;
        const indexName = stmt.indexName;
        const iterable = Interpreter.compileExpr(stmt.iterable);
        const body = Interpreter.compileBlock(stmt.body);
        return (ip: Interpreter) => {
          const list = iterable(ip);
          if (list.type !== "list") {
            ip.runtime(`'for in' expects a list, got '${typeName(list)}'`, span);
          }
          const label = stmt.label;
          ip.loopDepth += 1;
          // Pushed only when there IS a name: an unlabelled loop pays one null check on
          // entry and nothing else, and the stack is read only by a labelled break.
          if (label !== null) {
            ip.loopLabels.push(label);
          }
          try {
            for (let i = 0; i < list.items.length; i += 1) {
              const item = list.items[i]!;
              const parent = ip.env;
              ip.env = new Env(parent);
              try {
                // §6.2: the index binds first when `for i, item in list` was written.
                if (indexName !== null) {
                  ip.env.define(indexName, { type: "int", value: i }, "var");
                }
                ip.env.define(name, item, "var");
                try {
                  body(ip);
                } catch (err) {
                  // §15.22 — a signal with no label belongs to the innermost
                  // loop, which is this one. A labelled signal belongs to this loop only
                  // if the name matches; otherwise it keeps going outward, and some
                  // enclosing loop claims it.
                  if (err instanceof BreakSignal) {
                    if (err.label === null || err.label === label) {
                      break;
                    }
                    throw err;
                  }
                  if (err instanceof ContinueSignal) {
                    if (err.label === null || err.label === label) {
                      continue;
                    }
                    throw err;
                  }
                  throw err;
                }
              } finally {
                ip.env = parent;
              }
            }
          } finally {
            if (label !== null) {
              ip.loopLabels.pop();
            }
            ip.loopDepth -= 1;
          }
          return null;
        };
      }
      case "WhileStmt": {
        const cond = Interpreter.compileExpr(stmt.cond);
        const body = Interpreter.compileBlock(stmt.body);
        return (ip: Interpreter) => {
          const label = stmt.label;
          ip.loopDepth += 1;
          // Pushed only when there IS a name: an unlabelled loop pays one null check on
          // entry and nothing else, and the stack is read only by a labelled break.
          if (label !== null) {
            ip.loopLabels.push(label);
          }
          try {
            // NO scope is created here, and that is not an omission.
            //
            // `buildBlock` already gives every block that declares something one — so
            // this loop was building a SECOND `Env` per iteration that nothing was ever
            // defined into. A 100,000-iteration loop allocated and discarded 100,000
            // Maps to hold nothing.
            //
            // The body's own `var` is still fresh on every pass and still invisible
            // after the loop, because the scope it lands in is the one the block makes.
            // `ForRange` and `ForList` keep theirs: they define the loop variable BEFORE
            // running the body, so they need a scope that already exists by then.
            while (truthy(cond(ip))) {
              try {
                body(ip);
              } catch (err) {
                // §15.22 — as in the for loops: unlabelled is mine, labelled is
                // mine only by name, anything else travels outward.
                if (err instanceof BreakSignal) {
                  if (err.label === null || err.label === label) {
                    break;
                  }
                  throw err;
                }
                if (err instanceof ContinueSignal) {
                  if (err.label === null || err.label === label) {
                    continue;
                  }
                  throw err;
                }
                throw err;
              }
            }
          } finally {
            if (label !== null) {
              ip.loopLabels.pop();
            }
            ip.loopDepth -= 1;
          }
          return null;
        };
      }
      case "BreakStmt": {
        const span = stmt.span;
        const label = stmt.label;
        return (ip: Interpreter) => {
          if (ip.loopDepth === 0) {
            ip.runtime("'break' outside a loop", span);
          }
          // §15.22 — checked HERE, where the span points at the name the author
          // wrote. Letting the signal travel and reporting wherever it stopped would put
          // the caret on the outermost loop instead, which is not where the typo is.
          if (label !== null && !ip.loopLabels.includes(label)) {
            ip.runtime(`no enclosing loop is named '${label}'`, span);
          }
          throw new BreakSignal(label, span);
        };
      }
      case "ContinueStmt": {
        const span = stmt.span;
        const label = stmt.label;
        return (ip: Interpreter) => {
          if (ip.loopDepth === 0) {
            ip.runtime("'continue' outside a loop", span);
          }
          if (label !== null && !ip.loopLabels.includes(label)) {
            ip.runtime(`no enclosing loop is named '${label}'`, span);
          }
          throw new ContinueSignal(label, span);
        };
      }
      case "ReturnStmt": {
        const span = stmt.span;
        const value = stmt.value === null ? null : Interpreter.compileExpr(stmt.value);
        return (ip: Interpreter) => {
          if (ip.functionDepth === 0) {
            ip.runtime("'return' outside a function", span);
          }
          throw new ReturnSignal(value === null ? { type: "null" } : value(ip));
        };
      }
      default:
        // The declarative half: the scene DSL, `use`, and the scene/layer/event
        // declarations. Not specialised because they run at composition frequency and
        // each does far more work than reaching it costs — and because leaving them in
        // one switch keeps them written down once.
        return (ip: Interpreter) => ip.execDeclarative(stmt);
    }
  }

  /**
   * The assignment forms, chosen once.
   *
   * Which of the three targets this is, and whether the operator compounds, are
   * properties of the syntax. The switch asked both on every execution, including on
   * every pass of a loop that only ever assigns to the same local.
   */
  private static buildAssign(stmt: Assign): StmtThunk {
    const span = stmt.span;
    const op = stmt.op;
    const value = Interpreter.compileExpr(stmt.value);
    // `null` means a plain `=`, which is one branch rather than two string compares.
    const combine: ((a: QValue, b: QValue) => QValue) | null =
      op === "="
        ? null
        : op === "+="
          ? (a, b) => qbskAdd(a, b, span)
          : (a, b) => qbskSub(a, b, span);
    const target = stmt.target;
    if (target.kind === "Ident") {
      const name = target.name;
      const nameSpan = target.span;
      return (ip: Interpreter) => {
        const v = value(ip);
        // ONE walk of the scope chain, not two. `get` then `assign` resolved the same
        // name twice on every assignment, and the second walk could only ever find what
        // the first one found — which for `i = i + 1` in a loop is the same binding, a
        // hundred thousand times.
        const binding = ip.env.binding(name);
        if (binding === undefined) {
          ip.runtime(
            `variable '${name}' is not defined` + ip.hint(name, ip.namesInScope()),
            nameSpan,
          );
        }
        const next = combine === null ? v : combine(binding.value, v);
        try {
          Env.write(binding, name, next);
        } catch (err) {
          // §15.4, invariant I3 — `Env` reports a const reassignment as a host Error
          // with no span. It becomes a QBSK error here, where the span is known.
          throw new QbskRuntimeError((err as Error).message, span);
        }
        return null;
      };
    }
    if (target.kind === "Member") {
      const object = Interpreter.compileExpr(target.object);
      return (ip: Interpreter) => {
        value(ip);
        const owner = object(ip);
        if (owner.type === "module") {
          ip.runtime(
            "modules are immutable: you cannot assign to a module member",
            span,
          );
        }
        if (owner.type === "tuple") {
          ip.runtime("tuples are immutable: they have no members", span);
        }
        return ip.runtime(`type '${typeName(owner)}' has no members`, span);
      };
    }
    if (target.kind === "Index") {
      const object = Interpreter.compileExpr(target.object);
      const index = Interpreter.compileExpr(target.index);
      return (ip: Interpreter) => {
        const v = value(ip);
        const owner = object(ip);
        const key = index(ip);
        if (owner.type === "list") {
          if (key.type !== "int") {
            ip.runtime(indexTypeError("list", key), span);
          }
          const i = key.value;
          if (i < 0 || i >= owner.items.length) {
            ip.runtime(
              `index ${i} out of range for a list of ${owner.items.length} elements`,
              span,
            );
          }
          owner.items[i] = combine === null ? v : combine(owner.items[i]!, v);
          ip.noteMutation(owner);
          return null;
        }
        if (owner.type === "dict") {
          if (key.type !== "str") {
            ip.runtime(`a dict key must be a string, got '${typeName(key)}'`, span);
          }
          if (combine === null) {
            owner.map.set(key.value, v);
            ip.noteMutation(owner);
            return null;
          }
          const current = owner.map.get(key.value);
          if (current === undefined) {
            ip.runtime(`key '${key.value}' does not exist in the dict`, span);
          }
          ip.noteMutation(owner);
          owner.map.set(key.value, combine(current, v));
          return null;
        }
        return ip.runtime(
          `cannot index-assign into type '${typeName(owner)}' — only 'list' and 'dict' support it`,
          span,
        );
      };
    }
    return (ip: Interpreter) => {
      value(ip);
      return ip.runtime("cannot assign to this expression", span);
    };
  }

  /**
   * The statement kinds `buildStmt` does not specialise.
   *
   * `default` here cannot be reached: `buildStmt` handles every kind this switch does
   * not, and routes every other kind here. It reports rather than returning `null`
   * because a statement kind that quietly did nothing is anti-pattern 1 exactly.
   */
  private execDeclarative(stmt: Stmt): QValue | null {
    switch (stmt.kind) {
      case "UseStmt": {
        const target = resolve(this.currentDir, stmt.path);
        let mod = this.modules.get(target);
        if (mod === undefined) {
          if (this.loading.has(target)) {
            return this.runtime(
              `module cycle detected while loading '${stmt.path}'`,
              stmt.span,
            );
          }
          let source: string;
          try {
            source = readFileSync(target, "utf8");
          } catch {
            return this.runtime(
              `cannot load module '${stmt.path}': file not found`,
              stmt.span,
            );
          }
          const stem = basename(target, extname(target));
          // The EXTENSION picks the loader (docs/language.md §12). `use "x.qbsk"` loads
          // code and runs its top level, as it always has; `use "x.qbdata"` loads
          // literals and runs nothing. One keyword, and the file name tells a reader
          // which contract applies without opening the file.
          if (extname(target) === ".qbdata") {
            const data = loadQbdata(source, target);
            if (data.errors.length > 0) {
              const first = data.errors[0]!;
              return this.runtime(
                `in '${stmt.path}' line ${first.span.start.line}: ${first.message}`,
                stmt.span,
              );
            }
            mod = { type: "module", name: stem, exports: new Map(data.entries) };
            this.modules.set(target, mod);
            this.defineModuleBinding(stmt, mod);
            return null;
          }
          const parsed = parse(source, target);
          if (parsed.errors.length > 0) {
            return this.runtime(
              `syntax error in module '${stmt.path}'`,
              stmt.span,
            );
          }
          mod = { type: "module", name: stem, exports: new Map() };
          this.loading.add(target);
          const savedEnv = this.env;
          const savedDir = this.currentDir;
          const savedModule = this.currentModule;
          this.env = new Env(this.nativeEnv);
          this.currentDir = dirname(target);
          this.currentModule = mod;
          try {
            for (const s of parsed.ast.body) {
              this.visitStmt(s);
            }
          } finally {
            this.env = savedEnv;
            this.currentDir = savedDir;
            this.currentModule = savedModule;
            this.loading.delete(target);
          }
          this.modules.set(target, mod);
        }
        this.defineModuleBinding(stmt, mod);
        return null;
      }
      case "SceneDecl": {
        this.lastScene = this.evalSceneValue(stmt);
        this.define(stmt.name, this.lastScene, "const", stmt.span);
        return this.lastScene;
      }
      case "LayerDecl":
        return this.evalLayerValue(stmt);
      case "EventDecl":
        // §14.4 — a handler that can never register says so. A dropped handler is
        // invisible: pressing the key afterwards is indistinguishable from not
        // pressing it, so silence here is the worst possible answer.
        //
        // Only the MODULE case is an error. The frame loop belongs to the entry
        // program (§7.7), so an `on` inside a `use`d file can never register no
        // matter how the program is run — that is a real design decision, and it is
        // now stated instead of applied behind the author's back.
        //
        // A one-shot `qbsk run` is NOT an error even though nothing registers
        // either. §7.7 documents that a plain run composes one frame with no ticks
        // and no keys, so the same file legitimately declares handlers for loop mode
        // and still composes correctly here. Erroring would refuse a correct program
        // for how it happens to be invoked.
        if (this.currentModule !== null) {
          this.runtime(
            "an 'on' handler in a module never registers — the frame loop belongs to the entry program",
            stmt.span,
          );
        }
        this.onEvent?.(stmt);
        return {
          type: "event",
          event: stmt.event,
          keyName: stmt.keyName,
          params: stmt.params,
        };
      case "FillStmt":
        this.requireLayer("fill", stmt.span);
        return {
          type: "primitive",
          kind: "fill",
          props: { ch: this.visitExpr(stmt.ch) },
        };
      case "PutStmt":
      case "TextStmt": {
        this.requireLayer(stmt.kind === "PutStmt" ? "put" : "text", stmt.span);
        const atValue = this.visitExpr(stmt.at);
        if (
          atValue.type !== "tuple" ||
          atValue.x.type !== "int" ||
          atValue.y.type !== "int"
        ) {
          this.runtime(
            "the position must be a tuple (x, y) with ints",
            stmt.span,
          );
        }
        let depthValue: QValue | null = null;
        if (stmt.kind === "PutStmt" && stmt.depth !== null) {
          const d = this.visitExpr(stmt.depth);
          if (d.type !== "int" && d.type !== "float") {
            this.runtime(
              `'depth' must be a number, got '${typeName(d)}'`,
              stmt.depth.span,
            );
          }
          depthValue = d;
        }
        const textValue = this.visitExpr(stmt.text);
        if (stmt.kind === "PutStmt" && stmt.mask !== null) {
          const cells = this.resolveMaskedCells(
            textValue,
            this.visitExpr(stmt.mask),
            atValue.x.value,
            atValue.y.value,
            stmt,
          );
          return {
            type: "primitive",
            kind: "maskedPut",
            props: {
              world: stmt.world ? { type: "bool", value: true } : null,
              depth: depthValue,
            },
            masked: cells,
          };
        }
        // §11.13 — a canvas used to be stringified too, and `renderText()` is
        // multi-line, so the newlines ended rows early and the scene came out with
        // rows of the wrong width and a line past its own height. It blits now,
        // carrying its own per-cell colours.
        if (stmt.kind === "PutStmt" && textValue.type === "canvas") {
          return {
            type: "primitive",
            kind: "maskedPut",
            props: {
              world: stmt.world ? { type: "bool", value: true } : null,
              depth: depthValue,
            },
            masked: this.canvasCellsAt(textValue.canvas, atValue.x.value, atValue.y.value),
          };
        }
        // §11.12 — a list here used to be stringified and clipped, drawing garbage
        // with no error. It reports now, and names the construct that gives it meaning.
        if (stmt.kind === "PutStmt" && (textValue.type === "list" || textValue.type === "dict")) {
          this.runtime(
            "put draws one line of text; to draw a list of rows through a mask, " +
              "use 'mask:' — put MAP at (0, 0) mask: seen",
            stmt.text.span,
          );
        }
        return {
          type: "primitive",
          kind: stmt.kind === "PutStmt" ? "put" : "text",
          props: {
            text: textValue,
            at: atValue,
            world: stmt.world ? { type: "bool", value: true } : null,
            depth: depthValue,
          },
        };
      }
      case "BoxStmt":
        this.requireLayer("box", stmt.span);
        return {
          type: "primitive",
          kind: "box",
          props: {
            from: this.visitExpr(stmt.from),
            to: this.visitExpr(stmt.to),
            style: stmt.style,
          },
        };
      case "BorderStmt":
        this.requireLayer("border", stmt.span);
        return {
          type: "primitive",
          kind: "border",
          props: {
            from: this.visitExpr(stmt.from),
            to: this.visitExpr(stmt.to),
            style: stmt.style,
          },
        };
      case "LineStmt":
        this.requireLayer("line", stmt.span);
        return {
          type: "primitive",
          kind: "line",
          props: {
            from: this.visitExpr(stmt.from),
            to: this.visitExpr(stmt.to),
            style: stmt.style,
          },
        };
      case "SpriteStmt": {
        this.requireLayer("sprite", stmt.span);
        const pathValue = this.visitExpr(stmt.path);
        if (pathValue.type !== "str") {
          // §15.8 — the span is the path expression, not the whole statement. §8
          // promises the error points at the mistake; underlining a long `sprite ...`
          // line points at the program instead.
          this.runtime("the sprite path must be a string", stmt.path.span);
        }
        const atValue = this.visitExpr(stmt.at);
        if (
          atValue.type !== "tuple" ||
          atValue.x.type !== "int" ||
          atValue.y.type !== "int"
        ) {
          this.runtime(
            "the sprite position must be a tuple (x, y) with ints",
            stmt.at.span,
          );
        }
        let anchor: string | [number, number] | null = null;
        let scale: [number, number] | null = null;
        // Frame-swapping (docs/engine.md §11.4). `frames` is optional: without it a
        // multi-frame .qba still shows frame 0, exactly as before.
        let frameCount: number | null = null;
        let frameFps = 0;
        let frameLoop = false;
        this.checkNamedArgs("sprite", stmt.props, SPRITE_PROPS);
        for (const p of stmt.props) {
          // §15.3 — the value is an EXPRESSION. Only `anchor:` takes a bare word, and
          // only because anchor names are a closed vocabulary rather than a value; every
          // other property used to read `frames: count` as the literal string "count",
          // so a variable was unusable and the error blamed a type the author never
          // wrote. The same bug was found and fixed for `shade` alone; this is the rule.
          const v =
            p.name === "anchor" && p.value.kind === "Ident"
              ? { type: "str" as const, value: p.value.name }
              : this.visitExpr(p.value);
          if (p.name === "anchor") {
            anchor = this.resolveAnchor(v, p.value.span);
          } else if (p.name === "scale") {
            scale = this.resolveScale(v, p.value.span);
          } else if (p.name === "frames") {
            if (v.type !== "int") {
              this.runtime(
                `'frames' must be an int, got '${typeName(v)}'`,
                p.value.span,
              );
            }
            frameCount = (v as { type: "int"; value: number }).value;
          } else if (p.name === "fps") {
            if (v.type !== "int" && v.type !== "float") {
              this.runtime(
                `'fps' must be a number, got '${typeName(v)}'`,
                p.value.span,
              );
            }
            frameFps = (v as { value: number }).value;
          } else if (p.name === "loop") {
            if (v.type !== "bool") {
              this.runtime(
                `'loop' must be a bool, got '${typeName(v)}'`,
                p.value.span,
              );
            }
            frameLoop = (v as { type: "bool"; value: boolean }).value;
          }
        }
        const target = resolve(this.baseDir, pathValue.value);
        let source: string;
        try {
          source = readFileSync(target, "utf8");
        } catch {
          this.runtime(
            `cannot load sprite '${pathValue.value}': file not found`,
            stmt.span,
          );
        }
        let qba: QbaSprite;
        try {
          qba = loadQba(source, pathValue.value);
        } catch (err) {
          if (err instanceof QbaError) {
            this.runtime(
              `cannot load sprite '${pathValue.value}': ${err.message}`,
              stmt.span,
            );
          }
          throw err;
        }
        // The frame follows the GAME clock — never the render clock, never
        // Date.now(). A scene at 60 fps and the same scene at 20 fps must show the
        // same sprite frame at the same game time (qbsk-engine anti-pattern list).
        let frameIndex = 0;
        if (frameCount !== null) {
          if (frameCount > qba.frames.length) {
            this.runtime(
              `sprite '${pathValue.value}' declares frames: ${frameCount} but the file has ${qba.frames.length}`,
              stmt.span,
            );
          }
          frameIndex = pickFrame(
            frameCount,
            frameFps,
            frameLoop,
            this.gameRuntime?.gameTime ?? 0,
          ).index;
        }
        let art = qba.frames[frameIndex] ?? qba.frames[0] ?? [];
        if (scale !== null) {
          art = scaleArt(art, scale[0], scale[1]);
        }
        const width = art.reduce((max, row) => Math.max(max, row.length), 0);
        const [ox, oy] = anchorOffset(width, art.length, anchor);
        return {
          type: "sprite",
          name: qba.name,
          at: {
            type: "tuple",
            x: { type: "int", value: atValue.x.value - ox },
            y: { type: "int", value: atValue.y.value - oy },
          },
          world: stmt.world ? { type: "bool", value: true } : undefined,
          art: art.join("\n"),
        };
      }
      case "ShadeStmt": {
        this.requireLayer("shade", stmt.span);
        const nameValue =
          stmt.name.kind === "Ident"
            ? { type: "str" as const, value: stmt.name.name }
            : this.visitExpr(stmt.name);
        if (nameValue.type !== "str" || !isShadeName(nameValue.value)) {
          const got = nameValue.type === "str" ? nameValue.value : typeName(nameValue);
          this.runtime(
            `unknown shade '${got}'` +
              this.hint(got, SHADE_NAMES) +
              `; expected one of ${SHADE_NAMES.join(", ")}`,
            stmt.name.span,
          );
        }
        const kind = (nameValue as { value: string }).value as ShadeName;
        this.checkNamedArgs("shade", stmt.args, SHADE_PROPS);
        // Defaults chosen so a bare `shade "grade"` does something visible but not
        // destructive: a gentle darken rather than a full wash.
        const spec: ShadeSpec = {
          kind,
          x: 0,
          y: 0,
          radius: 10,
          tint: -1,
          strength: 0.3,
          speed: 1,
        };
        for (const p of stmt.args) {
          // `tint` is resolved BEFORE the generic evaluation, because colour names
          // are hyphenated ('bright-yellow') and the expression grammar reads that
          // as a subtraction. evalDslExpr rebuilds the name the way `color fg:`
          // already does; evaluating it as an ordinary expression first would throw
          // "variable 'bright' is not defined" before this branch could run.
          if (p.name === "tint") {
            const named = this.evalDslExpr(p.value);
            const packed = named.type === "str" ? resolveColor(named.value) : null;
            if (packed === null) {
              this.runtime(
                `unknown colour '${named.type === "str" ? named.value : typeName(named)}' for 'tint'`,
                p.value.span,
              );
            }
            spec.tint = packed as number;
            continue;
          }
          // Evaluate, never name-as-string: every remaining shade argument is
          // numeric, so a bare identifier is a VARIABLE REFERENCE. Treating it as a
          // literal name (which is right for `tint: red`) turned `x: torchX` into
          // the string "torchX".
          const raw = this.visitExpr(p.value);
          if (raw.type !== "int" && raw.type !== "float") {
            this.runtime(
              `'${p.name}' must be a number, got '${typeName(raw)}'`,
              p.value.span,
            );
          }
          const n = (raw as { value: number }).value;
          if (p.name === "x") spec.x = n;
          else if (p.name === "y") spec.y = n;
          else if (p.name === "radius") spec.radius = n;
          else if (p.name === "strength") spec.strength = n;
          else if (p.name === "speed") spec.speed = n;
        }
        return { type: "primitive", kind: "shade", props: { spec: spec as unknown as QValue } };
      }
      case "ToneStmt": {
        this.requireLayer("tone", stmt.span);
        // freq and duration are physical quantities, not grid addresses: int and
        // float are both valid write forms and are converted explicitly to float,
        // the same category as gameTime() and animate() (docs/audio.md §4).
        const freqValue = this.visitExpr(stmt.freq);
        if (freqValue.type !== "int" && freqValue.type !== "float") {
          this.runtime(
            `tone frequency must be a number, got '${typeName(freqValue)}'`,
            stmt.freq.span,
          );
        }
        const freq = (freqValue as { value: number }).value;
        if (!(freq > 0)) {
          this.runtime(`tone frequency must be > 0, got ${freq}`, stmt.freq.span);
        }
        let wave: WaveName = "square";
        let duration = 0.1;
        let volume = 0.5;
        let loop = false;
        this.checkNamedArgs("tone", stmt.args, TONE_PROPS);
        for (const p of stmt.args) {
          // Only `wave` names a waveform; the rest are numbers or a bool, so a bare
          // identifier there is a variable reference and must be evaluated.
          const raw =
            p.name === "wave" && p.value.kind === "Ident"
              ? { type: "str" as const, value: p.value.name }
              : this.visitExpr(p.value);
          if (p.name === "wave") {
            if (raw.type !== "str" || !isWaveName(raw.value)) {
              const got = raw.type === "str" ? raw.value : typeName(raw);
              this.runtime(
                `unknown wave '${got}'` +
                  this.hint(got, WAVE_NAMES) +
                  `; expected one of ${WAVE_NAMES.join(", ")}`,
                p.value.span,
              );
            }
            wave = (raw as { value: string }).value as WaveName;
          } else if (p.name === "duration" || p.name === "volume") {
            if (raw.type !== "int" && raw.type !== "float") {
              this.runtime(
                `'${p.name}' must be a number, got '${typeName(raw)}'`,
                p.value.span,
              );
            }
            const n = (raw as { value: number }).value;
            if (p.name === "duration") {
              if (!(n > 0)) {
                this.runtime(`'duration' must be > 0, got ${n}`, p.value.span);
              }
              duration = n;
            } else {
              volume = n;
            }
          } else if (p.name === "loop") {
            if (raw.type !== "bool") {
              this.runtime(
                `'loop' must be a bool, got '${typeName(raw)}'`,
                p.value.span,
              );
            }
            loop = (raw as { value: boolean }).value;
          }
        }
        return {
          type: "primitive",
          kind: "tone",
          props: {
            freq: { type: "float", value: freq },
            wave: wave as unknown as QValue,
            duration: { type: "float", value: duration },
            volume: { type: "float", value: volume },
            loop: { type: "bool", value: loop },
          },
        };
      }
      case "CanvasDecl":
        return {
          type: "sprite",
          name: stmt.name,
          at: this.visitExpr(stmt.at),
          art: stmt.literal,
        };
      case "ColorStmt": {
        this.requireLayer("color", stmt.span);
        const props: Record<string, QValue | string | DslStyle | null> = {};
        this.checkNamedArgs("color", stmt.props, COLOR_PROPS);
        for (const p of stmt.props) {
          const v = this.evalDslExpr(p.value);
          const name = v.type === "str" ? v.value : "";
          if (resolveColor(name) === null) {
            // An author who wrote `#ff7f0` mistyped a NUMBER, and "did you mean 'red'?"
            // sends him looking for a name. Which of the two mistakes it is is knowable
            // from the leading `#`, so it is said (§15.16).
            this.runtime(
              looksHex(name)
                ? `color ${p.name}: '${name}' is not a colour — a truecolor literal is ` +
                  `#rrggbb, six hexadecimal digits`
                : `color ${p.name}: unknown color '${name}'` +
                  this.hint(name, Object.keys(NAMED_COLORS)),
              p.value.span,
            );
          }
          props[p.name] = name;
        }
        return { type: "primitive", kind: "color", props };
      }
      case "ZStmt": {
        this.requireLayer("z:", stmt.span);
        const v = this.visitExpr(stmt.value);
        if (v.type !== "int") {
          this.runtime("a primitive's z must be int", stmt.span);
        }
        return { type: "primitive", kind: "z", props: { value: v } };
      }
      case "VisibleStmt": {
        this.requireLayer("visible:", stmt.span);
        const v = this.visitExpr(stmt.value);
        if (v.type !== "bool") {
          this.runtime("visible must be true or false", stmt.span);
        }
        return { type: "primitive", kind: "visible", props: { value: v } };
      }
      case "ErrorStmt":
        return this.runtime(stmt.message, stmt.span);
      default:
        // Unreachable: `buildStmt` specialises every kind this switch does not hold,
        // and routes every other kind here. Reported rather than returned as `null`,
        // because a statement kind that quietly did nothing is anti-pattern 1 exactly.
        return this.runtime(
          `internal: statement '${stmt.kind}' was neither compiled nor declarative`,
          stmt.span,
        );
    }
  }

  // The DSL declares names (center, cyan, random...) that are not variables:
  // if evaluation fails on an undefined name, the raw name is kept
  // (including hyphenated names: bright-yellow → "bright-yellow").
  /**
   * Evaluate a DSL value, where a bare word may be a NAME rather than a variable.
   *
   * Colour names are hyphenated (`bright-yellow`) and the expression grammar reads that
   * as a subtraction, so the DSL slots that accept a vocabulary (`color fg:`, `tint:`,
   * `anchor:`) have to accept the un-evaluated spelling too.
   *
   * The name shapes are recognised BEFORE evaluating, not by catching the failure of
   * evaluating. That ordering is a performance property, not a style preference: the
   * old version threw and caught a `QbskRuntimeError` every time a colour was used, and
   * a real game (`examples/main_menu.qbsk`) built **121,471** of them in one run — 22
   * seconds of building error objects and, once §8.1 added suggestions, computing
   * Levenshtein distances for words that were never mistakes. Exceptions are for
   * failures; asking "is this a name?" is a question.
   *
   * A shadowing variable still wins: `var red = 1` then `color fg: red` uses the
   * variable, because the lookup is tried first for a plain identifier.
   */
  private evalDslExpr(expr: Expr): QValue {
    // `a-b` — a hyphenated name. Never a subtraction in this position: two bare
    // identifiers minus each other is not something a DSL value slot accepts.
    if (
      expr.kind === "BinOp" &&
      expr.op === "-" &&
      expr.left.kind === "Ident" &&
      expr.right.kind === "Ident"
    ) {
      return { type: "str", value: `${expr.left.name}-${expr.right.name}` };
    }
    // A single bare word: a variable if one is in scope, otherwise the name itself.
    if (expr.kind === "Ident") {
      const bound = this.env.get(expr.name);
      return bound ?? { type: "str", value: expr.name };
    }
    return this.visitExpr(expr);
  }

  /**
   * Evaluate an expression, compiling it the first time it is reached.
   *
   * The switch this replaced ran on EVERY evaluation: one string dispatch on the node
   * kind, a second on the operator, and a field read per operand against a union of
   * fourteen differently-shaped objects — which is a megamorphic load the JIT cannot
   * specialise. Compiling turns all of that into work done once, and leaves a tree of
   * closures that each read exactly the operands they closed over.
   */
  private visitExpr(expr: Expr): QValue {
    const done = (expr as Compilable).compiled;
    return (done ?? Interpreter.compileExpr(expr))(this);
  }

  /** Compile once and remember it on the node, so the next evaluation goes straight in. */
  private static compileExpr(expr: Expr): Thunk {
    const thunk = Interpreter.buildExpr(expr);
    (expr as Compilable).compiled = thunk;
    return thunk;
  }

  /** The one QValue a literal ever needs (see `Thunk` for why sharing it is sound). */
  private static literalValue(
    litKind: "int" | "float" | "str" | "bool" | "null",
    value: number | string | boolean | null,
  ): QValue {
    if (litKind === "int") {
      return { type: "int", value: value as number };
    }
    if (litKind === "float") {
      return { type: "float", value: value as number };
    }
    if (litKind === "str") {
      return { type: "str", value: value as string };
    }
    if (litKind === "bool") {
      return { type: "bool", value: value as boolean };
    }
    return { type: "null" };
  }

  /**
   * Build the closure for one node, having already built its operands'.
   *
   * Everything decided here — which operator function, which literal object, whether a
   * call carries named arguments — is decided ONCE. What may not be decided here is
   * anything that reads interpreter state: that goes inside the returned closure, which
   * receives the interpreter it is running under.
   *
   * Order of evaluation is the switch's, deliberately, including in the arms that only
   * ever end in an error. An expression that reported operand-first must keep reporting
   * operand-first, or a program that used to name the author's mistake starts naming
   * this one instead.
   */
  private static buildExpr(expr: Expr): Thunk {
    switch (expr.kind) {
      case "Lit": {
        const value = Interpreter.literalValue(expr.litKind, expr.value);
        return () => value;
      }
      case "Ident": {
        const name = expr.name;
        const span = expr.span;
        // Annotated rather than inferred: TypeScript only narrows on a `never`-returning
        // call when the callee's receiver is explicitly typed, and `ip.runtime` below is
        // what proves `value` is defined past the guard.
        return (ip: Interpreter) => {
          const value = ip.env.get(name);
          if (value === undefined) {
            ip.runtime(
              `variable '${name}' is not defined` + ip.hint(name, ip.namesInScope()),
              span,
            );
          }
          return value;
        };
      }
      case "BinOp": {
        const span = expr.span;
        if (expr.op === "and") {
          const left = Interpreter.compileExpr(expr.left);
          const right = Interpreter.compileExpr(expr.right);
          return (ip) => {
            const a = left(ip);
            return truthy(a) ? right(ip) : a;
          };
        }
        if (expr.op === "or") {
          const left = Interpreter.compileExpr(expr.left);
          const right = Interpreter.compileExpr(expr.right);
          return (ip) => {
            const a = left(ip);
            return truthy(a) ? a : right(ip);
          };
        }
        if (expr.op === "..") {
          // Raised when the expression RUNS, not while it compiles. Compilation walks
          // whole subtrees, including arms of an `if` this program never takes, and a
          // compile that threw would fail a program on an expression it never reaches.
          return (ip) =>
            ip.runtime("the '..' range is only valid as a 'for' iterable", span);
        }
        const left = Interpreter.compileExpr(expr.left);
        const right = Interpreter.compileExpr(expr.right);
        const op = expr.op;
        if (op === "+") {
          return (ip) => qbskAdd(left(ip), right(ip), span);
        }
        if (op === "-") {
          return (ip) => qbskSub(left(ip), right(ip), span);
        }
        if (op === "*") {
          return (ip) => qbskMul(left(ip), right(ip), span);
        }
        if (op === "/") {
          return (ip) => qbskDiv(left(ip), right(ip), span);
        }
        if (op === "%") {
          return (ip) => qbskMod(left(ip), right(ip), span);
        }
        if (op === "==") {
          return (ip) => ({ type: "bool", value: qbskEq(left(ip), right(ip)) });
        }
        if (op === "!=") {
          return (ip) => ({ type: "bool", value: !qbskEq(left(ip), right(ip)) });
        }
        if (op === "<" || op === ">" || op === "<=" || op === ">=") {
          return (ip) => ({
            type: "bool",
            value: qbskCmp(op, left(ip), right(ip), span),
          });
        }
        if (op === "&" || op === "|" || op === "^" || op === "<<" || op === ">>") {
          return (ip) => qbskBitwise(op, left(ip), right(ip), span);
        }
        // Unreachable through the parser, which only builds the operators above. It
        // still evaluates both operands before reporting, because the switch did.
        return (ip) => {
          left(ip);
          right(ip);
          return ip.runtime(`unknown operator '${op}'`, span);
        };
      }
      case "Unary": {
        const span = expr.span;
        const operand = Interpreter.compileExpr(expr.operand);
        if (expr.op === "-") {
          return (ip) => qbskNeg(operand(ip), span);
        }
        return (ip) => ({ type: "bool", value: !truthy(operand(ip)) });
      }
      case "Call": {
        const span = expr.span;
        const calleeExpr = expr.callee;
        const callee = Interpreter.compileExpr(expr.callee);
        const args = expr.args.map((a) => Interpreter.compileExpr(a));
        const arity = args.length;
        if (expr.namedArgs.length > 0) {
          // After the operands, as the switch had it: an argument that fails on its own
          // terms keeps reporting on its own terms rather than being masked by this.
          return (ip) => {
            callee(ip);
            for (const arg of args) {
              arg(ip);
            }
            return ip.runtime(
              "named arguments are not supported on function calls — only the scene DSL accepts them",
              span,
            );
          };
        }
        return (ip) => {
          const fn = callee(ip);
          const values: QValue[] = new Array(arity);
          for (let i = 0; i < arity; i += 1) {
            values[i] = args[i]!(ip);
          }
          return ip.callValue(fn, values, calleeExpr, span);
        };
      }
      case "Member": {
        const span = expr.span;
        const name = expr.name;
        const object = Interpreter.compileExpr(expr.object);
        return (ip) => {
          const target = object(ip);
          if (target.type === "module") {
            const member = target.exports.get(name);
            if (member === undefined) {
              return ip.runtime(
                `module '${target.name}' has no exported member '${name}'` +
                  // Candidates are THAT module's exports: a name from anywhere else is
                  // not reachable through this member access, so proposing it would be
                  // a hint the author cannot act on.
                  ip.hint(name, target.exports.keys()),
                span,
              );
            }
            return member;
          }
          if (target.type === "tuple") {
            ip.runtime("tuples are immutable: they have no members", span);
          }
          return ip.runtime(`type '${typeName(target)}' has no members`, span);
        };
      }
      case "InterpolatedStr": {
        // Literal chunks stay strings and holes become thunks, sorted out once instead
        // of by a `typeof` on every part on every evaluation.
        const parts = expr.parts.map((part) =>
          typeof part === "string" ? part : Interpreter.compileExpr(part),
        );
        return (ip) => {
          let out = "";
          for (const part of parts) {
            out += typeof part === "string" ? part : qbskStr(part(ip));
          }
          return { type: "str", value: out };
        };
      }
      case "ListLit": {
        const items = expr.items.map((e) => Interpreter.compileExpr(e));
        const count = items.length;
        return (ip) => {
          const values: QValue[] = new Array(count);
          for (let i = 0; i < count; i += 1) {
            values[i] = items[i]!(ip);
          }
          const list: QValue = { type: "list", items: values };
          ip.bornThisLayer?.add(list);
          return list;
        };
      }
      case "DictLit": {
        const entries = expr.entries.map(
          (entry) => [entry.key, Interpreter.compileExpr(entry.value)] as const,
        );
        return (ip) => {
          const map = new Map<string, QValue>();
          for (const [key, value] of entries) {
            map.set(key, value(ip));
          }
          const dict: QValue = { type: "dict", map };
          ip.bornThisLayer?.add(dict);
          return dict;
        };
      }
      case "Index": {
        const span = expr.span;
        const object = Interpreter.compileExpr(expr.object);
        const index = Interpreter.compileExpr(expr.index);
        return (ip) => ip.indexValue(object(ip), index(ip), span);
      }
      case "Tuple": {
        const x = Interpreter.compileExpr(expr.x);
        const y = Interpreter.compileExpr(expr.y);
        return (ip) => ({ type: "tuple", x: x(ip), y: y(ip) });
      }
      case "Lambda": {
        // Desugars to an ordinary func value (docs/language.md §6.3): the body is a
        // synthesized `return expr` block, so closures, arity checks and call errors
        // are the named function's — one calling convention, no second code path.
        //
        // The block is the same immutable node on every evaluation, so it is built
        // here. `closure` is the one thing that may NOT be: a lambda captures the
        // environment it is evaluated in, which is why it reads `ip.env` below.
        const params = expr.params;
        const body: Block = {
          kind: "Block",
          statements: [
            { kind: "ReturnStmt", value: expr.body, span: expr.body.span },
          ],
          span: expr.body.span,
        };
        return (ip) => ({
          type: "func",
          name: "<lambda>",
          params,
          body,
          closure: ip.env,
        });
      }
      case "ErrorExpr": {
        const message = expr.message;
        const span = expr.span;
        return (ip) => ip.runtime(message, span);
      }
    }
  }

  private indexValue(object: QValue, index: QValue, span: Span): QValue {
    if (object.type === "list") {
      if (index.type !== "int") {
        return this.runtime(
          indexTypeError("list", index),
          span,
        );
      }
      const i = index.value;
      if (i < 0 || i >= object.items.length) {
        return this.runtime(
          `index ${i} out of range for a list of ${object.items.length} elements`,
          span,
        );
      }
      return object.items[i]!;
    }
    if (object.type === "dict") {
      if (index.type !== "str") {
        return this.runtime(
          `a dict key must be a string, got '${typeName(index)}'`,
          span,
        );
      }
      const value = object.map.get(index.value);
      if (value === undefined) {
        return this.runtime(
          `key '${index.value}' does not exist in the dict`,
          span,
        );
      }
      return value;
    }
    if (object.type === "str") {
      // `len()` already worked on a string, so not being able to index one was an
      // asymmetry rather than a decision. Found by a map of rows: `MAP[y][x]` is how
      // anyone would write it, and it is how the pathfinding example reads its walls.
      if (index.type !== "int") {
        return this.runtime(
          indexTypeError("string", index),
          span,
        );
      }
      // Characters, not code units — `len()` counts the same way, and the two
      // disagreeing about what position 1 is would be worse than either answer alone.
      const chars = [...object.value];
      if (index.value < 0 || index.value >= chars.length) {
        return this.runtime(
          `index ${index.value} out of range for a string of ${chars.length} characters`,
          span,
        );
      }
      return { type: "str", value: chars[index.value]! };
    }
    if (object.type === "tuple") {
      // A tuple is a two-element sequence, so it reads by index like one
      // (docs/language.md §5). Found by pathfinding: `path` answers with coordinates
      // and there was no way to read one's x. Returning lists instead would have
      // worked; indexing is strictly better, because `route[1]` still passes whole
      // into an `at` slot AND `step[0]` reads the component.
      if (index.type !== "int") {
        return this.runtime(
          indexTypeError("tuple", index),
          span,
        );
      }
      if (index.value === 0) {
        return object.x;
      }
      if (index.value === 1) {
        return object.y;
      }
      return this.runtime(
        `index ${index.value} out of range for a tuple — it has 2 elements, [0] and [1]`,
        span,
      );
    }
    return this.runtime(
      `type '${typeName(object)}' is not indexable with '[]'`,
      span,
    );
  }

  /**
   * The route to an error: one name and one call span per depth (§15.20).
   *
   * Written into SLOTS indexed by `functionDepth`, which the interpreter already keeps, so
   * a call costs two array writes and no allocation once a program is warm. A pushed and
   * popped array would allocate on every call in the hottest path in the language.
   */
  /**
   * The names of the loops running right now, innermost last (§15.22).
   *
   * Not reset per call, deliberately. A `break outer` inside a function DOES find the
   * caller's `outer` here, and that is what makes the function-boundary error above
   * possible: the alternative reports "no enclosing loop is named 'outer'", which is
   * false — one exists, and the real problem is that a call cannot reach it.
   */
  loopLabels: (string | null)[] = [];

  private readonly frameNames: string[] = [];
  private readonly frameSpans: (Span | null)[] = [];

  /** The frames as the error will carry them, innermost first. */
  private captureTrace(): QbskFrame[] {
    const out: QbskFrame[] = [];
    for (let d = this.functionDepth - 1; d >= 0; d -= 1) {
      const span = this.frameSpans[d];
      out.push({
        name: this.frameNames[d] ?? "?",
        line: span?.start.line ?? 0,
        file: span?.file ?? "",
      });
    }
    return out;
  }

  /** Attaches the route to an error on its way out, and leaves anything else alone. */
  private withTrace(err: unknown): unknown {
    if (err instanceof QbskRuntimeError && err.trace.length === 0) {
      err.trace = this.captureTrace();
    }
    return err;
  }

  private callValue(
    callee: QValue,
    args: QValue[],
    calleeExpr: Expr | null,
    span: Span,
  ): QValue {
    if (callee.type === "native") {
      if (MUTATING_NATIVES.has(callee.name)) {
        // The mutated container is the first argument for every native in the set. A
        // call held wrong reports from inside the native, so an absent or non-container
        // first argument is counted rather than exempted — the conservative direction.
        const target = args[0];
        if (target !== undefined && (target.type === "list" || target.type === "dict")) {
          this.noteMutation(target);
        } else {
          this.mutationEpoch += 1;
        }
      }
      // A native throws its own error, so the route has to be attached here rather than
      // in `runtime()`. Most errors in a QBSK program are a native's -- a bad argument, a
      // missing key -- and a trace that covered only interpreter errors would be the same
      // feature with better odds.
      try {
        return callee.fn(args, span);
      } catch (err) {
        throw this.withTrace(err);
      }
    }
    if (callee.type === "func") {
      // §15.21 — with defaults an arity is a RANGE. The message keeps its old
      // single-number form when there are none, because that is still the whole truth
      // then, and `expects 2 to 2 arguments` is a worse sentence for the common case.
      const total = callee.params.length;
      let required = total;
      for (let i = 0; i < total; i += 1) {
        if (callee.params[i]!.defaultValue !== null) {
          required = i;
          break;
        }
      }
      if (args.length < required || args.length > total) {
        const wanted =
          required === total ? `${total} arguments` : `${required} to ${total} arguments`;
        this.runtime(
          `function '${callee.name}' expects ${wanted}, got ${args.length}`,
          span,
        );
      }
      const callEnv = new Env(callee.closure);
      // §15.4 — QBSK reports at ITS OWN documented depth. Left to V8 the program dies
      // with `Maximum call stack size exceeded`, no span, at whatever depth that host
      // happens to run out of frames — a different answer on a different machine.
      if (this.functionDepth >= MAX_CALL_DEPTH) {
        this.runtime(
          `call depth limit of ${MAX_CALL_DEPTH} reached — is '${callee.name}' recursing without a base case?`,
          span,
        );
      }
      const parentEnv = this.env;
      const parentLoop = this.loopDepth;
      const parentFunc = this.functionDepth;
      this.frameNames[this.functionDepth] = callee.name;
      this.frameSpans[this.functionDepth] = span;
      this.env = callEnv;
      this.loopDepth = 0;
      this.functionDepth += 1;
      try {
        // The parameters are bound INSIDE the frame, left to right, so a default may
        // name a parameter already bound — `count = len(text) - from` — and a
        // default that fails reports from inside the call it belongs to.
        for (let i = 0; i < total; i += 1) {
          const p = callee.params[i]!;
          // §15.21 — evaluated at CALL time and only when the argument is
          // missing, so `into = []` is a fresh list per call. Evaluated once at the
          // declaration it would be one list shared by every call, which is a bug the
          // language would have taught.
          const value = i < args.length ? args[i]! : this.visitExpr(p.defaultValue!);
          callEnv.define(p.name, value, "var");
        }
        this.execBody(callee.body);
        return { type: "null" };
      } catch (err) {
        if (err instanceof ReturnSignal) {
          return err.value;
        }
        // §15.22 — the name IS in scope (the break checked), but it belongs to a
        // loop in the caller. Allowed through, it would break whatever loop the caller
        // happened to be running: a program that does something different depending on
        // who called it. It is also the only way a signal could reach the host, which
        // would be a raw JS object surfacing as an error with no span (I3).
        if (err instanceof BreakSignal || err instanceof ContinueSignal) {
          const word = err instanceof BreakSignal ? "break" : "continue";
          this.runtime(
            `'${word} ${err.label}' cannot leave the function '${callee.name}' — a loop is broken from inside itself, and a call is not inside it`,
            err.span,
          );
        }
        throw err;
      } finally {
        this.env = parentEnv;
        this.loopDepth = parentLoop;
        this.functionDepth = parentFunc;
      }
    }
    const label =
      calleeExpr !== null && calleeExpr.kind === "Ident"
        ? calleeExpr.name
        : typeName(callee);
    return this.runtime(`'${label}' is not a function`, span);
  }

  private resolveAnchor(v: QValue, span: Span): string | [number, number] {
    if (v.type === "str") {
      if (!ANCHOR_NAMES.has(v.value)) {
        // The list is DERIVED from the set, not typed out beside it. A hand-written
        // copy is how the message came to advertise nine names while the table held
        // ten (§15.9): two sources for one fact, drifting apart quietly.
        this.runtime(
          `unknown anchor '${v.value}'` +
            this.hint(v.value, ANCHOR_NAMES) +
            ` (names: ${[...ANCHOR_NAMES].join(", ")}) or tuple (fx, fy)`,
          span,
        );
      }
      return v.value;
    }
    if (v.type === "tuple" && isNumber(v.x) && isNumber(v.y)) {
      const fx = v.x.value;
      const fy = v.y.value;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) {
        this.runtime("the anchor (fx, fy) must be between 0 and 1", span);
      }
      return [fx, fy];
    }
    return this.runtime("the anchor must be a name or a tuple (fx, fy)", span);
  }

  private resolveScale(v: QValue, span: Span): [number, number] {
    if (
      v.type === "tuple" &&
      v.x.type === "int" &&
      v.y.type === "int" &&
      v.x.value >= 1 &&
      v.y.value >= 1
    ) {
      return [v.x.value, v.y.value];
    }
    return this.runtime("scale must be (fx, fy) with ints ≥ 1", span);
  }
}
