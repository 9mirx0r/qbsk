// Engine cell: pure primitives so diffing is as cheap as possible.
// fg/bg: packed 0xRRGGBB, or -1 = terminal default color.
// attrs: bitmask 1=Bold, 2=Underline, 4=Reverse.

export interface Cell {
  char: string;
  fg: number;
  bg: number;
  attrs: number;
}

export const DEFAULT_CELL: Cell = { char: " ", fg: -1, bg: -1, attrs: 0 };

export function cellOf(char: string, fg = -1, bg = -1, attrs = 0): Cell {
  return { char, fg, bg, attrs };
}

// Hottest engine function: primitive comparison, no allocations.
export function eqCell(a: Cell, b: Cell): boolean {
  return (
    a.char === b.char &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.attrs === b.attrs
  );
}
