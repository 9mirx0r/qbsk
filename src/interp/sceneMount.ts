import type { BorderStyle, LayerDef, PrimitiveOp, PrimitiveStyle, SceneDef } from "../choreo/scene.js";
import type { StaticLayerCache } from "../choreo/scene.js";
import { resolveColor } from "../engine/color.js";
import { qbskStr, type DslStyle, type QValue } from "./value.js";

// DSL → engine adapter (allowed direction: the language drives the engine).
// DSL values are already validated by the interpreter (width/height/z ints,
// color names).
//
// Nothing is "skipped" here any more. `sprite` mounts as a blit; `color`, `z` and
// `visible` are state directives intercepted before a layer's primitives are built;
// `shade` and `tone` are consumed the same way. A primitive that reached this file
// and quietly produced nothing was the ghost shape §14 of the language spec exists
// to kill.

type RawProp = string | DslStyle | QValue | null | undefined;

function toInt(v: RawProp): number {
  return v !== null && v !== undefined && typeof v !== "string" && !("fg" in v) && v.type === "int"
    ? v.value
    : 0;
}

function toBool(v: RawProp): boolean {
  return v !== null && v !== undefined && typeof v !== "string" && !("fg" in v) && v.type === "bool"
    ? v.value
    : true;
}

// world: true only if explicitly set; default false (local).
function toWorld(v: RawProp): boolean {
  return v !== null && v !== undefined && typeof v !== "string" && !("fg" in v) && v.type === "bool"
    ? v.value
    : false;
}

function toPoint(v: RawProp): { x: number; y: number } | null {
  if (v === null || v === undefined || typeof v === "string" || "fg" in v) {
    return null;
  }
  if (v.type === "tuple" && v.x.type === "int" && v.y.type === "int") {
    return { x: v.x.value, y: v.y.value };
  }
  return null;
}

function toStr(v: RawProp): string {
  if (typeof v === "string") {
    return v;
  }
  if (v === null || v === undefined || "fg" in v) {
    return "";
  }
  // put/primitive text: any scalar value converts to text
  // (int → "42", float → "2.5", bool → "true") like print.
  return v.type === "primitive" || v.type === "scene" || v.type === "layer"
    ? ""
    : qbskStr(v);
}

function point(v: RawProp): [number, number] {
  if (
    v === null ||
    v === undefined ||
    typeof v === "string" ||
    "fg" in v ||
    v.type !== "tuple"
  ) {
    return [0, 0];
  }
  return [toInt(v.x), toInt(v.y)];
}

function charOf(v: RawProp): string {
  const s = toStr(v);
  return s.length > 0 ? s[0]! : " ";
}

function styleOf(v: RawProp): BorderStyle {
  return typeof v === "string" ? (BORDER_STYLES[v] ?? "single") : "single";
}

function colorStyle(v: RawProp): PrimitiveStyle {
  const style: PrimitiveStyle = {};
  if (v !== null && v !== undefined && typeof v !== "string" && "fg" in v) {
    const fg = v.fg !== null ? resolveColor(v.fg) : null;
    const bg = v.bg !== null ? resolveColor(v.bg) : null;
    if (fg !== null) {
      style.fg = fg;
    }
    if (bg !== null) {
      style.bg = bg;
    }
  }
  return style;
}

const BORDER_STYLES: Record<string, BorderStyle> = {
  single: "single",
  double: "double",
  rounded: "rounded",
};

export function mountScene(value: QValue, staticCache?: StaticLayerCache): SceneDef | null {
  if (value.type !== "scene") {
    return null;
  }
  const width = toInt(value.params.get("width"));
  const height = toInt(value.params.get("height"));
  const layers: LayerDef[] = [];
  for (const layerValue of value.layers) {
    const layer = mountLayer(layerValue, width, height, staticCache);
    if (layer !== null) {
      layers.push(layer);
    }
  }
  return {
    name: value.name,
    width,
    height,
    // §14.3 — absent means absent. The interpreter has already rejected a wrong
    // type, so anything other than a value here is "the program did not say".
    title: strOrNull(value.params.get("title")),
    fps: intOrNull(value.params.get("fps")),
    layers,
  };
}

function strOrNull(v: RawProp): string | null {
  return v !== null && v !== undefined && typeof v === "object" && "type" in v && v.type === "str"
    ? v.value
    : null;
}

