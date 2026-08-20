// L8 — the ghost hunt (docs/language.md §14).
//
// Every feature that parsed but did not do what it read like. They split in two, and
// the split is the point: the LOUD ones were honest — `sprinkle` told you it was not
// implemented, and you moved on. The SILENT ones changed what ran, or failed to, and
// said nothing.
//
// The worst was never `sprinkle`. It was a named argument silently reaching across a
// newline to swallow the next line's state directive, changing what got DRAWN based
// on nothing but line adjacency.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../src/parser/parser.js";
import { printAst } from "../../src/parser/ast.js";
import { runQbsk, SceneProgram } from "../../src/interp/interpreter.js";
import { analyzeProgram } from "../../src/analyze/analyzer.js";

// The .qba sprites the DSL loads live in examples/res, and a sprite path is
// resolved against baseDir (§7.4) — not against the test process's cwd.
const EXAMPLES = resolve(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples"),
);

const run = (source: string) =>
  runQbsk(source, "l8.qbsk", undefined, { baseDir: EXAMPLES });
const ast = (source: string) => {
  const parsed = parse(source, "l8.qbsk");
  expect(parsed.errors).toEqual([]);
  return printAst(parsed.ast);
};

// ---------------------------------------------------------------------------
// G2 — a named argument cannot cross a newline
// ---------------------------------------------------------------------------

describe("a named argument belongs to its own line (§14.1)", () => {
  it("a 'z:' on the line after a tone is a STATE DIRECTIVE, not a tone property", () => {
    const text = ast(
      [
        `scene S(width: 6, height: 2)`,
        `layer a z: 1`,
        `    tone 440`,
        `    z: 9`,
        `    put "L" at (0, 0)`,
      ].join("\n"),
    );
    expect(text).toContain("(Tone 440)");
    expect(text).toContain("(Z 9)");
    expect(text).not.toContain("(Tone 440 z: 9)");
  });

  it("same for sprite and shade", () => {
    const sprite = ast(
      [
        `scene S(width: 6, height: 2)`,
        `layer a z: 1`,
        `    sprite "res/hero.qba" at (0, 0)`,
        `    z: 9`,
        `    put "L" at (0, 0)`,
      ].join("\n"),
    );
    expect(sprite).toContain("(Z 9)");

    const shade = ast(
      [
        `scene S(width: 6, height: 2)`,
        `layer a z: 1`,
        `    shade radial x: 1 y: 1 radius: 2`,
        `    z: 9`,
        `    put "L" at (0, 0)`,
      ].join("\n"),
    );
    expect(shade).toContain("(Z 9)");
  });

  it("a 'visible:' after a sprite still gates the primitives below it", () => {
    const source = [
      `scene S(width: 4, height: 2)`,
      `layer a z: 1`,
      `    fill "."`,
      `layer b z: 2`,
      `    sprite "res/hero.qba" at (0, 0)`,
      `    visible: false`,
      `    put "X" at (0, 0)`,
    ].join("\n");
    const r = run(source);
    expect(r.error).toBeNull();
    // `visible: false` gates the put, so no X survives.
    expect(r.canvas!.renderText()).not.toContain("X");
  });

  it("same-line named args still work — the fix is about newlines, not named args", () => {
    const text = ast(
      [
        `scene S(width: 6, height: 2)`,
        `layer a z: 1`,
        `    sprite "res/hero.qba" at (0, 0) anchor: center`,
      ].join("\n"),
    );
    expect(text).toContain("anchor");
  });

  it("put's depth: still parses on the same line", () => {
    const text = ast(
      [
        `scene S(width: 6, height: 2)`,
        `layer a z: 1`,
        `    put "X" at (0, 0) depth: 3`,
      ].join("\n"),
    );
    expect(text).toContain("depth");
  });
});

// ---------------------------------------------------------------------------
// G1 — `anchor:` as a layer directive was a silent no-op
// ---------------------------------------------------------------------------

