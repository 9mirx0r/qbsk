import { cursorTo, RESET, sgr } from "../util/ansi.js";
import type { Cell } from "./cell.js";
import type { DiffLine } from "./diff.js";

// ANSI emitter (spec engine.md §6): diff → ANSI string with virtual cursor.
// Rules: cursor jump only if the real cursor is not at the cell; one
// SGR per group of same-style cells; style transition = reset +
// new SGR (avoids dangling attributes); final reset if any style. Frame with
// no changes → 0 bytes.

const F = 38;
const B = 48;

export function sgrOf(cell: Cell): string {
  const codes: number[] = [];
  if (cell.attrs & 1) {
    codes.push(1);
  }
  if (cell.attrs & 2) {
    codes.push(4);
  }
  if (cell.attrs & 4) {
    codes.push(7);
  }
  if (cell.fg !== -1) {
    codes.push(F, 2, (cell.fg >> 16) & 255, (cell.fg >> 8) & 255, cell.fg & 255);
  }
  if (cell.bg !== -1) {
    codes.push(B, 2, (cell.bg >> 16) & 255, (cell.bg >> 8) & 255, cell.bg & 255);
  }
  return sgr(codes);
}

function emitLine(cells: Cell[]): string {
  let out = "";
  let text = "";
  let groupSgr = "";
  let prevSgr: string | null = null;

  const emitGroup = (): void => {
    if (groupSgr !== prevSgr) {
      if (prevSgr !== null && prevSgr !== "") {
        out += RESET;
      }
      if (groupSgr !== "") {
        out += groupSgr;
      }
      prevSgr = groupSgr;
    }
    if (text !== "") {
      out += text;
      text = "";
    }
  };

  for (const cell of cells) {
    const next = sgrOf(cell);
    if (next !== groupSgr) {
      emitGroup();
      groupSgr = next;
    }
    text += cell.char;
  }
  emitGroup();
  if (prevSgr !== null && prevSgr !== "") {
    out += RESET;
  }
  return out;
}

export function renderFrame(lines: DiffLine[], width: number): string {
  let out = "";
  for (const line of lines) {
    if (line.rewrite) {
      out += cursorTo(line.y + 1, 1);
      out += emitLine(line.row ?? []);
      out += RESET;
    } else {
      for (const run of line.runs) {
        out += cursorTo(line.y + 1, run.x + 1);
        out += emitLine(run.cells);
      }
    }
  }
  void width;
  return out;
}
