// L3 — guarded handlers (docs/language.md §6.6): `on ... when expr`.
//
// The phase's acceptance criterion: main_menu.qbsk's dispatch-table handlers
// (`on key "enter"` holding a four-branch if) rewrite into guarded handlers with
// identical behaviour — behaviour pinned here by driving the real example.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../src/parser/parser.js";
import { SceneProgram } from "../../src/interp/interpreter.js";

const load = (source: string) => {
  const parsed = parse(source, "l3.qbsk");
  expect(parsed.errors).toEqual([]);
  const out: string[] = [];
  const program = new SceneProgram(parsed.ast, {
    print: (line) => out.push(line),
  });
  expect(program.error).toBeNull();
  return { program, out };
};

describe("on key ... when (docs/language.md §6.6)", () => {
  it("only the handler whose guard holds runs", () => {
    const { program, out } = load(
      [
        `var screen = "menu"`,
        `on key "enter" when screen == "menu"`,
        `    print("menu enter")`,
        `on key "enter" when screen == "world"`,
        `    print("world enter")`,
      ].join("\n"),
    );
    program.pressKey("enter");
    program.step(1 / 60);
    expect(out).toEqual(["menu enter"]);
  });

  it("guards are evaluated BEFORE any handler runs — a state change cannot re-route the same press", () => {
    const { program, out } = load(
      [
        `var screen = "menu"`,
        `on key "enter" when screen == "menu"`,
        `    screen = "world"`,
        `    print("to world")`,
        `on key "enter" when screen == "world"`,
        `    screen = "menu"`,
        `    print("to menu")`,
      ].join("\n"),
    );
    program.pressKey("enter");
    program.step(1 / 60);
    expect(out).toEqual(["to world"]);
    program.pressKey("enter");
    program.step(1 / 60);
    expect(out).toEqual(["to world", "to menu"]);
  });

  it("an unguarded handler always runs, alongside eligible guarded ones", () => {
    const { program, out } = load(
      [
        `var screen = "menu"`,
        `on key "x" when screen == "menu"`,
        `    print("guarded")`,
        `on key "x"`,
        `    print("always")`,
      ].join("\n"),
    );
    program.pressKey("x");
    program.step(1 / 60);
    expect(out).toEqual(["guarded", "always"]);
  });

  it("on tick ... when gates per-frame logic", () => {
    const { program, out } = load(
      [
        `var mode = "idle"`,
        `on tick(dt) when mode == "running"`,
        `    print("stepped")`,
        `on key "space"`,
        `    mode = "running"`,
      ].join("\n"),
    );
    program.step(1 / 60);
    expect(out).toEqual([]);
    program.pressKey("space");
    program.step(1 / 60);   // guard read BEFORE the key handler flips mode? No:
    program.step(1 / 60);   // ticks dispatch before keys within a step (§7.7 order),
    expect(out).toEqual(["stepped"]);  // so the flip lands on the NEXT frame's tick.
  });

  it("on turn ... when gates simulation handlers", () => {
    const { program, out } = load(
      [
        `var alive = true`,
        `on turn(n) when alive`,
        `    print("turn {n}")`,
        `on key "." `,
        `    advance()`,
        `on key "k"`,
        `    alive = false`,
      ].join("\n"),
    );
    program.pressKey(".");
    program.step(1 / 60);
    program.step(1 / 60);
    expect(out).toEqual(["turn 1"]);
    program.pressKey("k");
    program.step(1 / 60);
    program.pressKey(".");
    program.step(1 / 60);
    program.step(1 / 60);
    expect(out).toEqual(["turn 1"]);
  });

  it("a guard that throws is a runtime error with a span", () => {
    const { program } = load(
      [
        `on key "x" when missing == 1`,
        `    print("never")`,
      ].join("\n"),
    );
    program.pressKey("x");
    const frame = program.step(1 / 60);
    expect(frame.error).not.toBeNull();
    expect(frame.error!.message).toMatch(/missing/);
  });

  it("hasKeyHandler reports the binding even when the guard is off", () => {
    const { program } = load(
      [
        `var screen = "menu"`,
        `on key "enter" when screen == "nowhere"`,
        `    print("never")`,
      ].join("\n"),
    );
    expect(program.hasKeyHandler("enter")).toBe(true);
  });

  it("'when' still works as an identifier nowhere — it is a keyword now, and the error says so", () => {
    const parsed = parse(`var when = 1`, "l3.qbsk");
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The acceptance criterion: main_menu.qbsk driven end-to-end after its rewrite
// ---------------------------------------------------------------------------

describe("main_menu.qbsk drives identically after the guarded-handler rewrite", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));

  it("menu -> down -> down -> enter (GENERATE WORLD) reaches the generating screen", () => {
    const file = resolve(HERE, "..", "..", "examples", "main_menu.qbsk");
    const source = readFileSync(file, "utf8");
    const parsed = parse(source, file);
    expect(parsed.errors).toEqual([]);
    const program = new SceneProgram(parsed.ast, {
      baseDir: dirname(file),
    });
    expect(program.error).toBeNull();

    const screenOf = () => {
      const v = program.liveEnv.get("screen");
      return v !== undefined && v.type === "str" ? v.value : "?";
    };

    expect(screenOf()).toBe("menu");
    program.pressKey("arrow-down");
    program.step(1 / 60);
    program.pressKey("arrow-down");
    program.step(1 / 60);
    program.pressKey("enter");
    program.step(1 / 60);
    expect(screenOf()).toBe("generating");
  });
});
