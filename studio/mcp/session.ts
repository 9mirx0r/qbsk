// The MCP session host (docs/studio.md §11.1/§11.4): owns the project root, the
// loaded program (a persistent SceneProgram, an earlier release), the double buffer + diff and
// the frame counter. Pure — imports only Node builtins and ../src, never Electron —
// so it runs headless in tests and embedded in the main process at runtime.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { ScreenBuffer } from "../../src/engine/buffer.js";
import { computeDiff } from "../../src/engine/diff.js";
import { isCanonicalKey, suggestKey } from "../../src/engine/keys.js";
import { parse } from "../../src/parser/parser.js";
import { analyzeProgram } from "../../src/analyze/analyzer.js";
import { qbskFragment, type QbskError } from "../../src/interp/error.js";
import { SceneProgram, type SnippetRun } from "../../src/interp/interpreter.js";
import { typeName, type QValue } from "../../src/interp/value.js";
import { generateSpriteAssets } from "../../src/tools/spriteGen.js";
import { SessionJournal } from "./journal.js";
import { readWindowSnapshot } from "./window.js";
import type {
  CheckResult,
  EvalResult,
  FileResult,
  GenerateSpriteResult,
  GridSnapshot,
  InspectResult,
  JsonValue,
  KeyResult,
  ListVarsResult,
  LoadResult,
  LoopResult,
  LoopStatus,
  McpHost,
  QbskErrorShape,
  SaveResult,
  ScreenResult,
  TraceEntry,
  TraceResult,
  WindowResult,
  ToolError,
} from "./types.js";

const DEFAULT_DT = 1 / 60;

// The trace ring (docs/studio.md §16.3). Capped because an unbounded log inside a
// 60 fps loop is a memory leak with a nice name; the drop count is reported so a
// truncated history is a fact the reader knows about, not a surprise.
const TRACE_LIMIT = 1000;

function errorShape(source: string, err: QbskError): QbskErrorShape {
  const lines = source.split("\n");
  const line = Math.max(1, err.span.start.line);
  return {
    kind: err.kind,
    message: err.message,
    file: err.span.file,
    start: {
      line: err.span.start.line,
      col: err.span.start.col,
      offset: err.span.start.offset,
    },
    end: {
      line: err.span.end.line,
      col: err.span.end.col,
      offset: err.span.end.offset,
    },
    source: lines[line - 1] ?? "",
    fragment: qbskFragment(source, err),
  };
}

function qValueToJson(v: QValue): JsonValue {
  switch (v.type) {
    case "null":
      return null;
    case "bool":
    case "int":
    case "float":
      return v.value;
    case "str":
      return v.value;
    case "list":
      return v.items.map(qValueToJson);
    case "dict": {
      const out: { [key: string]: JsonValue } = {};
      for (const [k, val] of v.map) out[k] = qValueToJson(val);
      return out;
    }
    case "tuple":
      return [qValueToJson(v.x), qValueToJson(v.y)];
    case "func":
      return `<func ${v.name}>`;
    case "native":
      return `<native ${v.name}>`;
    case "scene":
      return `<scene ${v.name}>`;
    case "layer":
      return `<layer ${v.name} z:${v.z.type === "int" ? v.z.value : "?"}>`;
    case "event":
      return `<event ${v.event}>`;
    case "sprite":
      return `<sprite ${v.name}>`;
    case "primitive":
      return `<primitive ${v.kind}>`;
    case "canvas":
      return "<canvas>";
    case "rng":
      // Opaque by design (docs/language.md §6.5): a generator advances when rolled,
      // so there is no value to show — and showing its internal state would invite
      // saving it, when what a program must persist is the SEED.
      return "<rng>";
    case "module":
      return `<module ${v.name}>`;
  }
}

function notFound(what: string): ToolError {
  return {
    ok: false,
    error: {
      kind: "semantic",
      message: what,
      file: "",
      start: { line: 0, col: 0, offset: 0 },
      end: { line: 0, col: 0, offset: 0 },
      source: "",
      fragment: "",
    },
  };
}

