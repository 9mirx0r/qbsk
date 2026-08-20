// Every scene-DSL word is a name outside statement position (docs/language.md §15.15).
//
// This file was written for §15.13, which freed NINE of the twenty-six and argued the
// other seventeen could not be freed: `color`, `anchor`, `z` and `visible` each begin a
// statement, so `color = 1` inside a layer would be ambiguous. The argument was sound and
// the premise was false — not one of the four uses `=`. They use a colon. There was no
// ambiguity to protect, and finding that out cost three collisions on `line` in one phase
// plus the asymmetry that `var x` and `var y` compiled and `var z` did not.
//
// The original nine-word tests are kept below as they were written, because a rule that
// covers twenty-six must still do everything the rule for nine did.
//
// Twenty-six of the fifty-one keywords exist only for the scene DSL, and every one was
// unusable as a name in a file that never draws. That is the one finding of the pressure test's
// review that was a preference rather than a defect — no program was wrong because of it —
// but it had already cost something real: `cinematic.qbsk` renamed a parameter `at` to
// `enters` with a global find-and-replace, and six of its comments read "enters most" and
// "enters time t" for a day and a half.
//
// Only the nine that CANNOT begin a statement are freed. `color`, `anchor`, `z` and
// `visible` each have a `case` in the statement dispatch (`parser.ts:566-569`), so freeing
// them would make `color = 1` inside a layer genuinely ambiguous — and that ambiguity is
// where a grammar change earns its regressions. The nine here appear in exactly one
// position each: after a drawing primitive (`at`, `from`, `to`, `style`, `world`) or
// immediately after `on` (`start`, `tick`, `key`, `resize`).
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { runQbsk } from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples");
const NL = "\n";

const FREED = ["at", "from", "to", "style", "world", "start", "tick", "key", "resize"];

/** The seventeen §15.15 adds. Together with FREED they are all twenty-six. */
const LATE = [
  "scene", "layer", "sprite", "box", "border", "line", "text", "tone", "shade",
  "fill", "put", "canvas", "color", "anchor", "z", "visible", "on",
];

const ALL_SCENE_WORDS = [...FREED, ...LATE];

/** The core language. These stay reserved and always will (§17.1). */
const CORE = ["if", "else", "while", "for", "return", "var", "const", "func", "match", "use"];

function out(...lines: string[]): string[] {
  const r = runQbsk(lines.join(NL), "t.qbsk", undefined, { baseDir: EXAMPLES });
  expect(r.error?.message ?? null).toBeNull();
  return r.out;
}

describe("the nine freed words are ordinary names", () => {
  it("takes each one as a variable", () => {
    for (const word of FREED) {
      expect(out(`var ${word} = 7`, `print(str(${word}))`), word).toEqual(["7"]);
    }
  });

  it("takes each one as a function parameter", () => {
    for (const word of FREED) {
      expect(
        out(`func f(${word})`, `    return ${word} * 2`, "print(str(f(21)))"),
        word,
      ).toEqual(["42"]);
    }
  });

  it("takes each one as a function name", () => {
    for (const word of FREED) {
      expect(
        out(`func ${word}(n)`, "    return n + 1", `print(str(${word}(41)))`),
        word,
      ).toEqual(["42"]);
    }
  });

  it("takes each one as a const and reassigns like any other variable", () => {
    for (const word of FREED) {
      expect(out(`var ${word} = 1`, `${word} += 4`, `print(str(${word}))`), word).toEqual(["5"]);
    }
  });

  it("lets the anatomy module's own case work — `state(body, at)`", () => {
    // The collision that started this: a simulation module wanted `at` and could not have
    // it, so `anatomy.qbsk` named the function `state` instead.
    expect(
      out(
        "func region(body, at)",
        "    return body[at]",
        'var b = {"thigh_l": 55}',
        'print(str(region(b, "thigh_l")))',
      ),
    ).toEqual(["55"]);
  });
});

describe("a reserved word still says WHY it cannot be a name", () => {
  // §15.13 asserted this of `color`, which is a name now. The message it was checking is
  // the one that matters and it is still owed — by the twenty-five core keywords, which
  // are the words that actually cannot be names.
  it("names the reservation rather than only reporting a parse failure", () => {
    const r = parse("var return = 1", "t.qbsk");
    expect(r.errors[0]!.message).toContain("reserved keyword");
  });
});

