// Per-cell colour transforms (docs/engine.md §11.6).
import { describe, expect, it } from "vitest";
import { Canvas } from "../../src/engine/canvas.js";
import { tokenize } from "../../src/lexer/lexer.js";
import { parse } from "../../src/parser/parser.js";
import { analyzeProgram } from "../../src/analyze/analyzer.js";
import { runQbsk } from "../../src/interp/interpreter.js";
import { resolveColor } from "../../src/engine/color.js";
import { cellOf } from "../../src/engine/cell.js";
import {
  applyShades,
  isShadeName,
  shadeAmount,
  SHADE_NAMES,
  type ShadeSpec,
} from "../../src/engine/shade.js";

const spec = (over: Partial<ShadeSpec> = {}): ShadeSpec => ({
  kind: "grade",
  x: 0,
  y: 0,
  radius: 10,
  tint: 0x0000ff,
  strength: 1,
  speed: 1,
  ...over,
});

function filled(w: number, h: number, fg: number): Canvas {
  const c = new Canvas(w, h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      c.setCell(x, y, cellOf("#", fg, -1, 0));
    }
  }
  return c;
}

describe("shadeAmount is pure and bounded", () => {
  it("knows its names", () => {
    expect(SHADE_NAMES).toEqual(["radial", "grade", "pulse", "scanline"]);
    expect(isShadeName("radial")).toBe(true);
    expect(isShadeName("bloom")).toBe(false);
  });

  it("grade is uniform: every cell gets the same amount", () => {
    const s = spec({ strength: 0.4 });
    expect(shadeAmount(s, 0, 0, 0)).toBeCloseTo(0.4, 6);
    expect(shadeAmount(s, 50, 30, 9)).toBeCloseTo(0.4, 6);
  });

  it("radial is strongest at the centre and nothing past the radius", () => {
    const s = spec({ kind: "radial", x: 10, y: 5, radius: 6, strength: 1 });
    expect(shadeAmount(s, 10, 5, 0)).toBeCloseTo(1, 6);
    expect(shadeAmount(s, 10, 11, 0)).toBe(0);
    expect(shadeAmount(s, 10, 40, 0)).toBe(0);
  });

  it("radial compensates for the cell aspect, so a light reads round", () => {
    // A cell is about twice as tall as it is wide. Without compensation the same
    // cell distance horizontally and vertically would give the same falloff, and
    // the light would look squashed.
    const s = spec({ kind: "radial", x: 20, y: 10, radius: 8, strength: 1 });
    const horizontal = shadeAmount(s, 24, 10, 0);
    const vertical = shadeAmount(s, 20, 12, 0);
    expect(horizontal).toBeCloseTo(vertical, 6);
  });

  it("a zero radius affects nothing instead of dividing by zero", () => {
    expect(shadeAmount(spec({ kind: "radial", radius: 0 }), 0, 0, 0)).toBe(0);
    expect(Number.isFinite(shadeAmount(spec({ kind: "radial", radius: 0 }), 1, 1, 0))).toBe(true);
  });

  it("pulse stays within [0, strength] — it never inverts", () => {
    const s = spec({ kind: "pulse", speed: 1, strength: 0.6 });
    for (let i = 0; i <= 40; i += 1) {
      const a = shadeAmount(s, 0, 0, i / 20);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(0.6);
    }
  });

  it("scanline banding is horizontal, on odd rows", () => {
    const s = spec({ kind: "scanline", strength: 0.5 });
    expect(shadeAmount(s, 3, 0, 0)).toBe(0);
    expect(shadeAmount(s, 3, 1, 0)).toBeCloseTo(0.5, 6);
    // Same row, different column: banding must not depend on x.
    expect(shadeAmount(s, 77, 1, 0)).toBe(shadeAmount(s, 0, 1, 0));
  });

  it("is a pure function of its inputs — asked twice, same answer", () => {
    const s = spec({ kind: "pulse", speed: 3, strength: 1 });
    expect(shadeAmount(s, 4, 7, 1.234)).toBe(shadeAmount(s, 4, 7, 1.234));
  });

  it("strength is clamped: 2 does not overshoot, -1 does not invert", () => {
    expect(shadeAmount(spec({ strength: 2 }), 0, 0, 0)).toBe(1);
    expect(shadeAmount(spec({ strength: -1 }), 0, 0, 0)).toBe(0);
  });
});