export class McpSessionHost implements McpHost {
  private readonly root: string;
  private source = "";
  private file = "program.qbsk";
  private program: SceneProgram | null = null;
  private runtime = { gameTime: 0 };
  private buffer: ScreenBuffer | null = null;
  private currentGrid: GridSnapshot | null = null;
  private running = false;
  private frames = 0;
  private loadError: QbskErrorShape | null = null;
  // Print output from the loaded program's top level and event handlers, kept so
  // the first qbsk_eval can return what the load itself printed (docs/studio.md §11.4).
  private programOut: string[] = [];
  private readonly resourcesMap: Map<string, string>;
  // The session mirror (docs/studio.md §12). Write-only from here: the session
  // never reads it back, which is what keeps observation from becoming control.
  private readonly journal: SessionJournal;
  // The trace ring (docs/studio.md §16.3). Deliberately NOT the journal: §12.2 makes
  // the journal one-way by construction, and reading it back here would undo that.
  // This is in-memory, owned by the session, and readable through qbsk_trace.
  private readonly traceRing: TraceEntry[] = [];
  private traceSeq = 0;
  private traceDropped = 0;
  private readonly startedAt = Date.now();

  constructor(root: string, resources: Map<string, string>) {
    this.root = resolve(root);
    this.resourcesMap = resources;
    this.journal = new SessionJournal(this.root);
  }

  /**
   * Append one line to the trace. `detail` is written as a sentence because the
   * consumer is a model reading a list: a reconstructed field dump costs a parse,
   * a sentence costs a read.
   */
  private note(kind: TraceEntry["kind"], detail: string, data?: JsonValue): void {
    this.traceSeq += 1;
    const entry: TraceEntry = {
      seq: this.traceSeq,
      at: Date.now() - this.startedAt,
      kind,
      detail,
    };
    if (data !== undefined) {
      entry.data = data;
    }
    this.traceRing.push(entry);
    if (this.traceRing.length > TRACE_LIMIT) {
      this.traceRing.shift();
      this.traceDropped += 1;
    }
  }

  /** Everything the agent asked for, in order, whether it worked or not. */
  trace(limit: number, since: number): TraceResult {
    const cap = limit > 0 ? limit : 50;
    const fresh = this.traceRing.filter((e) => e.seq > since);
    // The tail, not the head: the newest entries are the ones that explain now.
    const entries = fresh.slice(-cap);
    return {
      ok: true,
      entries,
      next: entries.length > 0 ? entries[entries.length - 1]!.seq : since,
      dropped: this.traceDropped,
    };
  }

  /** The mirror file the window watches. Exposed for tests and for the window. */
  journalFile(): string {
    return this.journal.file;
  }

  /**
   * The session is over: stop the loop and write the `end` record so the window
   * stops trusting its last frame (docs/studio.md §12.4). Called by the stdio
   * transport when the client disconnects or the process exits — the one place a
   * session can end. Idempotent: the journal ignores a second call.
   */
  end(): void {
    this.running = false;
    this.journal.end();
  }

  /** Log an agent action to the mirror for the stream (docs/studio.md §12.5). */
  private logAction(tool: string, args: unknown, ok: boolean): void {
    this.journal.action(tool, args, ok);
    // Every tool call lands in the trace too, so "what did the agent do" and "what
    // did the program do" read as one ordered story instead of two half-stories.
    this.note("tool", `${tool} → ${ok ? "ok" : "error"}`, args as JsonValue);
  }

  projectRoot(): string {
    return this.root;
  }

  resources(): Map<string, string> {
    return this.resourcesMap;
  }

