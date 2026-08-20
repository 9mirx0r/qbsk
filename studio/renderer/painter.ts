// Choosing a painter (docs/studio.md §4.2).
//
// Both painters expose the same four methods, so everything downstream of this file is
// unchanged by the choice. That is the seam F3 was designed around rather than a
// convenience: `renderer.ts` calls `grid.paint(res.diff)` and has no opinion about how
// the pixels arrive.
//
// GL is tried first and the DOM is the fallback, in that order and not the other way.
// WebGL is unavailable on some machines and inside some sandboxes, and "unavailable" is
// a fact rather than an error — `createGlDevice` returns null and the window still
// paints. F3's own measurement is what makes that acceptable: the DOM painter costs
// 0.80 ms on a 450-cell diff, which is most frames.
import { DomGrid } from "./paint.js";
import { GlGrid, type GlyphDevice } from "./glgrid.js";
import { createGlDevice } from "./gldevice.js";
import { CRT_DEFAULT, type CrtSettings } from "./glshader.js";
import type { Cell } from "../../src/engine/cell.js";
import type { DiffLine } from "../../src/engine/diff.js";

/** What `renderer.ts` needs from a painter, and all it has ever needed. */
export interface Painter {
  setTiles(tiles: Map<string, string> | null): void;
  reset(width: number, height: number): void;
  paint(diff: DiffLine[]): void;
  renderText(): string;
  /**
   * Optional, because DomGrid does not need it: CSS scales its spans from one font-size
   * on the container. A texture has no font-size, so the GPU painter has to be told.
   */
  setCellSize?(width: number, height: number): void;
  /**
   * Optional for the same reason: the CRT is a shader, and `DomGrid` has no shader.
   * A caller must treat its absence as "this backend cannot" and SAY so — a control
   * that silently does nothing is exactly the ghost feature the review protocol names.
   */
  setCrt?(crt: CrtSettings): void;
}

export interface PainterChoice {
  painter: Painter;
  /** Which one was built, so the status bar can say rather than the user guess. */
  backend: "webgl" | "dom";
}

/**
 * Builds the best painter this machine can run.
 *
 * `domHost` is the element DomGrid fills with spans; `glCanvas` is the `<canvas>` the GL
 * painter draws into. Whichever loses is hidden by the caller — both exist in the
 * document because deciding at run time means neither can be built lazily without a
 * reflow at the worst possible moment.
 */
export function choosePainter(
  domHost: HTMLElement,
  glCanvas: HTMLCanvasElement | null,
  cellWidth: number,
  cellHeight: number,
  font: string,
  crt: CrtSettings = CRT_DEFAULT,
): PainterChoice {
  if (glCanvas !== null) {
    const device: GlyphDevice | null = createGlDevice(glCanvas, cellWidth, cellHeight, font, crt);
    if (device !== null) {
      return { painter: new GlGrid(device), backend: "webgl" };
    }
  }
  return { painter: new DomGrid(domHost), backend: "dom" };
}

/** A Cell is re-exported so a caller need not reach into src/ for the painter's type. */
export type { Cell };
