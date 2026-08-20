// What the live program is holding, as rows (docs/studio.md §19).
//
// The Inspector pane existed from the first version of the Studio and its contents were
// the sentence "Populated in Phase 12 (qbsk_inspect)." — shipped, visible, and a promise
// rather than a feature. The machinery it needed was already there: `varNames()` and
// `inspect()` on the frame host, which the engine console has used for `vars` and `get`
// all along. Nothing called them from the window.
//
// Data in, data out, no DOM: same reason as `marks.ts`.

/** One name the live program is holding. */
export interface InspectRow {
  name: string;
  /** The QBSK type name — `int`, `list`, `func`, … */
  type: string;
  /** The value as QBSK prints it, already clipped. */
  text: string;
}

/**
 * How much of a value the pane shows.
 *
 * A list of ten thousand cells is a legitimate QBSK value and `qbskStr` renders all of
 * it. Unclipped, one such name makes the pane unusable and the IPC message enormous —
 * for a value nobody can read at that length anyway.
 */
export const MAX_TEXT = 160;

export function clip(text: string, max: number = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * How many rows the pane will show.
 *
 * A cap, not a preference. Measured in the real window, a program holding 1,201 top-level
 * names cost 12.7 ms per refresh and an 85 KB IPC message four times a second, which drops
 * a frame of a running scene every quarter second. Nobody reads 1,201 rows, so the pane
 * shows the first 200 and SAYS how many it left — a bounded cost whatever the program.
 */
export const MAX_ROWS = 200;

/**
 * Values first, functions last.
 *
 * A program of any size declares more functions than variables, and the functions do not
 * change while it runs. Sorted together they push the handful of numbers that DO change
 * off the bottom of the pane, which is the one thing the pane is for.
 *
 * Both groups keep the alphabetical order they arrive in, so a name does not move
 * between refreshes — a row that jumps while you are reading it is worse than a row
 * further down.
 */
export function orderRows(rows: readonly InspectRow[]): InspectRow[] {
  const values = rows.filter((r) => r.type !== "func" && r.type !== "native");
  const funcs = rows.filter((r) => r.type === "func" || r.type === "native");
  return [...values, ...funcs];
}

/**
 * What the pane says when it has nothing to show.
 *
 * Two different nothings, and they are not the same message: no program running is the
 * author's next action, while a running program with no names is a fact about the
 * program. Saying "no variables" to someone who has not pressed Run yet sends them
 * looking for a bug in their code.
 */
export function emptyText(live: boolean): string {
  return live
    ? "the program is running and holds no names"
    : "no program is running — press Run";
}

/** The sentence for the rows the cap left out, or "" when it left none out. */
export function moreText(shown: number, total: number): string {
  const hidden = total - shown;
  return hidden <= 0 ? "" : `… and ${hidden} more`;
}