  private loadProgram(source: string, file: string): QbskErrorShape | null {
    this.program = null;
    this.buffer = null;
    this.currentGrid = null;
    this.frames = 0;
    this.loadError = null;
    this.runtime = { gameTime: 0 };
    this.programOut = [];
    const parsed = parse(source, file);
    if (parsed.errors.length > 0) {
      this.loadError = errorShape(source, parsed.errors[0]!);
      this.note("error", `load '${file}' failed to parse: ${this.loadError.message}`);
      return this.loadError;
    }
    this.program = new SceneProgram(parsed.ast, {
      // Resolve against the project root, not the server's cwd. `file` arrives as
      // a project-relative path ("examples/jail.qbsk"), so dirname(file) alone is
      // "examples" — which the interpreter would then resolve against wherever the
      // MCP process happens to have been started. Any scene loading a sprite or a
      // `use` module failed with "file not found" under MCP while working fine
      // from the CLI. Found in an earlier release; missed by an earlier review because no
      // test scene loaded an external resource.
      baseDir: resolve(this.root, dirname(file)),
      runtime: this.runtime,
      print: (line) => {
        this.programOut.push(line);
        this.note("print", line);
      },
    });
    if (this.program.error !== null) {
      this.loadError = errorShape(source, this.program.error);
      this.note("error", `load '${file}' failed: ${this.loadError.message}`);
      return this.loadError;
    }
    this.note("load", `loaded '${file}' (${source.split("\n").length} lines)`);
    return null;
  }

  private snapshotFromCanvas(
    canvas: NonNullable<SnippetRun["canvas"]>,
    t0: number,
  ): GridSnapshot {
    if (
      this.buffer === null ||
      this.buffer.width !== canvas.width ||
      this.buffer.height !== canvas.height
    ) {
      this.buffer = new ScreenBuffer(canvas.width, canvas.height);
      // A fresh buffer means a new program or a resize: the mirror must clear its
      // grid before the diffs that follow, or it would patch onto a stale screen.
      this.journal.reset(canvas.width, canvas.height);
    }
    const t1 = performance.now();
    this.buffer.paintCanvas(canvas);
    const t2 = performance.now();
    const diff = computeDiff(
      this.buffer.front,
      this.buffer.back,
      this.buffer.width,
      this.buffer.dirtyLines,
    );
    const t3 = performance.now();
    const cells = diff.reduce((acc, d) => acc + d.changed, 0);
    this.buffer.swap();
    // The session mirror (docs/studio.md §12): every frame is published as a DIFF,
    // never a full grid. This is the one place a frame is born, so it is the one
    // place that publishes.
    this.journal.frame(diff);
    return {
      width: canvas.width,
      height: canvas.height,
      rows: canvas.renderText().split("\n"),
      cells,
      ms: { script: t1 - t0, compose: t2 - t1, diff: t3 - t2, emit: 0 },
    };
  }

  check(source: string, file: string): CheckResult {
    const parsed = parse(source, file);
    if (parsed.errors.length > 0) {
      const problems = parsed.errors.map((e) => errorShape(source, e));
      this.logAction("qbsk_check", { file }, true);
      return { ok: true, clean: problems.length === 0, problems };
    }
    // Same resolution as loadProgram above, and for the same reason: `file` arrives as
    // a project-relative path, so a `use` inside it resolves against its own directory
    // — the contract docs/studio.md §11.4 states ("module/sprite resolution inside QBSK
    // stays relative to the including file"). Resolving against the project root instead
    // reported phantom "file not found" problems for every example that loads a module,
    // while `qbsk check` on the same file exited 0. Fixed in an earlier release for the loading
    // path and missed here, exactly as an earlier review missed it: no test checked a
    // scene with an external resource. One does now.
    const baseDir = resolve(this.root, dirname(file));
    const problems = analyzeProgram(parsed.ast, file, baseDir).map((e) =>
      errorShape(source, e),
    );
    this.logAction("qbsk_check", { file }, true);
    return { ok: true, clean: problems.length === 0, problems };
  }

