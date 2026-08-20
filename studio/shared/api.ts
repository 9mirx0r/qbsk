import type { DiffLine } from "../../src/engine/diff.js";

// Shared, transport-safe shapes for the IPC boundary between the main process
// and the renderer (docs/studio.md §3/§4). Types only: erased at runtime.

export interface SceneRun {
  ok: boolean;
  text: string[];
  ansi: string;
  diff: DiffLine[];
  cells: number;
  width: number;
  height: number;
  elapsedMs: number;
  error: string | null;
}

export interface FrameMetrics {
  scriptMs: number;
  composeMs: number;
  diffMs: number;
  emitMs: number;
  cells: number;
  bytes: number;
}

export interface StudioFrame {
  width: number;
  height: number;
  diff: DiffLine[];
  text: string[];
  ansi: string;
  metrics: FrameMetrics;
}

// One record of the session mirror (docs/studio.md §12.3). Mirrors MirrorRecord
// in studio/mcp/journal.ts; restated here because the renderer must not import
// from studio/mcp (it has no Node access).
export type MirrorEvent =
  | { t: "reset"; seq: number; width: number; height: number }
  | { t: "frame"; seq: number; diff: DiffLine[] }
  | { t: "end"; seq: number }
  | { t: "action"; seq: number; tool: string; args: unknown; result: "ok" | "error" };

export interface StudioApi {
  defaultScene(): Promise<{ file: string; source: string }>;
  readScene(file: string): Promise<string>;
  /**
   * `cellAspect` is the chosen font's cell shape (F0 §11.16). Optional, and the engine's
   * 2.0 stands when it is absent — a caller that does not know its font must not be made
   * to guess one.
   */
  run(source: string, file: string, cellAspect?: number): Promise<SceneRun>;
  smoke(payload: GridSmoke): Promise<void>;
  /**
   * Subscribe to the agent's session mirror. One direction only: main pushes,
   * the renderer listens. There is no counterpart that sends anything back —
   * that asymmetry is the §12.2 security boundary.
   */
  onMirror(handler: (records: MirrorEvent[]) => void): void;

  /**
   * Start a LIVE program in the main process and subscribe to its frames
   * (docs/studio.md §14.4). Unlike `run`, which composes once and discards the
   * program, this keeps a `SceneProgram` alive so `on tick` and `on key` fire.
   */
  live(source: string, file: string, cellAspect?: number): Promise<LiveStart>;
  onFrame(handler: (frame: StudioFrame) => void): void;
  stopLive(): Promise<void>;
  /**
   * Tells a running scene how many cells the window can show.
   *
   * `StudioHost.resize` existed and was documented from the day it was written, and
   * NOTHING called it — it was not even on this interface. So `on resize` never fired in
   * the Studio and a scene that sized itself from the window opened at whatever its
   * declaration said and stayed there.
   */
  resize(cols: number, rows: number): Promise<void>;

  /**
   * Send a keystroke to the LOCAL live program (docs/studio.md §14.5).
   *
   * This is renderer→main, which the mirror deliberately is not — and the two must
   * not be conflated. §12.2 forbids an *observer of the agent's session* writing into
   * that session; this reaches the window's own program and cannot address the MCP
   * session at all.
   *
   * Takes the RAW `KeyboardEvent.key`. Decoding happens in main, for two reasons: the
   * renderer states it does not import from `src/`, and a name arriving from the
   * renderer should be validated on the trusted side rather than believed.
   */
  pressKey(domKey: string): void;

  /**
   * Opens or closes the engine console (docs/studio.md §14). While it is open it owns
   * the keyboard, so keys stop reaching the scene program.
   */
  toggleConsole(open: boolean): Promise<LiveStart>;

  /**
   * Loads a tileset (docs/engine.md §15) and ships the glyph -> data URL map the
   * painter applies. Errors are returned, never thrown: a broken tileset leaves the
   * window painting characters. Main short-circuits to no tiles under smoke and when
   * QBSK_STUDIO_NO_TILES=1, so those runs never depend on a tileset file.
   */
  tileset(path: string): Promise<TilesetLoad>;

  /**
   * Asks main for a tileset file via the native dialog. Returns the chosen path, or
   * null when cancelled. Main-only because the renderer has no file access.
   */
  pickTileset(): Promise<string | null>;

  /**
   * Opens a scene from disk, returning its path and source together, or null if the
   * dialog was cancelled. Both in one call: the renderer needs the path to resolve a
   * `use` relative to the file and the source to fill the editor, and fetching them
   * separately would let the two disagree about which file is open.
   */
  openScene(): Promise<{ file: string; source: string } | null>;
}

/** Result of starting a live program: an error here is a parse error, reported once. */
export interface LiveStart {
  ok: boolean;
  error: string | null;
}

/**
 * Result of loading a tileset. `tiles` is null both for "no tileset" (empty path,
 * disabled, smoke) and for failure — the painter treats either as "paint characters",
 * which is the documented fallback (docs/engine.md §15.3). `error` distinguishes the
 * two so the settings dialog can say why nothing changed.
 */
export interface TilesetLoad {
  ok: boolean;
  tiles: Record<string, string> | null;
  error: string | null;
}

// Readback of the painted grid, reported by the renderer after the first paint.
// The main process ignores it unless QBSK_STUDIO_SMOKE=1, in which case it
// prints the payload and quits — the automated acceptance check (docs/studio.md §7).
export interface GridSmoke {
  width: number;
  height: number;
  cells: number;
  text: string;
}
