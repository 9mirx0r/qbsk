// Where an error is, in the editor's own terms (docs/studio.md §18).
//
// A failed run used to leave one line in the MCP activity strip at the bottom of the
// window — the pane furthest from the code, in the smallest type, below the canvas. The
// message was right and nobody read it, and the line number in it had to be counted out
// by hand in a textarea with no gutter.
//
// Everything here is DATA IN, DATA OUT, and there is not a DOM node in the file. That is
// the same reason `fatal.ts` is built that way: an error path that cannot be tested
// without a browser is an error path that gets tested when it next fails in front of
// someone.

/** Where an error happened, in the numbers an editor can use. */
export interface ErrorMark {
  /** 1-based, as the language reports them. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** 0-based character offsets into the source, for placing the caret. */
  offset: number;
  endOffset: number;
  /** The first line of the error, without the fragment or the trace. */
  message: string;
}

/** How many rows the gutter needs. */
export function lineCount(source: string): number {
  // A trailing newline does not open a row: an editor holding "a\n" shows ONE line, and
  // `split` would claim two. Counting separators and adding one gets that right, and
  // gets the empty document right as well (one row, not zero).
  let n = 1;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") {
      n += 1;
    }
  }
  return source.endsWith("\n") ? n - 1 : n;
}

/**
 * The span of lines the mark covers, or null when there is nothing marked.
 *
 * Split out from `gutterRows` because the gutter is maintained INCREMENTALLY: rebuilding
 * every row on every keystroke cost 32 ms on a 3,000-line file, which is two dropped
 * frames per character typed. The row numbers only change when the line COUNT changes,
 * and the marked range only changes when a run fails, so the two are tracked apart.
 */
export function markedRange(mark: ErrorMark | null): { from: number; to: number } | null {
  if (mark === null) {
    return null;
  }
  // An end BEFORE the start would mark nothing and leave the old mark on screen; a span
  // that arrives inverted is still a span.
  return { from: Math.min(mark.line, mark.endLine), to: Math.max(mark.line, mark.endLine) };
}

/** Are these the same marked range? */
export function sameRange(
  a: { from: number; to: number } | null,
  b: { from: number; to: number } | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.from === b.from && a.to === b.to;
}

/**
 * The rows of the gutter: the number to show, and whether the error is on it.
 *
 * The whole span is marked, not just its first line, because a multi-line span means the
 * construct that failed spans those lines and pointing at one end of it is a half answer.
 */
export function gutterRows(
  source: string,
  mark: ErrorMark | null,
): { line: number; bad: boolean }[] {
  const rows: { line: number; bad: boolean }[] = [];
  const total = lineCount(source);
  for (let line = 1; line <= total; line += 1) {
    rows.push({
      line,
      bad: mark !== null && line >= mark.line && line <= mark.endLine,
    });
  }
  return rows;
}

/**
 * The caret range to select when the author clicks the error.
 *
 * CLAMPED to the text actually in the editor. The offsets come from a run, and the
 * author can type between the run and the click — an unclamped range would throw a
 * DOM exception on a document that got shorter, which is the fatal overlay appearing
 * because someone deleted a line.
 */
export function selectionFor(
  source: string,
  mark: ErrorMark,
): { start: number; end: number } {
  const max = source.length;
  const start = Math.max(0, Math.min(mark.offset, max));
  // An empty span still selects nothing and places the caret, which is what a zero-width
  // error (an unexpected end of file) should do.
  const end = Math.max(start, Math.min(mark.endOffset, max));
  return { start, end };
}

/** The one-line summary shown in the strip above the editor. */
export function stripText(mark: ErrorMark): string {
  return `line ${mark.line}, col ${mark.col} — ${mark.message}`;
}

/**
 * The first line of a rendered error, without the fragment or the call trace.
 *
 * The strip has one line of room. `formatQbskError` returns the header, the source
 * fragment with its caret, and since §15.20 the call trace as well — five to ten lines,
 * of which the strip wants the first.
 */
export function headline(rendered: string): string {
  const first = rendered.split("\n")[0] ?? "";
  // The header starts `file:line:col — kind: message`. The location is already shown in
  // the strip's own words, so repeating it costs the room the message needs.
  const dash = first.indexOf(" — ");
  return dash === -1 ? first : first.slice(dash + 3);
}
