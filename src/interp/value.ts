import type { Span } from "../lexer/token.js";
import { QbskRuntimeError } from "./error.js";
import type { Block, Param } from "../parser/ast.js";
import type { Env } from "./env.js";
import type { Canvas } from "../engine/canvas.js";
import type { TonePlanEntry } from "../audio/tone.js";
import type { ShadeSpec } from "../engine/shade.js";

/**
 * Cells a bulk `put` resolved at evaluation time: a masked map (docs/engine.md §11.12)
 * or a blitted canvas (§11.13). Resolved in the interpreter rather than at mount because
 * that is where the spans live, and §15's I3 says a shape error must reach the author
 * with one. Per-cell `fg`/`bg`/`attrs` are set only by sources that carry their own
 * colour; a mask does not, and takes the layer's style like any other primitive.
 */
/**
 * What evaluating a layer REGISTERED, as opposed to what it produced.
 *
 * A layer's `primitives` are its output: cells the compositor paints. These are the
 * other half — a `tone` writes no cells and contributes to the frame's audio plan
 * (docs/audio.md §4), a `shade` contributes to the shade plan. Both used to be pushed
 * straight onto the interpreter as the layer evaluated, which made them invisible to
 * anything that REUSED a layer instead of rebuilding it: the value came back from the
 * cache and the effects simply did not happen (docs/engine.md §11.20).
 *
 * Recording them on the layer makes reuse total. The argument that licenses replaying
 * the primitives is the same one that licenses replaying these: if nothing the layer
 * reads has moved, neither has anything it computed, effects included.
 */
export interface LayerEffects {
  shades: ShadeSpec[];
  tones: TonePlanEntry[];
}

export interface MaskedCells {
  kind: "maskedCells";
  cells: {
    x: number;
    y: number;
    ch: string;
    fg?: number;
    bg?: number;
    attrs?: number;
  }[];
}

export type QValue =
  | { type: "null" }
  | { type: "bool"; value: boolean }
  | { type: "int"; value: number }
  | { type: "float"; value: number }
  | { type: "str"; value: string }
  | { type: "list"; items: QValue[] }
  | { type: "dict"; map: Map<string, QValue> }
  | { type: "tuple"; x: QValue; y: QValue }
  | { type: "func"; name: string; params: Param[]; body: Block; closure: Env }
  | { type: "native"; name: string; fn: NativeFn }
  // Inert DSL (an earlier release): side-effect-free evaluation (spec §7.1)
  | { type: "scene"; name: string; params: Map<string, QValue>; layers: QValue[] }
  | {
      type: "layer";
      name: string;
      z: QValue;
      at: QValue | null;
      primitives: QValue[];
      cacheKey?: number;
      effects: LayerEffects;
    }
  | { type: "event"; event: string; keyName: string | null; params: Param[] }
  // Embedded canvas block: evaluates to an immutable sprite (spec §7)
  | { type: "sprite"; name: string; at: QValue; art: string; style?: DslStyle; z?: QValue; visible?: QValue; world?: QValue }
  | {
      type: "primitive";
      kind: string;
      props: Record<string, QValue | string | DslStyle | null>;
      /** Only the `maskedPut` kind carries this (§11.12); every other kind omits it. */
      masked?: MaskedCells;
    }
  // Engine canvas (natives canvas/put/box/fill/line, an earlier release)
  | { type: "canvas"; canvas: Canvas }
  // Seeded generator (L4, docs/language.md §6.5): opaque and mutable by design —
  // like a list, it advances when rolled. Never serializable (save the SEED).
  | { type: "rng"; next: () => number }
  // Immutable module namespace with explicit exports (L5, spec §9)
  | { type: "module"; name: string; exports: Map<string, QValue> };

// Style state inherited by a layer's primitives (spec §7.5).
export interface DslStyle {
  fg: string | null;
  bg: string | null;
}

export type NativeFn = (args: QValue[], span: Span) => QValue;