function intOrNull(v: RawProp): number | null {
  return v !== null && v !== undefined && typeof v === "object" && "type" in v && v.type === "int"
    ? v.value
    : null;
}

function mountLayer(
  value: QValue,
  width: number,
  height: number,
  staticCache?: StaticLayerCache,
): LayerDef | null {
  if (value.type !== "layer") {
    return null;
  }
  const items: PrimitiveOp[] = [];
  const cached = value.cacheKey !== undefined && staticCache?.has(value.cacheKey, width, height) === true;
  if (!cached) {
    for (const primitive of value.primitives) {
      const item = mountPrimitive(primitive);
      if (item !== null) {
        items.push(item);
      }
    }
  }
  return {
    name: value.name,
    z: toInt(value.z),
    visible: true,
    at: toPoint(value.at) ?? undefined,
    items,
    cacheKey: value.cacheKey,
  };
}

// `depth:` is optional and its absence must stay absent: undefined means "not
// depth-tested" and composes exactly as before, while 0 is a legitimate depth.
function toDepth(v: QValue | string | DslStyle | null | undefined): number | undefined {
  if (v === undefined || v === null || typeof v === "string") {
    return undefined;
  }
  if (typeof v === "object" && "type" in v && (v.type === "int" || v.type === "float")) {
    return v.value;
  }
  return undefined;
}

function mountPrimitive(value: QValue): PrimitiveOp | null {
  if (value.type === "sprite") {
    const [x, y] = point(value.at);
    return {
      op: "blit",
      x,
      y,
      lines: value.art.split("\n"),
      z: toInt(value.z),
      visible: toBool(value.visible),
      world: toWorld(value.world) || undefined,
      ...colorStyle(value.style),
    };
  }
  if (value.type !== "primitive") {
    return null;
  }
  switch (value.kind) {
    case "fill":
      return {
        op: "fill",
        ch: charOf(value.props.ch),
        z: toInt(value.props.z),
        visible: toBool(value.props.visible),
        ...colorStyle(value.props.dslStyle),
      };
    // The masked map (§11.12). The interpreter already resolved which cells the mask
    // showed — with the spans needed to report a mismatch — so this is a hand-off,
    // not a second place where the rule is decided.
    case "maskedPut": {
      return {
        op: "cells",
        cells: value.masked?.cells ?? [],
        depth: toDepth(value.props.depth),
        z: toInt(value.props.z),
        visible: toBool(value.props.visible),
        world: toWorld(value.props.world) || undefined,
        ...colorStyle(value.props.dslStyle),
      };
    }
    case "put":
    case "text": {
      const [x, y] = point(value.props.at);
      return {
        op: "text",
        x,
        y,
        text: toStr(value.props.text),
        depth: toDepth(value.props.depth),
        z: toInt(value.props.z),
        visible: toBool(value.props.visible),
        world: toWorld(value.props.world) || undefined,
        ...colorStyle(value.props.dslStyle),
      };
    }
    case "box":
    case "border": {
      const [x1, y1] = point(value.props.from);
      const [x2, y2] = point(value.props.to);
      return {
        op: "border",
        x1,
        y1,
        x2,
        y2,
        style: styleOf(value.props.style),
        z: toInt(value.props.z),
        visible: toBool(value.props.visible),
        ...colorStyle(value.props.dslStyle),
      };
    }
    case "line": {
      const [x1, y1] = point(value.props.from);
      const [x2, y2] = point(value.props.to);
      return {
        op: "line",
        x1,
        y1,
        x2,
        y2,
        // §11.16 — absent style keeps the `*` this has always drawn.
        ch: "*",
        stroke: value.props.style === "stroke" || undefined,
        z: toInt(value.props.z),
        visible: toBool(value.props.visible),
        ...colorStyle(value.props.dslStyle),
      };
    }
    default:
      // Unreachable today, and kept anyway. `anchor` was the ONLY kind that ever
      // landed here — it is now a parse error (§14.2), and `sprinkle` is gone from
      // the language (§14.5). Every other kind is either mounted above or
      // intercepted as a state directive before it reaches a layer's primitives.
      //
      // It survives because `QValue`'s primitive variant types `kind` as a bare
      // `string`, so this switch is not exhaustive to TypeScript — and because a
      // silent `null` for an unforeseen kind is exactly the ghost this section of
      // the spec exists to kill. Same reasoning as parser.ts's own default:
      // "this branch is unreachable" is not an exemption (RULE #4).
      return null;
  }
}
