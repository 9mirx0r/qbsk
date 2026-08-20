// The grid shader and its CRT pass (docs/studio.md §4.2).
//
// One draw call over one full-screen triangle. The fragment shader reads two data
// textures — one texel per cell — plus the glyph atlas and composes the cell itself; the
// CRT effects then run over that composition in the same pass, because a second pass
// would need a framebuffer and this needs none.
//
// WebGL 1 / GLSL ES 1.00 deliberately. WebGL 2 buys nothing here, and WebGL 1 is what
// every Chromium build has — including the software renderer a machine without a usable
// GPU falls back to.

/** Every uniform the fragment shader declares, and the only ones the device may set. */
export const UNIFORMS = [
  "uFg", "uBg", "uAtlas", "uGrid", "uAtlasSlots",
  "uCurve", "uScanline", "uBloom", "uAberration", "uVignette",
] as const;

export type UniformName = (typeof UNIFORMS)[number];

/** How hard each CRT effect is applied. All zero is a plain, exact grid. */
export interface CrtSettings {
  curve: number;
  scanline: number;
  bloom: number;
  aberration: number;
  vignette: number;
}

/** Present, and not so heavy the text stops reading. */
export const CRT_DEFAULT: CrtSettings = {
  curve: 0.06,
  scanline: 0.12,
  bloom: 0.35,
  aberration: 0.35,
  vignette: 0.25,
};

/** Everything off. The grid a screenshot comparison needs, and some readers too. */
export const CRT_OFF: CrtSettings = {
  curve: 0, scanline: 0, bloom: 0, aberration: 0, vignette: 0,
};

/**
 * Every effect at the same fraction of its default strength.
 *
 * DERIVED, not a third table typed out by hand. A middle setting written by hand drifts
 * from the default the moment the default is tuned, and the drift is invisible — the
 * screen still looks like a CRT, just not like half of this one.
 */
export function scaleCrt(base: CrtSettings, factor: number): CrtSettings {
  return {
    curve: base.curve * factor,
    scanline: base.scanline * factor,
    bloom: base.bloom * factor,
    aberration: base.aberration * factor,
    vignette: base.vignette * factor,
  };
}

/** The CRT present but quiet, for a long read on a screen that still has to be a screen. */
export const CRT_SOFT: CrtSettings = scaleCrt(CRT_DEFAULT, 0.45);

export interface CrtPreset {
  id: string;
  label: string;
  settings: CrtSettings;
}

/**
 * What the settings dialog offers (docs/studio.md §4.2).
 *
 * F3 shipped `CRT_DEFAULT` and `CRT_OFF` and wired neither to anything, so the look was
 * whatever the constant said and turning it off meant editing the source. `CRT_OFF`
 * exists for a reader who cannot look at a curved, scanlined grid — leaving it
 * unreachable turned an accessibility affordance into a comment.
 */
export const CRT_PRESETS: readonly CrtPreset[] = [
  { id: "crt", label: "CRT", settings: CRT_DEFAULT },
  { id: "soft", label: "CRT, soft", settings: CRT_SOFT },
  { id: "off", label: "Off — exact grid", settings: CRT_OFF },
];

/**
 * The settings for a stored preset id, or the default look if it names nothing.
 *
 * The id arrives from `localStorage`, which outlives any list written here: a reader who
 * chose a preset that has since been renamed must get a working screen rather than a
 * blank one. Falling back to the default is the conservative direction — it is the look
 * that shipped before this control existed.
 */
export function crtById(id: string | null): CrtSettings {
  const found = CRT_PRESETS.find((preset) => preset.id === id);
  return found === undefined ? CRT_DEFAULT : found.settings;
}

export const VERTEX_SOURCE = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const FRAGMENT_SOURCE = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uFg;
uniform sampler2D uBg;
uniform sampler2D uAtlas;
uniform vec2 uGrid;
uniform vec2 uAtlasSlots;

uniform float uCurve;
uniform float uScanline;
uniform float uBloom;
uniform float uAberration;
uniform float uVignette;

