// L4 — bitwise + seeded RNG (docs/language.md §6.4, §6.5).
//
// The acceptance test of the phase is at the bottom: mulberry32 WRITTEN IN QBSK
// produces the same stream as the rng() native for the same seed — proving the
// bitwise semantics are the host's semantics, bit for bit.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "../../src/parser/parser.js";
import { runQbsk } from "../../src/interp/interpreter.js";
import { mulberry32 } from "../../src/util/random.js";

const run = (source: string) => runQbsk(source, "l4.qbsk");

// ---------------------------------------------------------------------------
// §6.4 — bitwise operators
// ---------------------------------------------------------------------------

describe("bitwise operators (docs/language.md §6.4)", () => {
  it("and, or, xor, shifts", () => {
    const result = run(
      [
        `print(str(12 & 10))`,
        `print(str(12 | 10))`,
        `print(str(12 ^ 10))`,
        `print(str(1 << 4))`,
        `print(str(64 >> 3))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["8", "14", "6", "16", "8"]);
  });

  it("32-bit two's complement: results wrap like the host's", () => {
    const result = run(
      [
        `print(str(1 << 31))`,
        `print(str(-8 >> 1))`,
        `print(str((3 << 30) & -1))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual([
      String(1 << 31),
      String(-8 >> 1),
      String((3 << 30) & -1),
    ]);
  });

  it("precedence: comparisons are looser than &, arithmetic tighter", () => {
    const result = run(
      [
        `print(str(5 & 3 == 1))`,
        `print(str(1 + 2 & 3))`,
        `print(str(1 | 2 ^ 3 & 5))`,
        `print(str(1 << 2 + 1))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual([
      String((5 & 3) === 1),           // (5 & 3) == 1 -> true
      String((1 + 2) & 3),             // 3 & 3 -> 3
      String(1 | (2 ^ (3 & 5))),       // & tighter than ^ tighter than |
      String(1 << (2 + 1)),            // + tighter than << -> 8
    ]);
  });

  it("floats are refused with the fix in the message", () => {
    const result = run(`print(str(2.5 & 1))`);
    expect(result.error).not.toBeNull();
    expect(result.error!.message).toMatch(/int/);
    expect(result.error!.message).toMatch(/int\(/);
  });

  it("bools do not coerce", () => {
    const result = run(`print(str(true & 1))`);
    expect(result.error).not.toBeNull();
  });

  it("'or' and 'and' keywords are untouched (logical, short-circuit)", () => {
    const result = run(
      [
        `print(str(12 and 10))`,
        `print(str(false or 7))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["10", "7"]);
  });
});

// ---------------------------------------------------------------------------
// §6.5 — seeded RNG natives
// ---------------------------------------------------------------------------

describe("rng / roll_float / roll_int (docs/language.md §6.5)", () => {
  it("same seed, same stream — across separate interpreters", () => {
    const program = [
      `var r = rng(1337)`,
      `print(str(roll_float(r)))`,
      `print(str(roll_float(r)))`,
      `print(str(roll_int(r, 0, 100)))`,
    ].join("\n");
    const a = run(program);
    const b = run(program);
    expect(a.error).toBeNull();
    expect(a.out).toEqual(b.out);
  });

  it("matches the host's mulberry32 exactly", () => {
    const host = mulberry32(42);
    const expected = [host(), host(), host()];
    const result = run(
      [
        `var r = rng(42)`,
        `print(str(roll_float(r)))`,
        `print(str(roll_float(r)))`,
        `print(str(roll_float(r)))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    // qbskStr prints whole floats as N.0; these are never whole in practice.
    expect(result.out.map(Number)).toEqual(expected);
  });

  it("roll_int is in [lo, hi) and integer", () => {
    const result = run(
      [
        `var r = rng(7)`,
        `var ok = true`,
        `for i in 0..200`,
        `    var n = roll_int(r, 3, 9)`,
        `    if n < 3 or n >= 9`,
        `        ok = false`,
        `print(str(ok))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["true"]);
  });

  it("two generators with the same seed are independent streams", () => {
    const result = run(
      [
        `var a = rng(5)`,
        `var b = rng(5)`,
        `var x = roll_float(a)`,
        `var y = roll_float(b)`,
        `print(str(x == y))`,
      ].join("\n"),
    );
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["true"]);
  });

  it("errors: non-int seed, lo >= hi, rolling a non-generator", () => {
    const seed = run(`rng(1.5)`);
    expect(seed.error).not.toBeNull();
    expect(seed.error!.message).toMatch(/int/);

    const bounds = run(`roll_int(rng(1), 5, 5)`);
    expect(bounds.error).not.toBeNull();
    expect(bounds.error!.message).toMatch(/lo/);

    const notRng = run(`roll_float(42)`);
    expect(notRng.error).not.toBeNull();
    expect(notRng.error!.message).toMatch(/generator|rng/);
  });
});

// ---------------------------------------------------------------------------
// The acceptance test: mulberry32 in pure QBSK equals rng()
// ---------------------------------------------------------------------------

describe("mulberry32 is writable in QBSK (the phase's acceptance test)", () => {
  it("a pure-QBSK mulberry32 matches rng(seed) for 20 rolls", () => {
    // Mirrors src/util/random.ts line by line. `imul` is (a * b) truncated to
    // 32 bits — QBSK ints are doubles, so the multiply is decomposed into
    // 16-bit halves to stay exact, using only language-level ops.
    const program = [
      `var state = 99`,
      ``,
      `func imul(a, b)`,
      `    var ah = (a >> 16) & 65535`,
      `    var al = a & 65535`,
      `    var bh = (b >> 16) & 65535`,
      `    var bl = b & 65535`,
      `    return ((al * bl) + (((ah * bl + al * bh) << 16) | 0)) | 0`,
      ``,
      `func next()`,
      `    state = (state + 1831565813) | 0`,
      `    var t = state`,
      `    t = imul(t ^ ((t >> 15) & 131071), t | 1)`,
      `    t = t ^ ((t + imul(t ^ ((t >> 7) & 33554431), t | 61)) | 0)`,
      `    var u = t ^ ((t >> 14) & 262143)`,
      `    if u < 0`,
      `        return (u + 4294967296) / 4294967296.0`,
      `    return u / 4294967296.0`,
      ``,
      `var stream = rng(99)`,
      `var same = true`,
      `for i in 0..20`,
      `    if next() != roll_float(stream)`,
      `        same = false`,
      `print(str(same))`,
    ].join("\n");
    const result = run(program);
    expect(result.error).toBeNull();
    expect(result.out).toEqual(["true"]);
  });
});

// ---------------------------------------------------------------------------
// Parser: the tokens exist and print in the AST
// ---------------------------------------------------------------------------

describe("bitwise parses into the AST", () => {
  it("all five operators parse without errors", () => {
    const parsed = parse(
      `var x = (1 | 2) ^ (3 & 4) << (5 >> 1)`,
      "l4.qbsk",
    );
    expect(parsed.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RULE #5: examples/caves.qbsk — deterministic worldgen in pure QBSK
// ---------------------------------------------------------------------------

describe("examples/caves.qbsk (the demo the phase exists for)", () => {
  it("composes byte-for-byte against its golden — same seed, same cave", () => {
    const source = readFileSync(
      new URL("../../examples/caves.qbsk", import.meta.url),
      "utf8",
    );
    const golden = readFileSync(
      new URL("../golden/caves.qbsk.out", import.meta.url),
      "utf8",
    );
    const r = runQbsk(source, "caves.qbsk");
    expect(r.error).toBeNull();
    expect(r.out.join("\n") + "\n").toBe(golden.replace(/\r\n/g, "\n"));
  });
});
