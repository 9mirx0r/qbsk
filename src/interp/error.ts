import type { Span } from "../lexer/token.js";

export type QbskErrorKind = "syntax" | "semantic" | "runtime";

export class QbskError extends Error {
  /**
   * The source of the file this error's span names, when that is NOT the file the
   * formatter will be handed (§15.24).
   *
   * An error inside a `use`d module names the module in its span, while the caller has
   * only the entry file's text — so the fragment was drawn by taking the module's
   * LINE NUMBER and reading that line out of the ENTRY file. The header was right, the
   * trace was right, and the caret sat under an unrelated line.
   *
   * Carried on the error rather than looked up in a registry: a registry keyed by file
   * name is shared state that goes stale the moment two runs use the same name, which
   * every test in this repository does.
   */
  sourceText?: string;
  constructor(
    message: string,
    public readonly span: Span,
    public readonly kind: QbskErrorKind = "syntax",
  ) {
    super(message);
    this.name = "QbskError";
  }
}

export class QbskSyntaxError extends QbskError {
  constructor(message: string, span: Span) {
    super(message, span, "syntax");
    this.name = "QbskSyntaxError";
  }
}

/** One call on the way to an error: the function, and the line it was called from. */
export interface QbskFrame {
  name: string;
  line: number;
  file: string;
}

export class QbskRuntimeError extends QbskError {
  /**
   * The calls that led here, innermost first (§15.20).
   *
   * Filled by the interpreter at THROW time, because by the time an error reaches a
   * handler the stack has already unwound and the depth counter has been restored.
   * Mutable for that reason and for no other.
   */
  trace: QbskFrame[] = [];

  constructor(message: string, span: Span) {
    super(message, span, "runtime");
    this.name = "QbskRuntimeError";
  }
}

// How much of a deep recursion is worth printing. A thousand identical lines is not a
// trace, it is a wall, and the two ends are what a reader uses.
const TRACE_HEAD = 4;
const TRACE_TAIL = 2;

/**
 * The frames under the fragment, or "" when there are none.
 *
 * Top-level code has no frame and shows the span alone, exactly as it always did.
 */
export function qbskTrace(err: QbskError): string {
  const frames = err instanceof QbskRuntimeError ? err.trace : [];
  if (frames.length === 0) {
    return "";
  }
  const line = (f: QbskFrame, i: number): string =>
    `   ${i === 0 ? "in" : "from"} ${f.name} (${f.file}:${f.line})`;
  if (frames.length <= TRACE_HEAD + TRACE_TAIL + 1) {
    return frames.map(line).join("\n");
  }
  const head = frames.slice(0, TRACE_HEAD).map(line);
  const tail = frames.slice(-TRACE_TAIL).map((f, i) => line(f, i + TRACE_HEAD));
  const dropped = frames.length - TRACE_HEAD - TRACE_TAIL;
  return [...head, `   ... ${dropped} more`, ...tail].join("\n");
}

export function formatQbskError(source: string, err: QbskError): string {
  const { start, file } = err.span;
  const header = `${file}:${start.line}:${start.col} — ${err.kind}: ${err.message}`;
  const fragment = qbskFragment(source, err);
  const trace = qbskTrace(err);
  // The trace is an ADDITION. If it ever replaced the fragment it would be a downgrade:
  // the fragment says where, and the trace says how it got there.
  return [header, fragment, trace].filter((part) => part !== "").join("\n");
}

// The `^^^` fragment under the offending source line — the exact lines formatQbskError
// prints below the header. Reused by the Studio MCP error shape (docs/studio.md §11.5)
// so the structured error and the terminal error show the same fragment.
export function qbskFragment(source: string, err: QbskError): string {
  const { start, end } = err.span;
  // §15.24 — the module's own text when the error came from one.
  const lines = (err.sourceText ?? source).split("\n");
  if (start.line < 1 || start.line > lines.length) {
    return "";
  }
  const lineText = lines[start.line - 1];
  const width = String(start.line).length;
  const gutter = " ".repeat(width);
  const caretCount = Math.max(1, end.col - start.col);
  const caret = " ".repeat(Math.max(0, start.col - 1)) + "^".repeat(caretCount);
  return (
    `${gutter} |\n` +
    `${String(start.line).padStart(width)} | ${lineText}\n` +
    `${gutter} | ${caret}`
  );
}
