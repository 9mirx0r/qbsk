// `.qbdata` — a data file that cannot run (docs/language.md §12).
//
// A QBSK module already served data; this format exists for two properties a module
// cannot have, and NOT because the language needed a syntax for dicts.
//
//   1. A shape catches a typo at its own line, instead of three turns later in whatever
//      read the key that was misspelled.
//   2. IT CANNOT EXECUTE. A `.qbsk` module runs its top level when loaded, so `use` on
//      one runs whatever is in the file. Unremarkable for files a person wrote;
//      unacceptable for anything generated or downloaded.
//
// The second property is the load-bearing one, and it is why the restrictions here are
// not negotiable conveniences. This loader reuses the lexer and the expression parser —
// the same numbers, strings and escapes as the language — and then REJECTS everything
// that is not a literal. Reusing the parser and narrowing is safer than writing a second
// one that would drift: there is one definition of what a string literal is.

import { QbskSyntaxError } from "../interp/error.js";
import { parse } from "./parser.js";
import type { Expr } from "./ast.js";
import type { Span } from "../lexer/token.js";
import type { QValue } from "../interp/value.js";

export interface QbdataResult {
  entries: Map<string, QValue>;
  errors: QbskSyntaxError[];
  /**
   * Line of each successfully-loaded entry, by name. Lets a consumer (e.g. the tileset
   * loader) point an error at the entry that caused it rather than at the file as a
   * whole. Additive — consumers that only read `entries`/`errors` are unaffected.
   */
  entryLines: Map<string, number>;
}

const TYPE_NAMES = ["str", "int", "float", "bool", "list", "dict"] as const;
type ShapeType = (typeof TYPE_NAMES)[number];

interface Shape {
  fields: Map<string, ShapeType>;
}

/**
 * Reads a `.qbdata` file.
 *
 * Errors are RETURNED, never thrown — the same contract `parse` has, and for the same
 * reason: every caller reads the list, and a throw from here would escape into whatever
 * was loading the file.
 */
export function loadQbdata(source: string, file: string): QbdataResult {
  const entries = new Map<string, QValue>();
  const errors: QbskSyntaxError[] = [];
  const entryLines = new Map<string, number>();
  const lines = source.split(/\r?\n/);
  let shape: Shape | null = null;

  const fail = (message: string, line: number, col = 1): void => {
    const at = { line, col, offset: 0 };
    errors.push(new QbskSyntaxError(message, { file, start: at, end: at }));
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const text = raw.trim();
    const lineNo = i + 1;
    if (text === "" || text.startsWith("//")) {
      continue;
    }
    // An indented line belongs to the shape above it and was consumed there. Reaching
    // one here means it is indented under nothing.
    if (/^\s/.test(raw) && !text.startsWith("//")) {
      fail("this line is indented under nothing", lineNo);
      continue;
    }

    if (text.startsWith("shape ") || text === "shape") {
      const parsed = readShape(lines, i, file, fail);
      shape = parsed.shape;
      i = parsed.nextIndex - 1;
      continue;
    }

    const eq = text.indexOf("=");
    if (eq <= 0) {
      // Name the construct that was written rather than only the shape that was
      // expected. "this holds entries of the form NAME = ..." leaves someone who wrote
      // `use "x"` guessing whether the problem is the quotes; "cannot use" does not.
      fail(rejection(text), lineNo);
      continue;
    }
    const name = text.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(`'${name}' is not a valid entry name`, lineNo);
      continue;
    }
    if (entries.has(name)) {
      // Reported rather than overwritten: a duplicate is a mistake in a data file, and
      // silently keeping the last one hides which line lost.
      fail(`'${name}' is already defined in this file`, lineNo);
      continue;
    }
    // A LITERAL CONTINUES WHILE ITS BRACKETS ARE OPEN.
    //
    // An entry used to be one line, so a table of records was one line: 73
    // anatomical regions came out as nine thousand characters with nowhere to break, and
    // every table after it would have been another. A format whose stated purpose is
    // human-authored tables could not lay a table out.
    //
    // `scanLiteral` counts depth the only way that is correct: past strings. A bracket
    // inside one closes nothing, and a counter that did not know would end the entry in
    // the middle of `{"id": "a]b"}`.
    let valueText = text.slice(eq + 1).trim();
    let scan = scanLiteral(valueText, 0);
    if (scan.comment >= 0) {
      valueText = valueText.slice(0, scan.comment).trim();
    }
    let depth = scan.depth;
    const openedAt = lineNo;
    while (depth > 0 && i + 1 < lines.length) {
      i += 1;
      scan = scanLiteral(lines[i]!, depth);
      const body = (scan.comment >= 0 ? lines[i]!.slice(0, scan.comment) : lines[i]!).trim();
      // A comment-only or blank line inside a table is a person organising it.
      if (body !== "") {
        valueText += ` ${body}`;
      }
      depth = scan.depth;
    }
    if (depth > 0) {
      // At the line that OPENED it, not at end of file: the mistake is this entry, and
      // this entry has a name and a line (§8).
      fail(`'${name}' opens a literal that is never closed`, openedAt);
      continue;
    }
    const value = literalOf(valueText, file, openedAt, fail);
    if (value === null) {
      continue;
    }
    if (shape !== null) {
      checkShape(name, value, shape, lineNo, fail);
    }
    entries.set(name, value);
    entryLines.set(name, lineNo);
  }

  return { entries, errors, entryLines };
}