// Composes one cell: background, glyph, and the two attribute flags.
//
// The slot arrives split across both alphas — more than 256 glyphs do not fit in one
// byte, and braille alone is 256 — so it is reassembled here. The alphas are 0..1 floats,
// hence the *255.0 and the rounding: reading them raw indexes slot 0 for everything.
vec3 cellAt(vec2 uv) {
  vec2 g = uv * uGrid;
  vec2 cellIndex = floor(g);
  vec2 inCell = fract(g);
  vec2 texel = (cellIndex + 0.5) / uGrid;

  vec4 fgTex = texture2D(uFg, texel);
  vec4 bgTex = texture2D(uBg, texel);

  float low = floor(fgTex.a * 255.0 + 0.5);
  float packed = floor(bgTex.a * 255.0 + 0.5);
  float high = mod(packed, 16.0);
  float slot = high * 256.0 + low;
  float bold = step(16.0, mod(packed, 32.0));
  float underline = step(32.0, packed);

  vec2 slotIndex = vec2(mod(slot, uAtlasSlots.x), floor(slot / uAtlasSlots.x));
  // Clamped off the slot edge: a linear filter at the seam bleeds the neighbouring glyph
  // in, which reads as a smear on every character rather than as a filter setting.
  vec2 inSlot = clamp(inCell, vec2(0.004), vec2(0.996));
  float ink = texture2D(uAtlas, (slotIndex + inSlot) / uAtlasSlots).r;

  // Bold thickens by sampling once more a little to the side and keeping the stronger of
  // the two. A real weight is a second atlas, and a second atlas is a second
  // rasterisation of everything for one attribute.
  vec2 offSlot = clamp(inSlot + vec2(0.06, 0.0), vec2(0.004), vec2(0.996));
  float thick = texture2D(uAtlas, (slotIndex + offSlot) / uAtlasSlots).r;
  ink = mix(ink, max(ink, thick), bold);

  // The underline is drawn here rather than into the atlas, so it does not cost a slot
  // per underlined character.
  ink = max(ink, underline * step(0.86, inCell.y) * step(inCell.y, 0.94));

  return mix(bgTex.rgb, fgTex.rgb, ink);
}

void main() {
  vec2 uv = vUv;

  // Barrel curvature: the tube bulges toward the viewer, so the sampled point moves
  // outward with the square of its distance from centre.
  vec2 centred = uv * 2.0 - 1.0;
  float r2 = dot(centred, centred);
  uv = (centred * (1.0 + uCurve * r2)) * 0.5 + 0.5;

  // Off the tube is black, not clamped. Clamping smears the edge row across the bezel,
  // which reads as a rendering bug rather than as a screen.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Chromatic aberration: the three guns converge only at the centre of the tube, so the
  // split grows outward from it exactly as the curvature does.
  vec2 split = centred * uAberration * 0.0016 * r2;
  vec3 colour = vec3(
    cellAt(clamp(uv + split, 0.0, 1.0)).r,
    cellAt(uv).g,
    cellAt(clamp(uv - split, 0.0, 1.0)).b
  );

  // Phosphor bloom: light spills into the neighbours. Four taps rather than a gaussian —
  // at one cell wide the difference is invisible and the cost is not.
  if (uBloom > 0.0) {
    vec2 spread = 1.0 / (uGrid * 8.0);
    vec3 spill = cellAt(clamp(uv + vec2(spread.x, 0.0), 0.0, 1.0))
      + cellAt(clamp(uv - vec2(spread.x, 0.0), 0.0, 1.0))
      + cellAt(clamp(uv + vec2(0.0, spread.y), 0.0, 1.0))
      + cellAt(clamp(uv - vec2(0.0, spread.y), 0.0, 1.0));
    colour += spill * 0.25 * uBloom;
  }

  // Scanlines, one dark band per CELL ROW rather than per pixel: a per-pixel line at a
  // 32-pixel cell is a moire pattern, not a scanline.
  float band = sin(uv.y * uGrid.y * 3.14159265);
  colour *= 1.0 - uScanline * band * band;

  // Vignette, from the same r2 as everything else, so the three edge effects agree about
  // where the edge is.
  colour *= 1.0 - uVignette * r2 * 0.5;

  gl_FragColor = vec4(colour, 1.0);
}
`;