describe("the anchor: layer directive is a loud error (§14.2)", () => {
  it("reports instead of composing to nothing", () => {
    const parsed = parse(
      [
        `scene S(width: 6, height: 2)`,
        `layer a z: 1`,
        `    anchor: center`,
        `    put "H" at (0, 0)`,
      ].join("\n"),
      "l8.qbsk",
    );
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]!.message).toMatch(/anchor/);
  });

  it("the message says where the anchor belongs instead of just refusing", () => {
    const parsed = parse(
      [`layer a z: 1`, `    anchor: center`, `    put "H" at (0, 0)`].join("\n"),
      "l8.qbsk",
    );
    expect(parsed.errors[0]!.message).toMatch(/not a layer directive/);
    expect(parsed.errors[0]!.message).toMatch(/primitive/);
  });

  it("recovery continues — the primitive below is still parsed", () => {
    // A parse error must not swallow the rest of the layer (§8: multiple
    // errors per pass), otherwise one anchor hides every later mistake.
    const parsed = parse(
      [`layer a z: 1`, `    anchor: center`, `    put "H" at (0, 0)`].join("\n"),
      "l8.qbsk",
    );
    expect(printAst(parsed.ast)).toContain('(Put "H" at (0, 0))');
  });

  it("the working form — anchor: on a sprite — is untouched", () => {
    const parsed = parse(
      [
        `scene S(width: 6, height: 3)`,
        `layer a z: 1`,
        `    sprite "res/hero.qba" at (0, 0) anchor: center`,
      ].join("\n"),
      "l8.qbsk",
    );
    expect(parsed.errors).toEqual([]);
  });

  it("an anchor: on the line AFTER a sprite is rejected, not silently absorbed", () => {
    // §14.1 stops the sprite from eating it; §14.2 is what then reports it.
    // Before both rules this line changed the sprite's placement in silence.
    const parsed = parse(
      [
        `layer a z: 1`,
        `    sprite "res/hero.qba" at (0, 0)`,
        `    anchor: center`,
      ].join("\n"),
      "l8.qbsk",
    );
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]!.message).toMatch(/anchor/);
  });
});

// ---------------------------------------------------------------------------
// G3 — scene params: unknown keys were swallowed; fps:/title: were ignored
// ---------------------------------------------------------------------------