describe("applyShades moves colour towards the tint", () => {
  it("a full-strength grade reaches the tint exactly", () => {
    const c = filled(3, 2, 0xff0000);
    applyShades(c, [spec({ tint: 0x0000ff, strength: 1 })], 0);
    expect(c.cells[0]!.fg).toBe(0x0000ff);
  });

  it("half strength lands halfway", () => {
    const c = filled(2, 1, 0x000000);
    applyShades(c, [spec({ tint: 0xffffff, strength: 0.5 })], 0);
    expect(c.cells[0]!.fg).toBe(0x808080);
  });

  it("a negative tint darkens towards black", () => {
    const c = filled(2, 1, 0x808080);
    applyShades(c, [spec({ tint: -1, strength: 1 })], 0);
    expect(c.cells[0]!.fg).toBe(0x000000);
  });

  it("shades stack in declaration order", () => {
    const a = filled(1, 1, 0x000000);
    applyShades(a, [
      spec({ tint: 0xffffff, strength: 1 }),
      spec({ tint: 0xff0000, strength: 1 }),
    ], 0);
    expect(a.cells[0]!.fg).toBe(0xff0000);
  });

  it("changes colour only — characters and backgrounds are untouched", () => {
    const c = filled(4, 2, 0x00ff00);
    const before = c.renderText();
    const bg = c.cells[0]!.bg;
    applyShades(c, [spec({ tint: 0xff00ff, strength: 0.7 })], 0);
    expect(c.renderText()).toBe(before);
    expect(c.cells[0]!.bg).toBe(bg);
  });

  // The trap this module was written around: Canvas fills its grid with ONE shared
  // DEFAULT_CELL object, so mutating a cell in place would rewrite the default for
  // every unwritten cell in the process.
  it("never corrupts the shared default cell", () => {
    const painted = new Canvas(2, 1);
    painted.setCell(0, 0, cellOf("#", 0xffffff, -1, 0));
    applyShades(painted, [spec({ tint: 0xff0000, strength: 1 })], 0);
    // The cell that was never written must still be default-coloured...
    expect(painted.cells[1]!.fg).toBe(-1);
    // ...and a brand-new canvas must be untainted too.
    const fresh = new Canvas(2, 1);
    expect(fresh.cells[0]!.fg).toBe(-1);
    expect(fresh.cells[0]!.char).toBe(" ");
  });

  it("a default-coloured cell is left alone rather than being given a colour", () => {
    // Grading an unstyled cell would make "no colour set" suddenly opinionated.
    const c = new Canvas(2, 1);
    applyShades(c, [spec({ tint: 0xff0000, strength: 1 })], 0);
    expect(c.cells[0]!.fg).toBe(-1);
  });

  it("an empty shade list is a no-op", () => {
    const c = filled(3, 2, 0x123456);
    applyShades(c, [], 0);
    expect(c.cells[0]!.fg).toBe(0x123456);
  });
});

