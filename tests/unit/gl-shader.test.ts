// The shader source and the uniforms the device sets (docs/studio.md §4.2).
//
// A shader cannot be compiled headlessly, so this does not pretend to. What it holds is
// the one failure that costs nothing to make and everything to find: a uniform renamed on
// one side of the boundary. `getUniformLocation` returns null for a name the shader does
// not declare, `uniform1f(null, x)` is a silent no-op in WebGL, and the effect simply
// stops working with no error anywhere.
import { describe, expect, it } from "vitest";
import {
  FRAGMENT_SOURCE, VERTEX_SOURCE, UNIFORMS, CRT_DEFAULT, CRT_OFF,
  CRT_SOFT, CRT_PRESETS, crtById,
} from "../../studio/renderer/glshader.js";

/** Every `uniform <type> <name>;` the fragment shader declares. */
function declared(source: string): string[] {
  return [...source.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]!).sort();
}

describe("the shader and its uniform list agree", () => {
  it("declares exactly the uniforms the device is allowed to set", () => {
    expect(declared(FRAGMENT_SOURCE)).toEqual([...UNIFORMS].sort());
  });

  it("reads every uniform it declares", () => {
    // A declared-but-unread uniform is a knob wired to nothing: the compiler strips it,
    // `getUniformLocation` then returns null, and the setter goes quiet. The same failure
    // as a rename, arrived at from the other side.
    for (const name of UNIFORMS) {
      const uses = [...FRAGMENT_SOURCE.matchAll(new RegExp(name, "g"))].length;
      expect(uses, `${name} is declared but never read`).toBeGreaterThan(1);
    }
  });

  it("passes the varying the vertex shader writes", () => {
    expect(VERTEX_SOURCE).toContain("varying vec2 vUv");
    expect(FRAGMENT_SOURCE).toContain("varying vec2 vUv");
  });

  it("reassembles the glyph slot from both alphas", () => {
    // The packing splits the slot across fg.a and bg.a (glpack.ts). A shader reading only
    // one of them draws a space for every glyph past 255, which braille reaches on its
    // own. The arithmetic has to be present on this side of the boundary too.
    expect(FRAGMENT_SOURCE).toContain("high * 256.0 + low");
  });

  it("rounds the packed alphas instead of reading them raw", () => {
    // An alpha arrives as 0..1. Multiplying by 255 without rounding lands a hair under
    // the integer, `floor` takes it down one, and every glyph is off by one slot — which
    // renders as plausible-looking wrong letters rather than as an obvious failure.
    expect(FRAGMENT_SOURCE).toContain("* 255.0 + 0.5");
  });

  it("offers a settings object that turns every effect off", () => {
    // Not decoration. A screenshot comparison needs the exact grid, and so does a reader
    // who cannot look at a curved, scanlined one.
    for (const value of Object.values(CRT_OFF)) {
      expect(value).toBe(0);
    }
    expect(Object.keys(CRT_OFF).sort()).toEqual(Object.keys(CRT_DEFAULT).sort());
  });

  it("keeps the default look mild enough to read through", () => {
    // the design document §2.1 asks for a CRT, not for a broken monitor. Every effect at full strength
    // makes an ASCII game unreadable, which is a failure even when it is authentic.
    for (const [name, value] of Object.entries(CRT_DEFAULT)) {
      expect(value, name).toBeGreaterThan(0);
      expect(value, name).toBeLessThan(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// The CRT presets a reader can actually choose between.
//
// F3 shipped `CRT_DEFAULT` and `CRT_OFF` and wired neither to anything: the look was
// whatever the constant said, and turning it off meant editing the source. `CRT_OFF`
// exists for a reader who cannot look at a curved, scanlined grid, so leaving it
// unreachable made an accessibility affordance into a comment.
//
// The choosing is here, in ordinary code with ordinary tests. The device does five
// `uniform1f` calls and decides nothing, which is the same seam the rest of F3 uses.
// ---------------------------------------------------------------------------

describe("the CRT presets", () => {
  it("gives every preset a distinct id and a label", () => {
    const ids = CRT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of CRT_PRESETS) {
      expect(preset.label.length, preset.id).toBeGreaterThan(0);
    }
  });

  it("gives every preset a value for every effect", () => {
    // A preset missing a field would leave that uniform at whatever the previous preset
    // set it to, so switching to "off" would leave the bloom on. The comparison is
    // against the settings type's own keys, so adding a sixth effect fails here rather
    // than shipping a preset that only turns five of them off.
    for (const preset of CRT_PRESETS) {
      expect(Object.keys(preset.settings).sort(), preset.id).toEqual(
        Object.keys(CRT_DEFAULT).sort(),
      );
    }
  });

  it("falls back to the default look for an id it does not know", () => {
    // The id arrives from localStorage, which outlives any preset list: a reader who
    // chose "soft" before it was renamed must get a working screen, not a blank one.
    expect(crtById("no-such-preset")).toEqual(CRT_DEFAULT);
    expect(crtById(null)).toEqual(CRT_DEFAULT);
    expect(crtById("")).toEqual(CRT_DEFAULT);
  });

  it("resolves each preset's own id back to its settings", () => {
    for (const preset of CRT_PRESETS) {
      expect(crtById(preset.id), preset.id).toEqual(preset.settings);
    }
  });

  it("puts the soft look strictly between off and the full one", () => {
    // Not a third hand-typed table. A middle setting typed out by hand drifts from the
    // default the moment the default is tuned, and the drift is invisible — it still
    // looks like a CRT, just not like half of this one.
    for (const [name, value] of Object.entries(CRT_SOFT)) {
      const full = CRT_DEFAULT[name as keyof typeof CRT_DEFAULT];
      expect(value, name).toBeGreaterThan(0);
      expect(value, name).toBeLessThan(full);
    }
  });

  it("offers a preset that turns everything off", () => {
    const off = CRT_PRESETS.find((p) => p.settings.curve === 0);
    expect(off, "no preset reaches CRT_OFF").toBeDefined();
    expect(off!.settings).toEqual(CRT_OFF);
  });
});