  eval(source: string, file: string): EvalResult | ToolError {
    if (this.program === null) {
      const err = this.loadProgram(source, file);
      if (err !== null) {
        this.logAction("qbsk_eval", { file }, false);
        return { ok: false, error: err };
      }
      this.source = source;
      this.file = file;
      // One frame so the freshly loaded scene composes into the grid.
      const { error, grid } = this.stepFrame(DEFAULT_DT);
      if (error !== null) {
        this.logAction("qbsk_eval", { file }, false);
        return { ok: false, error };
      }
      this.logAction("qbsk_eval", { file }, true);
      return { ok: true, value: null, type: "null", print: [...this.programOut], grid };
    }
    const t0 = performance.now();
    let run: SnippetRun;
    try {
      run = this.program.evalSnippet(source, file);
    } catch (err) {
      // `define`/`assign` raise plain Errors (not QbskRuntimeError) on redefinition
      // and constant reassignment; fold them into the structured contract so the
      // host never throws at the agent (docs/studio.md §11.4 "existing binding wins").
      const message = err instanceof Error ? err.message : String(err);
      this.logAction("qbsk_eval", { file, snippet: true }, false);
      return {
        ok: false,
        error: {
          kind: "runtime",
          message,
          file,
          start: { line: 0, col: 0, offset: 0 },
          end: { line: 0, col: 0, offset: 0 },
          source: "",
          fragment: "",
        },
      };
    }
    if (run.error !== null) {
      this.logAction("qbsk_eval", { file, snippet: true }, false);
      const shape = errorShape(source, run.error);
      this.note("error", `${shape.kind} at ${shape.file}:${shape.start.line} — ${shape.message}`);
      return { ok: false, error: shape };
    }
    if (run.exitCode !== null) {
      this.logAction("qbsk_eval", { file, snippet: true }, true);
      return {
        ok: true,
        value: null,
        type: "null",
        print: run.out,
        grid: null,
      };
    }
    const grid =
      run.canvas !== null ? this.snapshotFromCanvas(run.canvas, t0) : this.currentGrid;
    if (grid !== null) {
      this.currentGrid = grid;
    }
    this.logAction("qbsk_eval", { file, snippet: true }, true);
    return {
      ok: true,
      value: run.value !== null ? qValueToJson(run.value) : null,
      type: run.value !== null ? typeName(run.value) : "null",
      print: run.out,
      grid,
    };
  }

  /**
   * Press a key on the loaded program, then advance frames (docs/studio.md §16.2).
   *
   * Calls the same `pressKey` the CLI and the window call — there is no second input
   * path, so nothing the agent can reach here is unreachable for a player.
   */
  key(name: string, steps: number, dt: number): KeyResult | ToolError {
    if (this.program === null) {
      this.logAction("qbsk_key", { key: name }, false);
      return notFound("no program loaded: evaluate a scene before pressing keys");
    }
    // A wrong name used to queue silently and look exactly like a key the game
    // ignores on purpose. The analyzer teaches on a typo; so does this.
    if (!isCanonicalKey(name)) {
      this.logAction("qbsk_key", { key: name }, false);
      const hint = suggestKey(name);
      const err = notFound(
        `'${name}' is not a canonical key name (src/engine/keys.ts)`,
      );
      if (hint !== null) {
        err.error.suggestion = hint;
      }
      this.note("error", `key '${name}' refused${hint !== null ? ` — did you mean '${hint}'?` : ""}`);
      return err;
    }
    const handled = this.program.hasKeyHandler(name);
    const turnBefore = this.program.runtime.sim?.turn ?? 0;
    const before = this.programOut.length;
    this.program.pressKey(name);
    const count = steps > 0 ? Math.floor(steps) : 1;
    const span = dt > 0 ? dt : DEFAULT_DT;
    let grid: GridSnapshot | null = this.currentGrid;
    let advanced = 0;
    for (let i = 0; i < count; i += 1) {
      const stepped = this.stepFrame(span);
      if (stepped.error !== null) {
        this.logAction("qbsk_key", { key: name, steps: count }, false);
        return { ok: false, error: stepped.error };
      }
      advanced += 1;
      if (stepped.grid !== null) {
        grid = stepped.grid;
      }
    }
    const turn = this.program.runtime.sim?.turn ?? 0;
    const printed = this.programOut.slice(before);
    this.logAction("qbsk_key", { key: name, steps: count }, true);
    this.note(
      "key",
      `key '${name}' → ${handled ? "handled" : "no handler"}, ${advanced} frame(s)` +
        (turn !== turnBefore ? `, turn ${turnBefore} → ${turn}` : `, turn ${turn} (free)`),
      { key: name, handled, turn },
    );
    if (turn !== turnBefore) {
      this.note("turn", `turn ${turn} resolved`, { turn });
    }
    return {
      ok: true,
      key: name,
      delivered: true,
      handled,
      frames: advanced,
      turn,
      grid,
      print: printed,
    };
  }

