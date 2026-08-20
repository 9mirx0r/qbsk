// an earlier release — the procedural-RPG test scene (criterion 4: byte-exact determinism).
// the roadmap, the roadmap §1.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "../../src/parser/parser.js";
import { SceneProgram } from "../../src/interp/interpreter.js";

const source = readFileSync(
  new URL("../../examples/worldgen_test.qbsk", import.meta.url),
  "utf8",
);

// Enough real time (60fps steps) for every 1.2s tick threshold to fire and drive the
// scene from turn 0 through turn 10, where the history log deliberately stops.
const STEPS = 900;

const play = (): string => {
  const parsed = parse(source, "examples/worldgen_test.qbsk");
  expect(parsed.errors).toEqual([]);
  const p = new SceneProgram(parsed.ast, {
    runtime: { gameTime: 0 },
    baseDir: "examples",
  });
  let text = "";
  for (let i = 0; i < STEPS; i += 1) {
    const f = p.step(1 / 60);
    expect(f.error).toBeNull();
    text = f.canvas!.renderText();
  }
  return text;
};

describe("an earlier release determinism (14-dwarf-fortress-worldgen-research.md §5's seed model)", () => {
  it("two independent runs from the same source produce byte-identical frames", () => {
    // No root seed is threaded through QBSK here (bench/worldgen-gen.mjs already
    // rolled the NPCs' personalities host-side, deterministically, into static
    // .qbdata — see that script's own header for why). What this test proves is the
    // OTHER half of determinism: given that fixed data, the in-scene history
    // simulation (turn-triggered rules, no in-language randomness) reproduces
    // bit-for-bit, the same guarantee every other QBSK scene already carries.
    expect(play()).toBe(play());
  });

  it("the full 10-turn history composes byte for byte against a committed golden", () => {
    const golden = readFileSync(
      new URL("../golden/worldgen_test.qbsk.out", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(play()).toBe(golden);
  });
});
