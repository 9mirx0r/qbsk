// GlGrid (docs/studio.md §4.2): DomGrid's four methods, painted through a glyph atlas.
//
// The GPU is behind `GlyphDevice`. That is not test scaffolding — it is where the seam
// belongs. This file owns the GRID: which cell changed, which glyph needs rasterising,
// what the two data textures should contain. The device owns WebGL, which is four calls
// and no decisions. Splitting them means the decisions are ordinary code with ordinary
// tests instead of assertions about the shape of a mock.
//
// `renderer.ts` calls `grid.paint(res.diff)` and knows nothing else, so this is a
// drop-in for `DomGrid` and the two can be chosen between at run time.
import type { Cell } from "../../src/engine/cell.js";
import type { DiffLine } from "../../src/engine/diff.js";
import { GlyphAtlas } from "./atlas.js";
import { packCell } from "./glpack.js";
import type { CrtSettings } from "./glshader.js";

/**
 * Everything the painter needs a GPU for.
 *
 * Deliberately small. Every method here is a direct WebGL call with no branch in it; a
 * method that needed a decision would mean a decision had leaked out of the grid.
 */
export interface GlyphDevice {
  /** Sizes the surface and the atlas texture. */
  resize(cols: number, rows: number, atlasWidth: number, atlasHeight: number): void;
  /**
   * How many pixels one cell occupies, which the FONT decides and this file cannot.
   *
   * Separate from `resize` because the two change independently: a scene resize keeps
   * the font, and the fit recomputing the font size keeps the grid. Hard-coding it — as
   * the first wiring did at 8x16 — renders correctly at exactly one font size and
   * stretches at every other.
   */
  setCellSize(width: number, height: number): void;
  /**
   * How hard each CRT effect is applied — five `uniform1f` calls and no decision.
   *
   * Separate from construction because the reader can change it while a scene is
   * running, and rebuilding the device to change a look would drop the atlas and the
   * textures with it.
   */
  setCrt(crt: CrtSettings): void;
  /** Rasterises one glyph into its atlas slot — the character, or a tile's image. */
  drawGlyph(char: string, slot: number, tile: string | null): void;
  /** Uploads the two data textures. */
  upload(fg: Uint8Array, bg: Uint8Array, cols: number, rows: number): void;
  /** One draw call. */
  draw(): void;
}

/** 32x32 slots. Braille alone is 256 (§11.15), so 16x16 overflows on one scene. */
const ATLAS_COLS = 32;
const ATLAS_ROWS = 32;

export class GlGrid {
  private atlas = new GlyphAtlas(ATLAS_COLS, ATLAS_ROWS);
  private width = 0;
  private height = 0;
  private fg = new Uint8Array(0);
  private bg = new Uint8Array(0);
  private painted: (Cell | null)[] = [];
  private tiles: Map<string, string> | null = null;

  constructor(private readonly device: GlyphDevice) {}

  /** Forwards the chosen CRT look. No repaint: the next `draw` reads the uniforms. */
  setCrt(crt: CrtSettings): void {
    this.device.setCrt(crt);
    this.device.draw();
  }

  /** Forwards the cell size the fit computed, then repaints at the new scale. */
  setCellSize(width: number, height: number): void {
    this.device.setCellSize(width, height);
    this.device.resize(this.width, this.height, this.atlas.textureWidth, this.atlas.textureHeight);
    this.flush();
  }

  /**
   * The glyph -> data URL map to paint in place of characters (docs/engine.md §15).
   *
   * Repaints everything, exactly as `DomGrid.setTiles` does and for the same reason: a
   * tileset changes every cell at once and the diff has nothing to say about it. The
   * first DOM version only stored the map, and choosing a tileset logged success while
   * leaving the window unchanged.
   *
   * The atlas is REBUILT, not patched. A slot holds pixels rather than a character, so
   * `"a"` with a tile and `"a"` without are two different pictures competing for one
   * slot — keeping the old one is how a tileset appears to work and then refuses to be
   * turned off.
   */
  setTiles(tiles: Map<string, string> | null): void {
    this.tiles = tiles;
    this.atlas = new GlyphAtlas(ATLAS_COLS, ATLAS_ROWS);
    this.device.resize(this.width, this.height, this.atlas.textureWidth, this.atlas.textureHeight);
    this.repack();
    this.flush();
  }

  reset(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.fg = new Uint8Array(width * height * 4);
    this.bg = new Uint8Array(width * height * 4);
    // A new grid has nothing painted. Keeping the old cells would let them be repainted
    // into a grid they no longer fit — the bug `DomGrid.reset` names in its own comment.
    this.painted = new Array<Cell | null>(width * height).fill(null);
    this.atlas = new GlyphAtlas(ATLAS_COLS, ATLAS_ROWS);
    this.device.resize(width, height, this.atlas.textureWidth, this.atlas.textureHeight);
  }

  /**
   * Patches the changed cells and presents the frame.
   *
   * One upload and one draw, whatever the diff holds — which is the whole point of the
   * change. `DomGrid`'s cost is per changed cell; this one's is per frame, so a full
   * repaint and a two-cell edit cost the same.
   *
   * Nothing is cleared. A run-based diff patches rather than redraws, so zeroing the
   * textures each frame would erase every cell the diff considered unchanged.
   */
  paint(diff: DiffLine[]): void {
    for (const line of diff) {
      if (line.rewrite) {
        const row = line.row ?? [];
        for (let x = 0; x < row.length; x += 1) {
          this.applyAt(line.y, x, row[x]!);
        }
      } else {
        for (const run of line.runs) {
          for (let i = 0; i < run.cells.length; i += 1) {
            this.applyAt(line.y, run.x + i, run.cells[i]!);
          }
        }
      }
    }
    this.flush();
  }

  /**
   * The grid read back as text, unpainted cells as spaces.
   *
   * `DomGrid` reads this out of the DOM. There is no DOM here, so the painted cells are
   * kept — which this needs anyway to repaint when a tileset arrives. The automated
   * smoke check compares this against what the terminal prints, and it must keep
   * working through the painter swap or the swap is unverifiable.
   */
  renderText(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let line = "";
      for (let x = 0; x < this.width; x += 1) {
        const cell = this.painted[y * this.width + x];
        line += cell === null || cell === undefined ? " " : cell.char;
      }
      rows.push(line);
    }
    return rows.join("\n");
  }

  private applyAt(y: number, x: number, cell: Cell): void {
    const i = y * this.width + x;
    if (i < 0 || i >= this.painted.length) {
      return;
    }
    this.painted[i] = cell;
    packCell(cell, this.atlas, this.fg, i * 4, this.bg, i * 4);
  }

  /** Repacks every painted cell, for when the atlas underneath them was replaced. */
  private repack(): void {
    for (let i = 0; i < this.painted.length; i += 1) {
      const cell = this.painted[i];
      if (cell !== null && cell !== undefined) {
        packCell(cell, this.atlas, this.fg, i * 4, this.bg, i * 4);
      }
    }
  }

  /** Rasterises whatever the packing newly asked for, then uploads and draws. */
  private flush(): void {
    for (const glyph of this.atlas.takePending()) {
      this.device.drawGlyph(glyph.char, glyph.slot, this.tiles?.get(glyph.char) ?? null);
    }
    this.device.upload(this.fg, this.bg, this.width, this.height);
    this.device.draw();
  }

  /** Characters there was no atlas room for, so a caller can report rather than hint. */
  get overflowedChars(): string[] {
    return this.atlas.overflowedChars;
  }
}