  /**
   * Run a project file as the program (docs/studio.md §17).
   *
   * The file is read HERE: its text never crosses the wire, which is the whole point.
   * Unlike `eval`, the meaning never depends on session state — this always discards
   * the current program and runs the file fresh, so calling it twice is a reload from
   * disk (what an agent wants after `save`).
   */
  load(path: string, check: boolean): LoadResult | ToolError {
    const resolved = this.resolvePath(path);
    if (typeof resolved !== "string") {
      this.logAction("qbsk_load", { path }, false);
      this.note("error", `load '${path}' refused: ${resolved.error.message}`);
      return resolved;
    }
    let source: string;
    try {
      source = readFileSync(resolved, "utf8");
    } catch {
      this.logAction("qbsk_load", { path }, false);
      this.note("error", `load '${path}' failed: file not found`);
      return notFound(`cannot read '${path}': file not found`);
    }
    const lines = source.split("\n").length;
    // Analyze BEFORE running unless explicitly told not to: the analyzer reports at the
    // offending line, while the same mistake at frame 1 is a runtime error with less to
    // go on. Problems mean nothing is loaded — a half-loaded program would be worse than
    // no program, because the agent could inspect it and believe it ran.
    if (check) {
      const checked = this.check(source, path);
      if (!checked.clean) {
        this.logAction("qbsk_load", { path, check }, false);
        this.note(
          "error",
          `load '${path}' refused: ${checked.problems.length} analyzer problem(s), nothing loaded`,
        );
        return { ok: true, path, lines, problems: checked.problems, grid: null, print: [] };
      }
    }
    const err = this.loadProgram(source, path);
    if (err !== null) {
      this.logAction("qbsk_load", { path, check }, false);
      return { ok: false, error: err };
    }
    this.source = source;
    this.file = path;
    // One frame so the scene composes: a load that shows nothing drawn is indis-
    // tinguishable from a load that failed, and they are different facts.
    const { error, grid } = this.stepFrame(DEFAULT_DT);
    if (error !== null) {
      this.logAction("qbsk_load", { path, check }, false);
      return { ok: false, error };
    }
    this.logAction("qbsk_load", { path, check }, true);
    return { ok: true, path, lines, problems: [], grid, print: [...this.programOut] };
  }

  readScreen(): ScreenResult | ToolError {
    if (this.currentGrid === null) {
      this.logAction("qbsk_read_screen", {}, false);
      return notFound("no scene has produced a frame yet");
    }
    this.logAction("qbsk_read_screen", {}, true);
    return { ok: true, grid: this.currentGrid };
  }

  /**
   * What the WINDOW is showing (docs/studio.md §15).
   *
   * Distinct from readScreen, and the difference matters: readScreen returns what THIS
   * session painted, while this returns what the person is actually looking at — their
   * live scene, their console, whatever they opened. Without it an agent is blind to
   * everything it did not draw itself.
   *
   * Reports ageMs rather than pretending the snapshot is current: a window that is
   * closed leaves its last frame on disk, and a reader that cannot tell live from stale
   * would confidently describe a screen nobody is looking at.
   */
  readWindow(): WindowResult | ToolError {
    const snap = readWindowSnapshot(this.root);
    if (snap === null) {
      this.logAction("qbsk_read_window", {}, false);
      return notFound(
        "the window has not published a frame — is QBSK Studio running?",
      );
    }
    this.logAction("qbsk_read_window", {}, true);
    return {
      ok: true,
      width: snap.width,
      height: snap.height,
      grid: snap.text.join("\n"),
      showing: snap.showing,
      ageMs: Math.max(0, Date.now() - snap.at),
      image: snap.image,
    };
  }

