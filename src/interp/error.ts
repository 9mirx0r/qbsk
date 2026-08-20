import type { Span } from "../lexer/token.js";

export type QbskErrorKind = "syntax" | "semantic" | "runtime";

export class QbskError extends Error {
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

export class QbskRuntimeError extends QbskError {
  constructor(message: string, span: Span) {
    super(message, span, "runtime");
    this.name = "QbskRuntimeError";
  }
}

export function formatQbskError(source: string, err: QbskError): string {
  const { start, file } = err.span;
  const header = `${file}:${start.line}:${start.col} — ${err.kind}: ${err.message}`;
  const fragment = qbskFragment(source, err);
  return fragment === "" ? header : `${header}\n${fragment}`;
}

// The `^^^` fragment under the offending source line — the exact lines formatQbskError
// prints below the header. Reused by the Studio MCP error shape (docs/studio.md §11.5)
// so the structured error and the terminal error show the same fragment.
export function qbskFragment(source: string, err: QbskError): string {
  const { start, end } = err.span;
  const lines = source.split("\n");
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