// The DSL surface (docs/engine.md §11.6). The maths is covered above; these pin the
// language side — that a shade is a primitive, that it recolours without repainting,
// and that its failures report like every other QBSK error.
describe("the shade DSL surface", () => {
  const SCENE = [
    "scene S(width: 6, height: 2)",
    "layer a z: 1",
    "    color fg: bright-white",
    '    put "######" at (0, 0)',
  ].join("\n");

  it("lexes 'shade' as its own keyword", () => {
    expect(tokenize("shade", "t.qbsk")[0]!.type).toBe("SHADE");
  });

  it("parses a shade with all named args into a ShadeStmt", () => {
    const { ast, errors } = parse(
      "shade radial x: 2 y: 3 radius: 8 tint: red strength: 0.5 speed: 2",
      "t.qbsk",
    );
    expect(errors).toHaveLength(0);
    const stmt = ast.body[0]!;
    expect(stmt.kind).toBe("ShadeStmt");
    const sh = stmt as Extract<typeof stmt, { kind: "ShadeStmt" }>;
    expect(sh.args.map((a) => a.name)).toEqual([
      "x", "y", "radius", "tint", "strength", "speed",
    ]);
  });

  it("takes 'shade' as a layer name, and still reads the primitive inside it", () => {
    // This asserted the reservation until 2026-08-19. §15.15 freed all twenty-six scene
    // words outside statement position, so a layer may be called `shade` — and the
    // primitive of the same name still parses in the body, which is the half worth
    // keeping: the two readings have to hold at once or one of them is not a reading.
    const { errors } = parse(
      'scene S(width: 5, height: 3)\nlayer shade z: 1\n    fill "."',
      "t.qbsk",
    );
    expect(errors).toEqual([]);
  });

  it("recolours the cells the other primitives painted", () => {
    const plain = runQbsk(SCENE, "t.qbsk");
    const shaded = runQbsk(`${SCENE}\n    shade grade tint: red strength: 1.0`, "t.qbsk");
    expect(shaded.error).toBeNull();
    expect(plain.canvas!.cells[0]!.fg).not.toBe(shaded.canvas!.cells[0]!.fg);
    // The palette is the classic ANSI one, not web colours: red is 0xcd0000.
    expect(shaded.canvas!.cells[0]!.fg).toBe(resolveColor("red"));
  });

  it("changes colour only — the characters are byte-identical", () => {
    const plain = runQbsk(SCENE, "t.qbsk");
    const shaded = runQbsk(
      `${SCENE}\n    shade radial x: 0 y: 0 radius: 6 tint: blue strength: 0.9`,
      "t.qbsk",
    );
    expect(shaded.error).toBeNull();
    expect(shaded.canvas!.renderText()).toBe(plain.canvas!.renderText());
  });

  // The bug this surface actually shipped with: colour names are hyphenated, and the
  // expression grammar reads `bright-yellow` as a subtraction. Neither typecheck nor
  // the suite caught it — only running a scene did.
  it("accepts hyphenated colour names, which parse as a subtraction", () => {
    const r = runQbsk(
      `${SCENE}\n    shade grade tint: bright-yellow strength: 1.0`,
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.canvas!.cells[0]!.fg).toBe(resolveColor("bright-yellow"));
  });

  it("an unknown shade reports with a span, naming the ones that exist", () => {
    const r = runQbsk(`${SCENE}\n    shade bloom`, "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("bloom");
    expect(r.error!.message).toContain("radial");
  });

  it("an unknown colour reports rather than silently doing nothing", () => {
    const r = runQbsk(`${SCENE}\n    shade grade tint: puce`, "t.qbsk");
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("puce");
  });

  it("visible: false removes a shade, exactly as it removes a put", () => {
    const plain = runQbsk(SCENE, "t.qbsk");
    const gated = runQbsk(
      `${SCENE}\n    visible: false\n    shade grade tint: red strength: 1.0`,
      "t.qbsk",
    );
    expect(gated.error).toBeNull();
    expect(gated.canvas!.cells[0]!.fg).toBe(plain.canvas!.cells[0]!.fg);
  });

  it("several shades stack in declaration order", () => {
    const r = runQbsk(
      `${SCENE}\n    shade grade tint: red strength: 1.0\n    shade grade tint: blue strength: 1.0`,
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.canvas!.cells[0]!.fg).toBe(resolveColor("blue"));
  });

  it("qbsk check passes a shaded scene clean", () => {
    const problems = analyzeProgram(
      parse(`${SCENE}\n    shade radial radius: 5`, "t.qbsk").ast,
      "t.qbsk",
    );
    expect(problems).toEqual([]);
  });
});
