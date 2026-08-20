// .qba format (spec docs/engine.md §12): plain text with META, ASCII art and
// frames separated by ---. The loader is tolerant: it ignores # and outer
// blank lines; inner ones are space rows; short rows are
// padded to the width (META or the longest row).

export interface QbaSprite {
  name: string;
  width: number;
  height: number;
  frames: string[][];
}

export class QbaError extends Error {}

interface QbaMeta {
  name?: string;
  width?: number;
  height?: number;
}

/**
 * The META keys a `.qba` accepts (§15.9). Three, and they are checked.
 *
 * `anchor:` used to be dropped here by the `default` branch — and it appeared in
 * `docs/engine.md`'s own canonical example, so the spec taught a key the loader ignored.
 * Anchors are a property of the `sprite` primitive (`sprite "h.qba" at (0,0) anchor:
 * center`), never of the file. An unknown key now reports instead of vanishing.
 */
const QBA_META_KEYS = ["name", "width", "height"];

function parseMeta(line: string, file: string): QbaMeta {
  const meta: QbaMeta = {};
  const body = line.slice(line.indexOf("META") + 4);
  for (const part of body.split(",")) {
    const idx = part.indexOf(":");
    if (idx < 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    switch (key) {
      case "name":
        meta.name = raw;
        break;
      case "width": {
        const w = Number(raw);
        if (Number.isInteger(w) && w > 0) {
          meta.width = w;
        }
        break;
      }
      case "height": {
        const h = Number(raw);
        if (Number.isInteger(h) && h > 0) {
          meta.height = h;
        }
        break;
      }
      default:
        throw new QbaError(
          `${file}: '${key}' is not a META key (${QBA_META_KEYS.join(", ")})` +
            (key === "anchor"
              ? " — an anchor belongs on the sprite primitive, not in the file"
              : ""),
        );
    }
  }
  return meta;
}

export function loadQba(source: string, file: string): QbaSprite {
  const lines = source.split("\n");
  const defaults: QbaMeta = {};
  const frameLines: string[][] = [];
  let frameIdx = -1;
  let sawArt = false;

  const ensureFrame = (): string[] => {
    if (frameIdx < 0) {
      frameLines.push([]);
      frameIdx = frameLines.length - 1;
    }
    return frameLines[frameIdx]!;
  };

  const currentHasArt = (): boolean =>
    frameIdx >= 0 && frameLines[frameIdx]!.length > 0;

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("META")) {
      if (currentHasArt()) {
        frameIdx = -1;
      }
      if (frameIdx < 0 && frameLines.length === 0) {
        Object.assign(defaults, parseMeta(trimmed, file));
      }
      continue;
    }
    if (trimmed === "---") {
      frameIdx = -1;
      continue;
    }
    if (trimmed === "") {
      if (currentHasArt()) {
        ensureFrame().push("");
      }
      continue;
    }
    sawArt = true;
    ensureFrame().push(line);
  }

  if (!sawArt) {
    throw new QbaError(`${file}: contains no art`);
  }

  const width = defaults.width ?? Math.max(0, ...frameLines.map((f) => Math.max(0, ...f.map((r) => r.length))));
  const frames = frameLines.map((rows) => {
    const padded: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      if (row.length > width) {
        throw new QbaError(
          `${file}: row ${i + 1} exceeds the declared width ${width} (${row.length} characters)`,
        );
      }
      padded.push(row.padEnd(width, " "));
    }
    while (padded.length > 0 && padded[padded.length - 1]!.trim() === "") {
      padded.pop();
    }
    if (defaults.height !== undefined && padded.length > defaults.height) {
      throw new QbaError(
        `${file}: exceeds the declared height ${defaults.height} (${padded.length} rows)`,
      );
    }
    return padded;
  });

  return {
    name: defaults.name ?? basenameNoExt(file),
    width,
    height: defaults.height ?? Math.max(0, ...frames.map((f) => f.length)),
    frames,
  };
}

function basenameNoExt(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? file;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The nine anchor points (docs/language.md §7.3, §15.9).
 *
 * NINE, not ten. `middle-center` used to sit here as a second name for `center` — the
 * runtime accepted it, the error message never listed it, and the spec did not mention
 * it, so the language had a name only the table knew about. Two names for one point is
 * "a single way to do things" (§1) losing to an accident, so the alias is gone rather
 * than blessed.
 */
const ANCHORS: Record<string, [number, number]> = {
  "top-left": [0, 0],
  "top-center": [0.5, 0],
  "top-right": [1, 0],
  "middle-left": [0, 0.5],
  center: [0.5, 0.5],
  "middle-right": [1, 0.5],
  "bottom-left": [0, 1],
  "bottom-center": [0.5, 1],
  "bottom-right": [1, 1],
};

export const ANCHOR_NAMES: ReadonlySet<string> = new Set(Object.keys(ANCHORS));

// Returns the anchor offset (dx, dy): the art's top-left corner
// lands at (at - offset) so the anchor point sits on (at).
export function anchorOffset(
  width: number,
  height: number,
  anchor: string | [number, number] | null,
): [number, number] {
  const named = anchor !== null && typeof anchor === "string" ? ANCHORS[anchor] : undefined;
  const fx = named !== undefined ? named[0] : Array.isArray(anchor) ? anchor[0] : 0;
  const fy = named !== undefined ? named[1] : Array.isArray(anchor) ? anchor[1] : 0;
  return [Math.round(fx * (width - 1)), Math.round(fy * (height - 1))];
}

// Scale by repetition: each character repeats fx times horizontally and each
// row fy times vertically. fx/fy ≥ 1 (validated by the caller).
export function scaleArt(lines: string[], fx: number, fy: number): string[] {
  const out: string[] = [];
  for (const row of lines) {
    const wide = row
      .split("")
      .map((ch) => ch.repeat(fx))
      .join("");
    for (let i = 0; i < fy; i += 1) {
      out.push(wide);
    }
  }
  return out;
}