  inspect(name: string): InspectResult | ToolError {
    if (this.program === null) {
      this.logAction("qbsk_inspect", { name }, false);
      return notFound(`variable '${name}' is not defined`);
    }
    const env = this.program.liveEnv;
    const value = env.get(name);
    if (value === undefined) {
      this.logAction("qbsk_inspect", { name }, false);
      return notFound(`variable '${name}' is not defined`);
    }
    const binding = env.kindOf(name) ?? "var";
    this.logAction("qbsk_inspect", { name }, true);
    return {
      ok: true,
      name,
      value: qValueToJson(value),
      type: typeName(value),
      binding,
    };
  }

  listVars(): ListVarsResult {
    if (this.program === null) {
      this.logAction("qbsk_list_vars", {}, true);
      return { ok: true, names: [] };
    }
    this.logAction("qbsk_list_vars", {}, true);
    return { ok: true, names: this.program.liveEnv.names() };
  }

  private resolvePath(path: string): string | ToolError {
    if (isAbsolute(path)) {
      return notFound("path must be relative to the project root");
    }
    const resolved = resolve(this.root, path);
    const rel = relative(this.root, resolved);
    if (rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel))) {
      return resolved;
    }
    return notFound(`path '${path}' escapes the project root`);
  }

  open(path: string): FileResult | ToolError {
    const resolved = this.resolvePath(path);
    if (typeof resolved !== "string") {
      this.logAction("qbsk_open", { path }, false);
      return resolved;
    }
    let source: string;
    try {
      source = readFileSync(resolved, "utf8");
    } catch {
      this.logAction("qbsk_open", { path }, false);
      this.note("error", `open '${path}' failed: file not found`);
      return notFound(`cannot read '${path}': file not found`);
    }
    this.logAction("qbsk_open", { path }, true);
    return { ok: true, path: resolved, source };
  }

  save(path: string, source: string): SaveResult | ToolError {
    const resolved = this.resolvePath(path);
    if (typeof resolved !== "string") {
      this.logAction("qbsk_save", { path }, false);
      return resolved;
    }
    try {
      writeFileSync(resolved, source, "utf8");
    } catch {
      this.logAction("qbsk_save", { path }, false);
      this.note("error", `save '${path}' failed: cannot write`);
      return notFound(`cannot write '${path}'`);
    }
    this.logAction("qbsk_save", { path }, true);
    this.note("tool", `wrote '${path}' (${source.length} bytes)`);
    return { ok: true, path: resolved, bytes: source.length };
  }

  // an earlier release: procedurally generate a pixel-art sprite (examples/lib/pixelart.qbsk,
  // via src/tools/spriteGen.ts — the same core bench/sprite-gen.mjs calls). The last
  // stage of that phase's design, built only after the pipeline was proven working via
  // the CLI script. Writes to a seed/size/shape-specific path under
  // examples/res/generated/ so repeat calls never collide with each other or with the
  // checked-in demo assets (examples/res/pixelart_creature.qbdata,
  // examples/res/pixelart_sword.qbdata).
  //
  // `shape` (an earlier release, found necessary live): omit it for the original free-form
  // symmetric blob; pass a name from src/tools/spriteGen.ts's SILHOUETTES (currently
  // "sword") to mask-gate generation to that recognizable object instead. An unknown
  // shape name, or a shape requested at a size it isn't authored for, is a structured
  // error — never a silent fallback to the blob.
  generateSprite(seed: number, size: number, shape?: string): GenerateSpriteResult | ToolError {
    const validSize: 16 | 32 = size === 32 ? 32 : 16;
    const libDir = resolve(this.root, "examples/lib");
    let assets: ReturnType<typeof generateSpriteAssets>;
    try {
      assets = generateSpriteAssets(seed, validSize, libDir, `SPRITE_${seed}`, shape);
    } catch (err) {
      this.logAction("qbsk_generate_sprite", { seed, size, shape }, false);
      return notFound(err instanceof Error ? err.message : String(err));
    }
    const outDir = resolve(this.root, "examples/res/generated");
    const suffix = shape !== undefined ? `${seed}_${validSize}_${shape}` : `${seed}_${validSize}`;
    const qbdataPath = resolve(outDir, `sprite_${suffix}.qbdata`);
    const svgPath = resolve(outDir, `sprite_${suffix}.svg`);
    try {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(qbdataPath, assets.qbdataText, "utf8");
      writeFileSync(svgPath, assets.svgText, "utf8");
    } catch {
      this.logAction("qbsk_generate_sprite", { seed, size, shape }, false);
      return notFound("cannot write generated sprite files");
    }
    this.logAction("qbsk_generate_sprite", { seed, size: validSize, shape }, true);
    return {
      ok: true,
      seed,
      shape: assets.shape,
      width: assets.width,
      height: assets.height,
      filled: assets.filled,
      total: assets.total,
      qbdataPath,
      svgPath,
      svg: assets.svgText,
    };
  }

  // Advances one frame on the loaded program: gameTime first, then the events and
  // scene recomposition. Returns the new grid, or the shape of a fatal error. A null
  // grid means the program produced no scene on this frame (not an error).
  private stepFrame(dt: number): { error: QbskErrorShape | null; grid: GridSnapshot | null } {
    if (this.program === null) {
      return { error: notFound("no program loaded").error, grid: null };
    }
    if (this.loadError !== null) {
      return { error: this.loadError, grid: null };
    }
    // gameTime is advanced by SceneProgram.step (interpreter.ts): the clock
    // belongs to the program, so no host has to remember to tick it.
    const t0 = performance.now();
    const frame = this.program.step(dt);
    if (frame.error !== null) {
      const shape = errorShape(this.source, frame.error);
      this.loadError = shape;
      this.note(
        "error",
        `frame ${this.frames + 1} died: ${shape.message} (${shape.file}:${shape.start.line})`,
      );
      return { error: shape, grid: null };
    }
    if (frame.exitCode !== null || frame.canvas === null) {
      return { error: null, grid: null };
    }
    this.frames += 1;
    const grid = this.snapshotFromCanvas(frame.canvas, t0);
    this.currentGrid = grid;
    return { error: null, grid };
  }

  private status(): LoopStatus {
    return {
      running: this.running,
      frames: this.frames,
      error: this.loadError,
    };
  }

  loop(command: "start" | "stop" | "step" | "status" | "reload", dt: number): LoopResult {
    switch (command) {
      case "start":
        this.running = true;
        this.logAction("qbsk_loop", { command: "start" }, true);
        return { ok: true, status: this.status(), grid: this.currentGrid };
      case "stop":
        this.running = false;
        this.logAction("qbsk_loop", { command: "stop" }, true);
        return { ok: true, status: this.status(), grid: this.currentGrid };
      case "status":
        this.logAction("qbsk_loop", { command: "status" }, true);
        return { ok: true, status: this.status(), grid: this.currentGrid };
      case "reload": {
        if (this.source === "") {
          this.logAction("qbsk_loop", { command: "reload" }, true);
          return { ok: true, status: this.status(), grid: null };
        }
        const err = this.loadProgram(this.source, this.file);
        if (err !== null) {
          this.logAction("qbsk_loop", { command: "reload" }, false);
          return { ok: true, status: this.status(), grid: null };
        }
        this.logAction("qbsk_loop", { command: "reload" }, true);
        return { ok: true, status: this.status(), grid: null };
      }
      case "step": {
        const { error, grid } = this.stepFrame(dt > 0 ? dt : DEFAULT_DT);
        this.logAction("qbsk_loop", { command: "step" }, error === null);
        return { ok: true, status: this.status(), grid: error !== null ? null : grid };
      }
    }
  }
}