export function typeName(v: QValue): string {
  return v.type;
}

export function isNumber(v: QValue): v is { type: "int" | "float"; value: number } {
  return v.type === "int" || v.type === "float";
}

export function truthy(v: QValue): boolean {
  switch (v.type) {
    case "null":
      return false;
    case "bool":
      return v.value;
    case "int":
    case "float":
      return v.value !== 0;
    case "str":
      return v.value.length > 0;
    case "list":
      return v.items.length > 0;
    case "dict":
      return v.map.size > 0;
    default:
      return true;
  }
}

export function qbskStr(v: QValue): string {
  switch (v.type) {
    case "null":
      return "null";
    case "bool":
      return v.value ? "true" : "false";
    case "int":
      return String(v.value);
    case "float":
      return Number.isInteger(v.value) ? `${v.value}.0` : String(v.value);
    case "str":
      return v.value;
    case "list":
      return `[${v.items.map(qbskStr).join(", ")}]`;
    case "dict":
      return `{${[...v.map.entries()]
        .map(([k, val]) => `${JSON.stringify(k)}: ${qbskStr(val)}`)
        .join(", ")}}`;
    case "tuple":
      return `(${qbskStr(v.x)}, ${qbskStr(v.y)})`;
    case "func":
      return `<func ${v.name}>`;
    case "native":
      return `<native ${v.name}>`;
    case "scene":
      return `<scene ${v.name}>`;
    case "layer":
      return `<layer ${v.name}>`;
    case "event":
      return `<event ${v.event}>`;
    case "sprite":
      return `<sprite ${v.name}>`;
    case "canvas":
      return v.canvas.renderText();
    case "rng":
      return "<rng>";
    case "primitive":
      return `<primitive ${v.kind}>`;
    case "module":
      return `<module ${v.name}>`;
  }
}

export function qbskEq(a: QValue, b: QValue): boolean {
  if (isNumber(a) && isNumber(b)) {
    return a.value === b.value;
  }
  if (a.type !== b.type) {
    return false;
  }
  switch (a.type) {
    case "null":
      return true;
    case "bool":
      return a.value === (b as { type: "bool"; value: boolean }).value;
    case "int":
    case "float":
      return a.value === (b as { type: "int"; value: number } | { type: "float"; value: number }).value;
    case "str":
      return a.value === (b as { type: "str"; value: string }).value;
    case "tuple":
      return qbskEq(a.x, (b as { type: "tuple"; x: QValue; y: QValue }).x) &&
        qbskEq(a.y, (b as { type: "tuple"; x: QValue; y: QValue }).y);
    case "list": {
      const other = b as { type: "list"; items: QValue[] };
      if (a.items.length !== other.items.length) {
        return false;
      }
      return a.items.every((item, i) => qbskEq(item, other.items[i]!));
    }
    case "dict": {
      const other = b as { type: "dict"; map: Map<string, QValue> };
      if (a.map.size !== other.map.size) {
        return false;
      }
      return [...a.map.entries()].every(
        ([k, val]) => other.map.has(k) && qbskEq(val, other.map.get(k)!),
      );
    }
    case "func":
    case "native":
    case "scene":
    case "layer":
    case "event":
    case "sprite":
    case "canvas":
    case "rng":
    case "primitive":
    case "module":
      return a === b;
  }
}

export function qbskCmp(
  op: "<" | ">" | "<=" | ">=",
  a: QValue,
  b: QValue,
  span: Span,
): boolean {
  if (isNumber(a) && isNumber(b)) {
    const x = a.value;
    const y = b.value;
    switch (op) {
      case "<":
        return x < y;
      case ">":
        return x > y;
      case "<=":
        return x <= y;
      case ">=":
        return x >= y;
    }
  }
  if (a.type === "str" && b.type === "str") {
    const x = a.value;
    const y = b.value;
    switch (op) {
      case "<":
        return x < y;
      case ">":
        return x > y;
      case "<=":
        return x <= y;
      case ">=":
        return x >= y;
    }
  }
  throw new QbskRuntimeError(
    `cannot compare '${typeName(a)}' with '${typeName(b)}' with '${op}'`,
    span,
  );
}

