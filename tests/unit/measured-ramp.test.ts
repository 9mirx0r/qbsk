// The measured density ramp, end to end (docs/engine.md §11.15).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";
import { decodePng } from "../../src/tools/pngDecode.js";
import {
  cropColumns,
  cropRows,
  markerBounds,
  measureCoverage,
  normalise,
} from "../../src/tools/rampMeasure.js";
import { DENSITY_RAMP, rampFromTable } from "../../src/engine/ramp.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GLYPHS = " .:-=+*#%@";
const ROWS = { y0: 26, y1: 44 };

function measureStrip() {
  const decoded = decodePng(readFileSync(resolve(ROOT, "bench", "ramp-strip.png")));
  // Buffer widens to Uint8Array here on purpose: `cropRows`/`cropColumns` return plain
  // typed arrays, and the measurement never needs Buffer's extras.
  let strip: { pixels: Uint8Array; width: number; height: number; channels: 3 | 4 } = {
    pixels: decoded.pixels,
    width: decoded.width,
    height: decoded.height,
    channels: decoded.channels,
  };
  strip = cropRows(strip, ROWS.y0, ROWS.y1);
  const bounds = markerBounds({ ...strip, inkIsDark: false });
  expect(bounds, "the strip must be framed by two full blocks").not.toBeNull();
  strip = cropColumns(strip, bounds!.x0, bounds!.x1);
  return { strip, measured: measureCoverage({ ...strip, glyphs: GLYPHS, inkIsDark: false }) };
}

describe("the committed strip measures the way the table says", () => {
  // Criterion 5: regenerating the table from the same PNG is byte-identical. The image
  // is committed precisely so this is checkable rather than a claim about a lost file.
  it("reproduces the committed table's ramp exactly", () => {
    const { measured } = measureStrip();
    const ramp = rampFromTable(normalise(measured));
    const table = readFileSync(resolve(ROOT, "examples", "res", "ramp.qbdata"), "utf8");
    expect(table).toContain(`"glyphs": ${JSON.stringify(ramp)}`);
  });

  it("finds the marker frame at a whole number of pixels per cell", () => {
    // 9.00 px/cell on this strip. A fractional result means the frame was found in the
    // wrong place, which is the failure this catches before the numbers look plausible.
    const { strip } = measureStrip();
    expect(strip.width % GLYPHS.length).toBe(0);
  });

  // Criterion 2, primary branch: the measured order must differ from the guess
  // somewhere. It differs in two places.
  it("disagrees with the hand-written ramp, which is why it was measured", () => {
    const { measured } = measureStrip();
    const ramp = rampFromTable(normalise(measured));
    expect(ramp).not.toBe(DENSITY_RAMP);
    expect(ramp).toBe(" .:-+=*%#@");
    // '+' is lighter than '=', and '%' is lighter than '#': both pairs are inverted in
    // the hand-written order.
    expect(ramp.indexOf("+")).toBeLessThan(ramp.indexOf("="));
    expect(ramp.indexOf("%")).toBeLessThan(ramp.indexOf("#"));
    expect(DENSITY_RAMP.indexOf("=")).toBeLessThan(DENSITY_RAMP.indexOf("+"));
    expect(DENSITY_RAMP.indexOf("#")).toBeLessThan(DENSITY_RAMP.indexOf("%"));
  });

  it("keeps the ramp monotonic, sparse to dense", () => {
    const { measured } = measureStrip();
    const normalised = normalise(measured);
    const sorted = [...normalised].sort((a, b) => a.coverage - b.coverage);
    expect(sorted[0]!.glyph).toBe(" ");
    expect(sorted[sorted.length - 1]!.glyph).toBe("@");
    expect(sorted[0]!.coverage).toBe(0);
    expect(sorted[sorted.length - 1]!.coverage).toBe(1);
  });

  // Criterion 4: the default is an addition, never a replacement.
  it("leaves DENSITY_RAMP exactly where it was", () => {
    expect(DENSITY_RAMP).toBe(" .:-=+*#%@");
  });
});

describe("the measured ramp reaches a scene", () => {
  // Criterion 3: glyph() takes the measured ramp — a data change, not an API change —
  // and a golden pins a scene rendered with it.
  it("examples/measured_ramp.qbsk matches its golden byte for byte", () => {
    const source = readFileSync(resolve(ROOT, "examples", "measured_ramp.qbsk"), "utf8");
    const golden = readFileSync(
      resolve(ROOT, "tests", "golden", "measured_ramp.qbsk.out"),
      "utf8",
    );
    const result = runQbsk(source, resolve(ROOT, "examples", "measured_ramp.qbsk"), undefined, {
      baseDir: resolve(ROOT, "examples"),
    });
    expect(result.error).toBeNull();
    expect(result.out.join("\n")).toBe(golden.replace(/\r\n/g, "\n"));
  });

  it("the two gradients really do render differently", () => {
    const golden = readFileSync(
      resolve(ROOT, "tests", "golden", "measured_ramp.qbsk.out"),
      "utf8",
    ).split(/\r?\n/);
    const guessed = golden[1]!;
    const measured = golden[4]!;
    expect(guessed).not.toBe(measured);
    // Same length, same ends: only the middle ordering moved.
    expect(measured.trimEnd().length).toBe(guessed.trimEnd().length);
  });
});
