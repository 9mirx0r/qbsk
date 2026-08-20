// Transport-safe shapes for the Studio MCP surface (docs/studio.md §11). This module
// is pure: types only, no Electron, no interpreter imports — so both server.ts and the
// tests share it without pulling in anything heavy.

export interface Position {
  line: number;
  col: number;
  offset: number;
}

// The structured error every tool returns (docs/studio.md §11.5): span + source
// fragment + suggestion. Never a flattened string.
export interface QbskErrorShape {
  kind: "syntax" | "semantic" | "runtime";
  message: string;
  file: string;
  start: Position;
  end: Position;
  source: string;
  fragment: string;
  suggestion?: string;
}

export interface GridSnapshot {
  width: number;
  height: number;
  rows: string[];
  cells: number;
  ms: { script: number; compose: number; diff: number; emit: number };
}

export interface LoopStatus {
  running: boolean;
  frames: number;
  error: QbskErrorShape | null;
}

// In-band QBSK failure returned by a tool. JSON-RPC errors are reserved for
// protocol-level problems; a parse/analyze/runtime error is a normal tool result.
export interface ToolError {
  ok: false;
  error: QbskErrorShape;
}

export interface CheckResult {
  /** Envelope contract shared by every tool: the CALL ran. Never "the source is fine". */
  ok: true;
  /**
   * True only when `problems` is empty. `ok` cannot carry this meaning without
   * breaking the envelope every other tool uses, and an agent reading `ok` first
   * would otherwise proceed with broken source — so the verdict gets its own field.
   */
  clean: boolean;
  problems: QbskErrorShape[];
}

export interface EvalResult {
  ok: true;
  value: JsonValue;
  type: string;
  print: string[];
  grid: GridSnapshot | null;
}

export interface ScreenResult {
  ok: true;
  grid: GridSnapshot;
}

export interface InspectResult {
  ok: true;
  name: string;
  value: JsonValue;
  type: string;
  binding: "var" | "const" | "native";
}

export interface ListVarsResult {
  ok: true;
  names: string[];
}

export interface FileResult {
  ok: true;
  path: string;
  source: string;
}

export interface SaveResult {
  ok: true;
  path: string;
  bytes: number;
}

export interface LoopResult {
  ok: true;
  status: LoopStatus;
  grid: GridSnapshot | null;
}

// An earlier release (docs/studio.md §16.2): the result of pressing a key on the loaded program.
export interface KeyResult {
  ok: true;
  key: string;
  /** The key entered the queue. */
  delivered: boolean;
  /**
   * A matching `on key` handler ran. Separate from `delivered` on purpose: a key no
   * handler claims is legal, and collapsing the two would make "nothing is bound to
   * this key" indistinguishable from "the handler ran and chose to do nothing".
   */
  handled: boolean;
  /** Frames actually advanced after the press. */
  frames: number;
  /** The simulation turn after stepping — how a free action is told from a no-op. */
  turn: number;
  grid: GridSnapshot | null;
  print: string[];
}

// An earlier release (docs/studio.md §17): the result of running a project file as the program.
// `source` is deliberately absent — the whole point is that the file's text never
// crosses the wire. `lines` tells the agent what it loaded without sending it back.
export interface LoadResult {
  ok: true;
  path: string;
  lines: number;
  /**
   * Analyzer problems found before running. Non-empty means NOTHING was loaded: a
   * program the analyzer rejects must not reach frame 1, where the same mistake
   * reappears as a runtime error carrying less information.
   */
  problems: QbskErrorShape[];
  grid: GridSnapshot | null;
  print: string[];
}

// An earlier release (docs/studio.md §16.3): one line of the session log.
export interface TraceEntry {
  /** Monotonic and never reused: the cursor `since` takes. */
  seq: number;
  /** Milliseconds since session start — comparable across runs, unlike wall clock. */
  at: number;
  kind: "tool" | "load" | "frame" | "key" | "turn" | "print" | "error";
  /** Already human-readable: the consumer is a model reading a list. */
  detail: string;
  data?: JsonValue;
}

export interface TraceResult {
  ok: true;
  entries: TraceEntry[];
  /** Pass as `since` next call to read only what is new. */
  next: number;
  /**
   * How many entries the ring discarded. Reported rather than swallowed: an agent
   * reasoning over a silently truncated history draws confident wrong conclusions.
   */
  dropped: number;
}

// An earlier release: a procedurally generated pixel-art sprite (examples/lib/pixelart.qbsk +
// src/tools/spriteGen.ts). `svg` is the full SVG text inline — an agent gets visual
// feedback without a second round-trip to read the file back.
export interface GenerateSpriteResult {
  ok: true;
  seed: number;
  // An earlier release: null for the free-form blob, otherwise the requested silhouette name
  // (e.g. "sword") — mask-gated generation, found necessary live: a seed alone can't
  // target a specific recognizable object.
  shape: string | null;
  width: number;
  height: number;
  filled: number;
  total: number;
  qbdataPath: string;
  svgPath: string;
  svg: string;
}

export type ToolResult =
  | ToolError
  | CheckResult
  | EvalResult
  | ScreenResult
  | InspectResult
  | ListVarsResult
  | FileResult
  | SaveResult
  | LoopResult
  | KeyResult
  | TraceResult
  | LoadResult
  | GenerateSpriteResult;

// The host contract (docs/studio.md §11.1): the object that owns the interpreter
// state. The embedded server and the headless tests both implement it.
// What the WINDOW is showing (docs/studio.md §15) — the opposite direction from the
// session mirror, and observation in exactly the same sense.
export interface WindowResult {
  ok: true;
  width: number;
  height: number;
  grid: string;
  showing: string;
  /** How old this snapshot is. A reader must be able to tell live from stale. */
  ageMs: number;
  /** Absolute path of the PNG capture, or null when none has been written. */
  image: string | null;
}

export interface McpHost {
  projectRoot(): string;
  check(source: string, file: string): CheckResult;
  eval(source: string, file: string): EvalResult | ToolError;
  readScreen(): ScreenResult | ToolError;
  readWindow(): WindowResult | ToolError;
  inspect(name: string): InspectResult | ToolError;
  listVars(): ListVarsResult;
  open(path: string): FileResult | ToolError;
  save(path: string, source: string): SaveResult | ToolError;
  loop(command: "start" | "stop" | "step" | "status" | "reload", dt: number): LoopResult;
  key(name: string, steps: number, dt: number): KeyResult | ToolError;
  trace(limit: number, since: number): TraceResult;
  load(path: string, check: boolean): LoadResult | ToolError;
  generateSprite(seed: number, size: number, shape?: string): GenerateSpriteResult | ToolError;
  resources(): Map<string, string>;
}

// Minimal JSON value usable across the wire.
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