export function qbskAdd(a: QValue, b: QValue, span: Span): QValue {
  if (a.type === "int" && b.type === "int") {
    return { type: "int", value: a.value + b.value };
  }
  if (isNumber(a) && isNumber(b)) {
    return { type: "float", value: a.value + b.value };
  }
  if (a.type === "str" && b.type === "str") {
    return { type: "str", value: a.value + b.value };
  }
  if (a.type === "tuple" && b.type === "tuple") {
    return {
      type: "tuple",
      x: qbskAdd(a.x, b.x, span),
      y: qbskAdd(a.y, b.y, span),
    };
  }
  if (a.type === "str" || b.type === "str") {
    throw new QbskRuntimeError(
      `cannot add '${typeName(a)}' and '${typeName(b)}' — use str(x) or int(x) to convert explicitly`,
      span,
    );
  }
  throw new QbskRuntimeError(
    `cannot add '${typeName(a)}' and '${typeName(b)}'`,
    span,
  );
}

export function qbskSub(a: QValue, b: QValue, span: Span): QValue {
  if (a.type === "int" && b.type === "int") {
    return { type: "int", value: a.value - b.value };
  }
  if (isNumber(a) && isNumber(b)) {
    return { type: "float", value: a.value - b.value };
  }
  if (a.type === "tuple" && b.type === "tuple") {
    return {
      type: "tuple",
      x: qbskSub(a.x, b.x, span),
      y: qbskSub(a.y, b.y, span),
    };
  }
  throw new QbskRuntimeError(
    `cannot subtract '${typeName(a)}' and '${typeName(b)}'`,
    span,
  );
}

/**
 * String repetition with a QBSK-shaped failure (§15.4).
 *
 * `"a" * 999999999` used to surface V8's bare `RangeError: Invalid string length` with
 * no span and no fragment. The limit is the host's, but the message is ours: the author
 * gets told what they asked for and what the ceiling is, at the expression that asked.
 */
const MAX_STR_LENGTH = 0x1fffffe8; // V8's ceiling, named instead of discovered by crashing.

function repeatStr(s: string, times: number, span: Span): string {
  if (s.length * times > MAX_STR_LENGTH) {
    throw new QbskRuntimeError(
      `this repetition would build a string of ${s.length * times} characters, over the limit of ${MAX_STR_LENGTH}`,
      span,
    );
  }
  return s.repeat(times);
}

/**
 * List repetition, with the same ceiling as a string's (§6.7, §15.4).
 *
 * A list has no V8 length limit to inherit, so the bound is ours: without one,
 * `[1] * 999999999` walks off into an allocation failure with no span, which is the
 * host-error-reaching-the-author shape RULE #4 forbids. Same limit as strings so the
 * two operators fail at the same size and the message reads the same.
 */
function repeatList(items: QValue[], times: number, span: Span): QValue[] {
  if (items.length * times > MAX_STR_LENGTH) {
    throw new QbskRuntimeError(
      `this repetition would build a list of ${items.length * times} elements, over the limit of ${MAX_STR_LENGTH}`,
      span,
    );
  }
  const out: QValue[] = [];
  for (let i = 0; i < times; i += 1) {
    out.push(...items);
  }
  return out;
}

