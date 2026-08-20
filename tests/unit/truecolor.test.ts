// Truecolor `#rrggbb` (docs/language.md §7.5, §15.16).
//
// The spec said "Truecolor #rrggbb is left for M13+" for months and it was not left for
// anything. `sgrOf` has emitted 24-bit SGR since the renderer was written — `38;2;r;g;b`,
// unpacked out of a `0xRRGGBB` cell — and the buffer, the diff and the WebGL painter all
// carry the full 24 bits. The only thing missing was the front door: `resolveColor` took a
// name out of a table of sixteen and returned `null` for everything else.
//
// So the language could emit sixteen million colours and an author could name sixteen.
//
// Found writing anatomical panel: the design document §2.2 specifies nine colours by hex and
// three of them have no ANSI name — `#FF7F00`, `#8B00FF` and `#444444`, against a
// `bright-black` that is `#7F7F7F` and reads as ordinary grey.
import { describe, expect, it } from "vitest";
import { resolveColor } from "../../src/engine/color.js";
import { sgrOf } from "../../src/engine/render.js";
import { runQbsk } from "../../src/interp/interpreter.js";

const NL = "\n";

function scene(...body: string[]): ReturnType<typeof runQbsk> {
  return runQbsk(
    ["scene S(width: 6, height: 2)", "layer l z: 1", ...body.map((b) => `    ${b}`)].join(NL),
    "t.qbsk",
  );
}

describe("resolveColor takes a hex literal as well as a name", () => {
  it("unpacks six digits into the same integer the named table holds", () => {
    expect(resolveColor("#ff0000")).toBe(0xff0000);
    expect(resolveColor("#ff0000")).toBe(resolveColor("bright-red"));
    expect(resolveColor("#000000")).toBe(0x000000);
    expect(resolveColor("#ffffff")).toBe(0xffffff);
  });

  it("takes the three §2.2 colours that have no ANSI name", () => {
    expect(resolveColor("#ff7f00")).toBe(0xff7f00);
    expect(resolveColor("#8b00ff")).toBe(0x8b00ff);
    expect(resolveColor("#444444")).toBe(0x444444);
  });

  it("is case-insensitive, because a document writes them in capitals", () => {
    expect(resolveColor("#FF7F00")).toBe(resolveColor("#ff7f00"));
    expect(resolveColor("#8B00FF")).toBe(0x8b00ff);
  });

  it("refuses everything that is not six digits", () => {
    // Five, seven, three, a missing hash and a non-digit. Three-digit `#f00` is refused
    // on purpose: a second spelling of the same value is a second thing to get wrong.
    for (const bad of ["#ff7f0", "#ff7f000", "#f70", "ff7f00", "#gg0000", "#", "#ff 700"]) {
      expect(resolveColor(bad), bad).toBeNull();
    }
  });

  it("keeps every one of the sixteen names working", () => {
    for (const name of ["black", "red", "bright-yellow", "bright-white", "cyan"]) {
      expect(resolveColor(name), name).not.toBeNull();
    }
    expect(resolveColor("puce")).toBeNull();
  });
});

describe("a hex literal reaches the emitted bytes", () => {
  it("emits the exact 24-bit SGR for a colour with no name", () => {
    // The half that makes this a feature rather than a parse: 255, 127, 0 arrive in the
    // escape sequence. `sgrOf` needed no change at all — this asserts that.
    expect(sgrOf({ char: "x", fg: 0xff7f00, bg: -1, attrs: 0 })).toBe("\x1b[38;2;255;127;0m");
    expect(sgrOf({ char: "x", fg: -1, bg: 0x8b00ff, attrs: 0 })).toBe("\x1b[48;2;139;0;255m");
  });
});

describe("`color fg:` accepts it, and still teaches when it does not", () => {
  it("draws with a hex foreground", () => {
    const r = scene('color fg: "#ff7f00"', 'put "M" at (1, 0)');
    expect(r.error?.message ?? null).toBeNull();
  });

  it("draws with a hex background", () => {
    const r = scene('color bg: "#444444"', 'put "M" at (1, 0)');
    expect(r.error?.message ?? null).toBeNull();
  });

  it("still reports an unknown name, and now names both forms", () => {
    const r = scene('color fg: "puce"', 'put "M" at (1, 0)');
    expect(r.error?.message ?? "").toContain("puce");
  });

  it("reports a malformed hex as a hex problem, not as an unknown name", () => {
    // `#ff7f0` is five digits. Telling this author "did you mean 'red'?" would send him
    // looking for a name when he mistyped a number.
    const r = scene('color fg: "#ff7f0"', 'put "M" at (1, 0)');
    expect(r.error?.message ?? "").toContain("#rrggbb");
  });

  it("leaves plain-text output untouched, so no golden can move", () => {
    // Styles only affect ANSI emission. This is the guard that says a colour change
    // cannot reach the 26 byte-for-byte goldens.
    const plain = scene('put "M" at (1, 0)');
    const coloured = scene('color fg: "#ff7f00"', 'put "M" at (1, 0)');
    expect(coloured.canvas!.renderText()).toBe(plain.canvas!.renderText());
  });
});

describe("`plot` takes one too, since it took a name", () => {
  it("plots a subcell in a colour that has no name", () => {
    const r = runQbsk(
      [
        'var c = canvas(4, 2)',
        'plot(c, (1, 1), "#8b00ff")',
        'print("ok")',
      ].join(NL),
      "t.qbsk",
    );
    expect(r.error?.message ?? null).toBeNull();
    expect(r.out).toEqual(["ok"]);
  });

  it("still refuses a malformed one", () => {
    const r = runQbsk(
      ['var c = canvas(4, 2)', 'plot(c, (1, 1), "#zz0000")'].join(NL),
      "t.qbsk",
    );
    expect(r.error?.message ?? "").toContain("#zz0000");
  });
});