describe("the DSL still means what it meant", () => {
  it("still parses every position the freed words came from", () => {
    const scene = [
      "scene S(width: 12, height: 4)",
      "on start",
      "    print(\"begun\")",
      "on tick(dt)",
      "    print(\"ticked\")",
      "layer l z: 0",
      '    fill "."',
      '    put "x" at (1, 1)',
      "    line (0, 0) to (5, 3) style: stroke",
    ].join(NL);
    expect(parse(scene, "t.qbsk").errors).toEqual([]);
  });

  it("still reads `at` as the keyword when a variable of that name is in scope", () => {
    // The case that would break if freeing the word made the expression parser greedy:
    // `at` is both a live variable and the positional keyword, in the same statement.
    const r = runQbsk(
      [
        "scene S(width: 6, height: 2)",
        "var at = 3",
        "layer l z: 0",
        '    fill "."',
        '    put str(at) at (at, 0)',
      ].join(NL),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error?.message ?? null).toBeNull();
    // The 3 is drawn at column 3, which is only true if both readings held at once.
    expect(r.canvas!.renderText().split(NL)[0]).toBe("...3..");
  });

  it("still reads `world:` as the keyword beside a variable of that name", () => {
    const r = runQbsk(
      [
        "scene S(width: 6, height: 2)",
        "var world = 2",
        "layer l z: 0",
        '    fill "."',
        '    put str(world) world: (world, 0)',
      ].join(NL),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error?.message ?? null).toBeNull();
    expect(r.canvas!.renderText().split(NL)[0]).toBe("..2...");
  });

  it("still refuses an event name that is not one of the four", () => {
    // Freeing `start` must not make `on whenever` legal.
    const r = parse(["scene S(width: 4, height: 2)", "on whenever", '    print("x")'].join(NL), "t.qbsk");
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §15.15 — the other seventeen
// ---------------------------------------------------------------------------

describe("all twenty-six scene words are names outside statement position", () => {
  it("covers exactly the twenty-six the spec counts", () => {
    expect(new Set(ALL_SCENE_WORDS).size).toBe(26);
  });

  it("takes each one as a variable", () => {
    for (const word of ALL_SCENE_WORDS) {
      expect(out(`var ${word} = 7`, `print(str(${word}))`), word).toEqual(["7"]);
    }
  });

  it("takes each one as a function parameter", () => {
    for (const word of ALL_SCENE_WORDS) {
      expect(
        out(`func f(${word})`, `    return ${word} * 2`, "print(str(f(21)))"),
        word,
      ).toEqual(["42"]);
    }
  });

  it("takes each one as a function name and calls it", () => {
    for (const word of ALL_SCENE_WORDS) {
      expect(
        out(`func ${word}(n)`, "    return n + 1", `print(str(${word}(41)))`),
        word,
      ).toEqual(["42"]);
    }
  });

  it("reassigns each one, which is the statement-start case", () => {
    // The only genuinely ambiguous position, settled by one token of lookahead: a scene
    // word followed by `=` or `+=` is a name, because no primitive's syntax continues
    // that way.
    for (const word of ALL_SCENE_WORDS) {
      expect(out(`var ${word} = 1`, `${word} += 4`, `print(str(${word}))`), word).toEqual(["5"]);
    }
  });

  it("indexes and mutates each one as a list at statement start", () => {
    for (const word of ALL_SCENE_WORDS) {
      expect(
        out(`var ${word} = [1, 2]`, `${word}[0] = 9`, `print(str(${word}[0] + ${word}[1]))`),
        word,
      ).toEqual(["11"]);
    }
  });

  it("takes each one as a dict key", () => {
    for (const word of ALL_SCENE_WORDS) {
      expect(out(`var d = {"${word}": 3}`, `print(str(d["${word}"]))`), word).toEqual(["3"]);
    }
  });

  it("takes each one as a MEMBER name after a dot", () => {
    // The second hole of the same kind, found the same way as the `for` one: §15.15 counts
    // a member name among the positions where a scene word is a name, and the site was
    // still asking for an IDENTIFIER — so `log.visible(x)` reported while `var visible = 1`
    // compiled. Found writing G5's combat log, whose accessor is called `visible`.
    for (const word of ALL_SCENE_WORDS) {
      expect(
        out(`use "lib/for-names.qbsk" as m`, `print(str(m.${word}()))`),
        word,
      ).toEqual(["7"]);
    }
  });

  it("takes each one as a for-loop variable", () => {
    for (const word of ALL_SCENE_WORDS) {
      expect(
        out(`var total = 0`, `for ${word} in [1, 2, 3]`, `    total += ${word}`, "print(str(total))"),
        word,
      ).toEqual(["6"]);
    }
  });

  it("frees `z` beside `x` and `y`, which is the asymmetry that made the case", () => {
    expect(out("var x = 1", "var y = 2", "var z = 3", "print(str(x + y + z))")).toEqual(["6"]);
  });

  it("leaves the twenty-five core keywords exactly as reserved as they were", () => {
    for (const word of CORE) {
      const r = parse(`var ${word} = 1`, "t.qbsk");
      expect(r.errors.length, word).toBeGreaterThan(0);
    }
  });
});

describe("the DSL keeps every diagnostic it had", () => {
  it("still refuses an event name that is not one of the four", () => {
    const r = parse(
      ["scene S(width: 4, height: 2)", "on whenever", '    print("x")'].join(NL),
      "t.qbsk",
    );
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("still reports a bare `anchor:` as belonging on the primitive it positions", () => {
    const r = parse(
      ["scene S(width: 4, height: 2)", "layer l z: 0", "    anchor: center"].join(NL),
      "t.qbsk",
    );
    expect(r.errors[0]!.message).toContain("not a layer directive");
  });

  it("still asks `color` for at least one key", () => {
    const r = parse(
      ["scene S(width: 4, height: 2)", "layer l z: 0", "    color"].join(NL),
      "t.qbsk",
    );
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("reads the directive and the variable of the same name in one scene", () => {
    // `z` is a live variable AND the layer directive, three tokens apart. Both readings
    // have to hold at once or one of them is not a reading.
    const r = runQbsk(
      [
        "scene S(width: 6, height: 2)",
        "var z = 3",
        "layer l z: 0",
        '    fill "."',
        "    put str(z) at (z, 0)",
      ].join(NL),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error?.message ?? null).toBeNull();
    expect(r.canvas!.renderText().split(NL)[0]).toBe("...3..");
  });

  it("draws a line from a variable called line", () => {
    const r = runQbsk(
      [
        "scene S(width: 6, height: 3)",
        "var line = 1",
        "layer l z: 0",
        '    fill "."',
        "    line (0, line) to (5, line) style: stroke",
      ].join(NL),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error?.message ?? null).toBeNull();
    expect(r.canvas!.renderText().split(NL)[1]).not.toBe("......");
  });
});

describe("the `use` alias is a name position too (§2.6, §15.15)", () => {
  // The FOURTH hole of the same kind, after `parseFor` binding the literal string "null"
  // and member names after a dot. §2.6 named the `use` alias among the positions a scene
  // word may occupy and `parser.ts` still demanded an IDENTIFIER, so the spec promised
  // something the parser refused.
  //
  // Found by enumerating every `expect("IDENTIFIER"` in the parser rather than by tripping
  // over it, which is what should have happened after the first one. The enumeration is
  // complete: the only sites left are type annotations and style names, and both are
  // closed vocabularies rather than name positions.
  it("takes every scene word as a module alias, and calls through it", () => {
    for (const word of ALL_SCENE_WORDS) {
      expect(
        out(`use "lib/for-names.qbsk" as ${word}`, `print(str(${word}.at()))`),
        word,
      ).toEqual(["7"]);
    }
  });

  it("binds the alias to its own spelling, not to the string \"null\"", () => {
    // The trap `parseFor` fell into: widening the slot without widening how the name is
    // READ binds a keyword token's absent `value`.
    expect(out('use "lib/for-names.qbsk" as line', "print(str(line.line()))")).toEqual(["7"]);
  });

  it("still refuses a core keyword there, and says why", () => {
    const r = parse('use "lib/for-names.qbsk" as return', "t.qbsk");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]!.message).toContain("reserved keyword");
  });
});