/**
 * How deep the brackets are after this text, and where a line comment starts.
 *
 * STRINGS ARE SKIPPED, which is the whole reason this is a scanner and not a counter:
 * `{"id": "a]b"}` closes nothing, and `// ` inside a string is not a comment. A string is
 * assumed to close on its own line — one that does not leaves `literalOf` to report it,
 * which it does better than this could.
 */
function scanLiteral(text: string, depth: number): { depth: number; comment: number } {
  let open = depth;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "/" && text[i + 1] === "/") {
      return { depth: open, comment: i };
    } else if (c === "[" || c === "{") {
      open += 1;
    } else if (c === "]" || c === "}") {
      open -= 1;
    }
  }
  return { depth: open, comment: -1 };
}

/**
 * The message for a line that is not an entry.
 *
 * Every one of these is a door this format exists to keep shut, so each is named
 * outright: someone who wrote `func` should be told that `.qbdata` cannot hold a
 * function, not that it expected `NAME = <literal>`.
 */
function rejection(text: string): string {
  const word = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text)?.[1] ?? "";
  const cannot: Record<string, string> = {
    use: "load anything — that is what makes it safe to load",
    func: "hold a function",
    var: "hold a variable — an entry is written `NAME = <literal>`",
    const: "hold a declaration — an entry is written `NAME = <literal>`",
    if: "branch",
    while: "loop",
    for: "loop",
    scene: "declare a scene",
    layer: "declare a layer",
    on: "declare an event handler",
    print: "call functions",
    return: "return",
  };
  const why = cannot[word];
  if (why !== undefined) {
    return `'.qbdata' cannot ${why}; it holds literal entries and nothing that runs`;
  }
  return "'.qbdata' holds entries of the form `NAME = <literal>` and shape declarations — nothing else";
}

function readShape(
  lines: string[],
  start: number,
  file: string,
  fail: (message: string, line: number) => void,
): { shape: Shape | null; nextIndex: number } {
  const header = lines[start]!.trim();
  const name = header.slice("shape".length).trim();
  if (name === "") {
    fail("a shape needs a name, e.g. `shape creature`", start + 1);
  }
  const fields = new Map<string, ShapeType>();
  let i = start + 1;
  for (; i < lines.length; i += 1) {
    const raw = lines[i]!;
    if (raw.trim() === "" || raw.trim().startsWith("//")) {
      // A blank line does not end a shape; a line at column 0 does.
      if (raw.trim() === "" && i + 1 < lines.length && !/^\s/.test(lines[i + 1]!)) {
        i += 1;
        break;
      }
      continue;
    }
    if (!/^\s/.test(raw)) {
      break;
    }
    const text = raw.trim();
    const colon = text.indexOf(":");
    if (colon <= 0) {
      fail(`a shape field looks like 'hp: int', got '${text}'`, i + 1);
      continue;
    }
    const field = text.slice(0, colon).trim();
    const type = text.slice(colon + 1).trim();
    if (!(TYPE_NAMES as readonly string[]).includes(type)) {
      fail(
        `'${type}' is not a type — use ${TYPE_NAMES.join(", ")}`,
        i + 1,
      );
      continue;
    }
    fields.set(field, type as ShapeType);
  }
  return { shape: fields.size > 0 ? { fields } : null, nextIndex: i };
}

/**
 * Parses one literal, rejecting anything that could run.
 *
 * The text is handed to the ordinary expression parser and the RESULT is then walked:
 * an expression tree containing a call, an operator or an identifier is refused. Doing
 * it this way rather than with a second hand-written parser means `.qbdata` and QBSK
 * agree, by construction, about what a number or an escape is.
 */
function literalOf(
  text: string,
  file: string,
  line: number,
  fail: (message: string, line: number) => void,
): QValue | null {
  // Wrapped in a declaration so a bare dict literal cannot be read as a block. The
  // ordinary parser does the work, so .qbdata and QBSK agree by construction about what
  // a number, a string or an escape is.
  const parsed = parse(`var __qbdata = ${text}`, file);
  if (parsed.errors.length > 0) {
    fail(parsed.errors[0]!.message, line);
    return null;
  }
  const stmt = parsed.ast.body[0];
  if (stmt === undefined || stmt.kind !== "VarDecl" || stmt.init === null) {
    fail("expected a literal value", line);
    return null;
  }
  return literalValue(stmt.init, line, fail);
}