describe("scene parameters are checked and used (§14.3)", () => {
  it("an unknown scene parameter is an error naming it", () => {
    const parsed = parse(
      `scene S(width: 4, height: 2, bogus: 1)`,
      "l8.qbsk",
    );
    const problems = [
      ...parsed.errors,
      ...analyzeProgram(parsed.ast, "l8.qbsk", "."),
    ];
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]!.message).toMatch(/bogus/);
  });

  it("a near-miss gets the suggestion", () => {
    const parsed = parse(
      `scene S(width: 4, height: 2, tilte: "x")`,
      "l8.qbsk",
    );
    const problems = [
      ...parsed.errors,
      ...analyzeProgram(parsed.ast, "l8.qbsk", "."),
    ];
    expect(problems[0]!.message).toMatch(/title/);
  });

  it("fps: and title: reach the composed scene", () => {
    const r = run(
      [
        `scene S(width: 4, height: 2, title: "My Game", fps: 30)`,
        `layer a z: 1`,
        `    fill "."`,
      ].join("\n"),
    );
    expect(r.error).toBeNull();
    expect(r.sceneInfo).toEqual({ title: "My Game", fps: 30 });
  });

  it("a scene with no title/fps reports nulls, not invented defaults", () => {
    const r = run(
      [
        `scene S(width: 4, height: 2)`,
        `layer a z: 1`,
        `    fill "."`,
      ].join("\n"),
    );
    expect(r.error).toBeNull();
    expect(r.sceneInfo).toEqual({ title: null, fps: null });
  });

  it("now that they are read, a wrong type is an error", () => {
    // While nothing consumed them, a wrong type was invisible — a parameter nobody
    // reads cannot be wrong, and cannot be right either.
    const bad = run(
      [`scene S(width: 4, height: 2, fps: "fast")`, `layer a z: 1`, `    fill "."`].join(
        "\n",
      ),
    );
    expect(bad.error).not.toBeNull();
    expect(bad.error!.message).toMatch(/fps must be an int/);

    const badTitle = run(
      [`scene S(width: 4, height: 2, title: 7)`, `layer a z: 1`, `    fill "."`].join(
        "\n",
      ),
    );
    expect(badTitle.error!.message).toMatch(/title must be a str/);
  });

  it("fps: 0 is refused — a frame rate of zero is not a frame rate", () => {
    const r = run(
      [`scene S(width: 4, height: 2, fps: 0)`, `layer a z: 1`, `    fill "."`].join(
        "\n",
      ),
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/at least 1/);
  });

  it("a repeated parameter is reported instead of last-one-wins", () => {
    const parsed = parse(
      `scene S(width: 4, height: 2, width: 9)`,
      "l8.qbsk",
    );
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]!.message).toMatch(/duplicate/);
  });

  it("the sprite's own fps: is untouched — same word, different construct", () => {
    const parsed = parse(
      [
        `scene S(width: 8, height: 4)`,
        `layer a z: 1`,
        `    sprite "res/walk.qba" at (0, 0) frames: 4 fps: 8 loop: true`,
      ].join("\n"),
      "l8.qbsk",
    );
    expect(parsed.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// G7 — sprinkle is gone from the language
// ---------------------------------------------------------------------------

describe("sprinkle was removed, not left reserved (§14.5)", () => {
  it("'sprinkle' is an ordinary identifier now", () => {
    const r = run(
      [
        `var sprinkle = 3`,
        `print(str(sprinkle))`,
      ].join("\n"),
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["3"]);
  });

  it("the old syntax fails at PARSE time, with the loop that replaces it", () => {
    const parsed = parse(
      [
        `scene S(width: 6, height: 2)`,
        `layer a z: 1`,
        `    sprinkle "*" count: 3 at random`,
      ].join("\n"),
      "l8.qbsk",
    );
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// G5 — a handler declared after the top-level pass used to vanish
// ---------------------------------------------------------------------------

describe("an event handler that can never register says so (§14.4)", () => {
  it("declaring a handler from inside another handler is an error", () => {
    // The real ghost: `collecting` closes after the top-level pass, so this
    // declaration evaluated fine and then went nowhere. Pressing "b" afterwards was
    // indistinguishable from not pressing it.
    const program = new SceneProgram(
      parse(
        [
          `var n = 0`,
          `scene S(width: 6, height: 2)`,
          `layer a z: 1`,
          `    fill "."`,
          `func lateBind()`,
          `    on key "b"`,
          `        n = n + 100`,
          `on key "a"`,
          `    lateBind()`,
        ].join("\n"),
        "l8.qbsk",
      ).ast,
      {},
    );
    expect(program.error).toBeNull();
    program.pressKey("a");
    const frame = program.step(1 / 60);
    expect(frame.error).not.toBeNull();
    expect(frame.error!.message).toMatch(/can never register/);
  });

  it("a handler inside a func called DURING the top-level pass still registers", () => {
    // The rule is about WHEN evaluation happens, never about nesting depth.
    const program = new SceneProgram(
      parse(
        [
          `var n = 0`,
          `func setup()`,
          `    on key "c"`,
          `        n = n + 1`,
          `setup()`,
          `scene S(width: 6, height: 2)`,
          `layer a z: 1`,
          `    fill "."`,
        ].join("\n"),
        "l8.qbsk",
      ).ast,
      {},
    );
    expect(program.error).toBeNull();
    expect(program.hasKeyHandler("c")).toBe(true);
  });

  it("per-frame re-composition does not trip the rule", () => {
    // The scene body's handlers registered during bootstrap; re-visiting it each
    // frame must not look like a late declaration, or every game would die on
    // frame 2. This is why the window exists at all — re-registering would stack
    // duplicates — so only its silence was removed, not the window.
    const program = new SceneProgram(
      parse(
        [
          `var n = 0`,
          `scene S(width: 6, height: 2)`,
          `layer a z: 1`,
          `    fill "."`,
          `on key "a"`,
          `    n = n + 1`,
          `on tick(dt)`,
          `    n = n + 0`,
        ].join("\n"),
        "l8.qbsk",
      ).ast,
      {},
    );
    for (let i = 0; i < 5; i += 1) {
      expect(program.step(1 / 60).error).toBeNull();
    }
  });

  it("a handler in a module is an error instead of a silent drop", () => {
    // The frame loop belongs to the entry program (§7.7), so this could never have
    // worked. That decision stays; only the silence goes.
    const dir = mkdtempSync(join(tmpdir(), "qbsk-l8-"));
    writeFileSync(
      join(dir, "mod.qbsk"),
      [`export func helper()`, `    return 1`, `on key "a"`, `    print("never")`].join(
        "\n",
      ),
    );
    const entry = [`use "mod.qbsk"`, `print(str(mod.helper()))`].join("\n");
    const r = runQbsk(entry, join(dir, "main.qbsk"), undefined, { baseDir: dir });
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/module never registers/);
  });

  it("a one-shot run is NOT an error — 7.7 says a plain run has no frames", () => {
    // Nothing registers here either, but the same file legitimately declares
    // handlers for loop mode and still composes correctly. Refusing it would reject
    // a correct program for how it happens to be invoked.
    const r = run(
      [
        `scene S(width: 4, height: 2)`,
        `layer a z: 1`,
        `    fill "."`,
        `on key "a"`,
        `    print("pressed")`,
      ].join("\n"),
    );
    expect(r.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G10 — multi-line parameter lists in declarations
// ---------------------------------------------------------------------------

describe("a declaration's parameter list spans lines like a call's (§14.6)", () => {
  it("func declarations", () => {
    const r = run(
      [
        `func add(`,
        `    a,`,
        `    b,`,
        `)`,
        `    return a + b`,
        `print(str(add(1, 2)))`,
      ].join("\n"),
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["3"]);
  });

  it("lambdas", () => {
    const r = run(
      [
        `var f = func(`,
        `    a,`,
        `    b,`,
        `) a * b`,
        `print(str(f(3, 4)))`,
      ].join("\n"),
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["12"]);
  });

  it("on tick, on turn and on resize too — same rule, every list", () => {
    // The rule is about parenthesised lists, not about functions. Four of the six
    // copies of this loop had forgotten the line handling; they now share one.
    const parsed = parse(
      [
        `on tick(`,
        `    dt,`,
        `)`,
        `    print("t")`,
        `on resize(`,
        `    w,`,
        `    h,`,
        `)`,
        `    print("r")`,
        `on turn(`,
        `    n,`,
        `)`,
        `    print("n")`,
      ].join("\n"),
      "l8.qbsk",
    );
    expect(parsed.errors).toEqual([]);
  });

  it("a scene's own parameter list spans lines", () => {
    const parsed = parse(
      [
        `scene S(`,
        `    width: 4,`,
        `    height: 2,`,
        `)`,
        `layer a z: 1`,
        `    fill "."`,
      ].join("\n"),
      "l8.qbsk",
    );
    expect(parsed.errors).toEqual([]);
  });

  it("a genuinely missing parameter name is still an error, not swallowed", () => {
    // Skipping INDENT/DEDENT must not turn the loop into one that accepts anything:
    // the fix removes a false error, it does not remove a true one.
    const parsed = parse(
      [`func add(`, `    a,`, `    1,`, `)`, `    return a`].join("\n"),
      "l8.qbsk",
    );
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]!.message).toMatch(/parameter name/);
  });
});
