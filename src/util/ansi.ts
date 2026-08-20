// Centralized ANSI sequences (spec engine.md §2/§6). The engine's only source of
// escapes: render.ts and terminal.ts build their strings from here.

export const ESC = "\x1b";
export const RESET = `${ESC}[0m`;
export const hideCursor = `${ESC}[?25l`;
export const showCursor = `${ESC}[?25h`;
export const altScreen = `${ESC}[?1049h`;
export const exitAltScreen = `${ESC}[?1049l`;
export const clearScreen = `${ESC}[2J`;
export const home = `${ESC}[H`;

// Fila/columna 1-based (ANSI).
export function cursorTo(row: number, col: number): string {
  return `${ESC}[${row};${col}H`;
}

export function sgr(codes: number[]): string {
  return codes.length === 0 ? "" : `${ESC}[${codes.join(";")}m`;
}