function literalValue(
  expr: Expr,
  line: number,
  fail: (message: string, line: number) => void,
): QValue | null {
  switch (expr.kind) {
    case "Lit": {
      const v = expr.value;
      if (typeof v === "string") return { type: "str", value: v };
      if (typeof v === "boolean") return { type: "bool", value: v };
      if (v === null) return { type: "null" };
      return expr.litKind === "float"
        ? { type: "float", value: v }
        : { type: "int", value: v };
    }
    case "ListLit": {
      const items: QValue[] = [];
      for (const item of expr.items) {
        const value = literalValue(item, line, fail);
        if (value === null) return null;
        items.push(value);
      }
      return { type: "list", items };
    }
    case "DictLit": {
      const map = new Map<string, QValue>();
      for (const entry of expr.entries) {
        const value = literalValue(entry.value, line, fail);
        if (value === null) return null;
        map.set(entry.key, value);
      }
      return { type: "dict", map };
    }
    case "Tuple": {
      // Admitted for saves (docs/language.md §12.2): `(3, 4)` cannot run any more
      // than `[3, 4]` can. A tuple containing a call or a name falls through the
      // recursion and is rejected like any other expression.
      const x = literalValue(expr.x, line, fail);
      if (x === null) return null;
      const y = literalValue(expr.y, line, fail);
      if (y === null) return null;
      return { type: "tuple", x, y };
    }
    case "Unary":
      // Only a negative number, so `-5` works without opening the door to operators.
      if (expr.op === "-") {
        const inner = literalValue(expr.operand, line, fail);
        if (inner !== null && (inner.type === "int" || inner.type === "float")) {
          return { ...inner, value: -inner.value };
        }
      }
      fail("'.qbdata' holds literals only — this is an expression", line);
      return null;
    case "BinOp":
      fail("'.qbdata' holds literals only — this is an expression", line);
      return null;
    case "Call":
      fail("'.qbdata' cannot call functions", line);
      return null;
    case "Ident":
      fail(
        `'.qbdata' cannot reference other entries — '${expr.name}' is a name, not a literal`,
        line,
      );
      return null;
    case "InterpolatedStr":
      fail("'.qbdata' cannot interpolate — write the finished text", line);
      return null;
    default:
      fail("'.qbdata' holds literals only", line);
      return null;
  }
}

function checkShape(
  name: string,
  value: QValue,
  shape: Shape,
  line: number,
  fail: (message: string, line: number) => void,
): void {
  // A LIST OF DICTS IS A TABLE OF ENTRIES, and the shape is exactly its contract.
  //
  // This arm did not exist, and the reason it did not is a sentence that is right about
  // one thing and wrong about another: "a file may hold a bare number or a list beside
  // its creatures, and refusing those would make the shape a straitjacket". A bare
  // number, yes. A list of dicts is not a value BESIDE the entries — it is the entries.
  //
  // Found writing a table of 73 anatomical regions. A table is the most
  // natural thing this format holds, and a list is the natural way to write one, because
  // a module's exports cannot be enumerated from QBSK — so 73 top-level names would be
  // unreachable as a set. The format's own promise, that a misspelled key reports at load
  // "rather than three turns later in whatever went looking for the key", did not hold in
  // the shape a table is written in.
  //
  // Recursive, so a list of lists is reached too, and indexed, so a seventy-three-row
  // table says which row (§8).
  if (value.type === "list") {
    for (let i = 0; i < value.items.length; i += 1) {
      checkShape(`${name}[${i}]`, value.items[i]!, shape, line, fail);
    }
    return;
  }
  // Bare values stay exempt, which is what the original reasoning was right about.
  if (value.type !== "dict") {
    return;
  }
  for (const [field, type] of shape.fields) {
    const found = value.map.get(field);
    if (found === undefined) {
      const near = nearest(field, [...value.map.keys()]);
      fail(
        `'${name}' is missing '${field}'` +
          (near !== null ? `; did you mean '${field}' instead of '${near}'?` : ""),
        line,
      );
      continue;
    }
    if (!matches(found, type)) {
      fail(
        `'${name}.${field}' should be ${type}, got ${found.type}`,
        line,
      );
    }
  }
  for (const key of value.map.keys()) {
    if (!shape.fields.has(key)) {
      const near = nearest(key, [...shape.fields.keys()]);
      fail(
        `'${name}' has '${key}', which the shape does not declare` +
          (near !== null ? ` — did you mean '${near}'?` : ""),
        line,
      );
    }
  }
}

function matches(value: QValue, type: ShapeType): boolean {
  switch (type) {
    case "str":
      return value.type === "str";
    case "int":
      return value.type === "int";
    // An int where a float is wanted is fine: 1 and 1.0 are the same number to a
    // person writing a data file, and refusing it would be pedantry with a span.
    case "float":
      return value.type === "float" || value.type === "int";
    case "bool":
      return value.type === "bool";
    case "list":
      return value.type === "list";
    case "dict":
      return value.type === "dict";
  }
}

function nearest(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const d = distance(name, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  return best !== null && bestDist <= 2 ? best : null;
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/** Span helper for callers that need to point at the file as a whole. */
export function qbdataSpan(file: string): Span {
  const at = { line: 1, col: 1, offset: 0 };
  return { file, start: at, end: at };
}
