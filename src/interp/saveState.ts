// Serializer for `save_state` (docs/language.md §13.2): a QBSK state dict becomes
// `.qbdata` text, one entry per top-level key.
//
// The READER is the existing `loadQbdata`, and that is the security model: the writer
// emits only what the `.qbdata` grammar admits, so a save file cannot execute no matter
// who edited it. There is no second parser to drift — writer and reader agree by
// construction about what a string escape or a float is.
//
// Errors are thrown as plain `Error`s with the key named; the native wraps them in a
// `QbskRuntimeError` with the call span and the slot name. A value that is not data is
// ALWAYS an error, never a silent skip — a save that quietly dropped a key would be
// discovered three sessions later by whatever read it back.

import type { QValue } from "./value.js";

const ENTRY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function serializeState(state: {
  type: "dict";
  map: Map<string, QValue>;
}): string {
  const lines: string[] = ["// written by save_state (docs/language.md §13)"];
  for (const [key, value] of state.map) {
    if (!ENTRY_NAME.test(key)) {
      throw new Error(
        `cannot save key '${key}': not a valid entry name (a top-level key becomes a '.qbdata' entry)`,
      );
    }
    lines.push(`${key} = ${literal(value, key)}`);
  }
  return lines.join("\n") + "\n";
}

function literal(v: QValue, key: string): string {
  switch (v.type) {
    case "null":
      return "null";
    case "bool":
      return v.value ? "true" : "false";
    case "int":
      return String(v.value);
    case "float":
      return floatText(v.value, key);
    case "str":
      return strText(v.value);
    case "tuple":
      return `(${literal(v.x, key)}, ${literal(v.y, key)})`;
    case "list":
      return `[${v.items.map((item) => literal(item, key)).join(", ")}]`;
    case "dict":
      return `{${[...v.map.entries()]
        .map(([k, val]) => `${strText(k)}: ${literal(val, key)}`)
        .join(", ")}}`;
    default:
      // func, native, scene, canvas, sprite, layer, event, primitive, module: live
      // objects, not data. Named outright (§13.3).
      return fail(key, `a ${v.type} is not data`);
  }
}

function fail(key: string, why: string): never {
  throw new Error(`cannot save key '${key}': ${why}`);
}

/**
 * A float must come back a float: `3` saved from a float binding is written `3.0`,
 * or a game's physics would change type on load. Exponent forms (`1e21`) are already
 * floats to the lexer and are left alone.
 */
function floatText(value: number, key: string): string {
  if (!Number.isFinite(value)) {
    return fail(key, `${value} is not a finite number`);
  }
  const s = String(value);
  if (Number.isInteger(value) && !s.includes("e") && !s.includes("E")) {
    return `${s}.0`;
  }
  return s;
}

/**
 * Escapes exactly what the QBSK string grammar requires (docs/language.md §2), plus
 * the interpolation braces: `{` in a saved value must become `{{`, or the loader
 * would see the start of an interpolation and refuse the file (§12.2 — `.qbdata`
 * cannot interpolate). `}` becomes `}}` because the lexer collapses `}}` to `}`.
 */
function strText(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "{":
        out += "{{";
        break;
      case "}":
        out += "}}";
        break;
      default:
        out += ch;
    }
  }
  return out + '"';
}