export function qbskMul(a: QValue, b: QValue, span: Span): QValue {
  if (a.type === "int" && b.type === "int") {
    return { type: "int", value: a.value * b.value };
  }
  if (isNumber(a) && isNumber(b)) {
    return { type: "float", value: a.value * b.value };
  }
  // §6.7 — repetition, in one place for every sequence. The operand order does not
  // matter and neither does the sequence kind: `"ab" * 3`, `3 * "ab"`, `[1,2] * 3` and
  // `3 * [1,2]` are the same operation. Written as one rule because it was previously
  // two hand-written str branches, and the list case the spec already promised was
  // simply missing from both.
  const seq = a.type === "str" || a.type === "list" ? a : b;
  const count = a.type === "str" || a.type === "list" ? b : a;
  if ((seq.type === "str" || seq.type === "list") && isNumber(count)) {
    if (count.type !== "int") {
      throw new QbskRuntimeError(
        `the repetition must be an int, got '${typeName(count)}'`,
        span,
      );
    }
    if (count.value < 0) {
      throw new QbskRuntimeError("the repetition must be an int >= 0", span);
    }
    if (seq.type === "str") {
      return { type: "str", value: repeatStr(seq.value, count.value, span) };
    }
    return { type: "list", items: repeatList(seq.items, count.value, span) };
  }
  if (a.type === "tuple" && isNumber(b)) {
    return {
      type: "tuple",
      x: qbskMul(a.x, b, span),
      y: qbskMul(a.y, b, span),
    };
  }
  if (isNumber(a) && b.type === "tuple") {
    return {
      type: "tuple",
      x: qbskMul(a, b.x, span),
      y: qbskMul(a, b.y, span),
    };
  }
  throw new QbskRuntimeError(
    `cannot multiply '${typeName(a)}' by '${typeName(b)}'`,
    span,
  );
}

export function qbskDiv(a: QValue, b: QValue, span: Span): QValue {
  if (isNumber(a) && isNumber(b)) {
    if (b.value === 0) {
      throw new QbskRuntimeError("division by zero", span);
    }
    return { type: "float", value: a.value / b.value };
  }
  throw new QbskRuntimeError(
    `cannot divide '${typeName(a)}' by '${typeName(b)}'`,
    span,
  );
}

export function qbskMod(a: QValue, b: QValue, span: Span): QValue {
  if (isNumber(a) && isNumber(b)) {
    if (b.value === 0) {
      // §15.8 — the operator in a message is the one the author wrote.
      throw new QbskRuntimeError("modulo by zero", span);
    }
    if (a.type === "int" && b.type === "int") {
      return { type: "int", value: a.value % b.value };
    }
    return { type: "float", value: a.value % b.value };
  }
  throw new QbskRuntimeError(
    `cannot apply '%' to '${typeName(a)}' and '${typeName(b)}'`,
    span,
  );
}

export function qbskNeg(v: QValue, span: Span): QValue {
  if (v.type === "int") {
    return { type: "int", value: -v.value };
  }
  if (v.type === "float") {
    return { type: "float", value: -v.value };
  }
  throw new QbskRuntimeError(
    `cannot apply '-' to a value of type '${typeName(v)}'`,
    span,
  );
}

/**
 * Bitwise (L4, docs/language.md §6.4): ints ONLY, 32-bit two's complement — the JS
 * engine's native path, and exactly what mulberry32 and every tile-flag assume.
 * A float is refused with the fix in the message ("what are the bits of 2.5" has no
 * answer a language should invent); bools do not coerce.
 */
export function qbskBitwise(
  op: "&" | "|" | "^" | "<<" | ">>",
  a: QValue,
  b: QValue,
  span: Span,
): QValue {
  if (a.type !== "int" || b.type !== "int") {
    const offender = a.type !== "int" ? a : b;
    throw new QbskRuntimeError(
      `'${op}' works on ints only, got '${typeName(offender)}' — use int(x) first`,
      span,
    );
  }
  switch (op) {
    case "&":
      return { type: "int", value: a.value & b.value };
    case "|":
      return { type: "int", value: a.value | b.value };
    case "^":
      return { type: "int", value: a.value ^ b.value };
    case "<<":
      return { type: "int", value: a.value << b.value };
    case ">>":
      return { type: "int", value: a.value >> b.value };
  }
}
