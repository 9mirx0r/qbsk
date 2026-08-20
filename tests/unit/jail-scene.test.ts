// The converted-art example is pinned (docs/engine.md §11.17).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";
import { convertImage, fidelity } from "../../src/tools/imageToGrid.js";
import { decodePng } from "../../src/tools/pngDecode.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(resolve(ROOT, ...p), "utf8");

describe("a photograph becomes a scene", () => {
  it("examples/jail_scene.qbsk matches its golden byte for byte", () => {
    const source = read("examples", "jail_scene.qbsk");
    const golden = read("tests", "golden", "jail_scene.qbsk.out");
    const result = runQbsk(source, "jail_scene.qbsk", undefined, {
      baseDir: resolve(ROOT, "examples"),
    });
    expect(result.error).toBeNull();
    expect(result.out.join("\n")).toBe(golden.replace(/\r\n/g, "\n").replace(/\n$/, ""));
  });

  // Criterion 1: the stage owes a measured number, and it is checked here rather than
  // quoted in a comment somebody can let go stale.
  it("the checked-in asset preserves the source's ordering of light", () => {
    const png = decodePng(readFileSync(resolve(ROOT, "bench", "jail-source.png")));
    const grid = convertImage(
      { pixels: png.pixels, width: png.width, height: png.height, channels: png.channels },
      { cols: 120, rows: 40, normalise: true, gamma: 0.6 },
    );

    const data = read("examples", "res", "ramp.qbdata");
    const body = data.slice(data.indexOf('"coverage"'));
    const coverage = new Map<string, number>();
    for (const m of body.matchAll(/"(.)": *([0-9.]+)/g)) {
      coverage.set(m[1]!, Number(m[2]));
    }

    expect(fidelity(grid, coverage)).toBeGreaterThan(0.9);
  });

  it("regenerating the asset reproduces what is checked in", () => {
    const png = decodePng(readFileSync(resolve(ROOT, "bench", "jail-source.png")));
    const grid = convertImage(
      { pixels: png.pixels, width: png.width, height: png.height, channels: png.channels },
      { cols: 120, rows: 40, normalise: true, gamma: 0.6 },
    );
    const asset = read("examples", "res", "jail.qbdata");
    for (const line of grid.lines) {
      expect(asset).toContain(JSON.stringify(line));
    }
  });
});
