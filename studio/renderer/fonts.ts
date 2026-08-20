// The project font registry (docs/studio.md §14).
//
// Every metric here was READ OUT OF THE FONT FILE (head.unitsPerEm and the hmtx
// advance width), not estimated. That matters: the first version of play mode used
// a single 0.6 constant, and Unifont — the default — is actually 0.5, so the fit
// under-estimated how much would fit and picked a smaller size than it could.
//
// Pure data + types. No DOM, so it is unit-testable headless.

export interface FontChoice {
  /** Stable id, persisted in settings. Never rename one in place. */
  id: string;
  label: string;
  /** CSS family name, matching the @font-face in styles.css. */
  family: string;
  /** File under font/, copied next to the renderer at build time. */
  file: string;
  /**
   * Advance width of one cell in em units — measured, not guessed. Play mode needs
   * it to know how many columns fit in a given width.
   */
  chPerEm: number;
  /**
   * Pixel grid the font is drawn on, or 0 for an outline font that scales freely.
   * Bitmap-derived faces are crisp only at multiples of this.
   */
  pixelGrid: number;
  /** One line the settings panel shows, so the choice is informed. */
  note: string;
  /** Upstream licence, recorded in font/LICENSE.md. */
  licence: string;
}

export const FONTS: FontChoice[] = [
  {
    id: "unifont",
    label: "GNU Unifont",
    family: "QBSK Unifont",
    file: "unifont-17.0.05.otf",
    chPerEm: 0.5,
    pixelGrid: 8,
    note: "Whole-BMP coverage in one hand. Bitmap: crispest at 16px and multiples of 8.",
    licence: "SIL OFL 1.1",
  },
  {
    id: "iosevka",
    label: "Iosevka",
    family: "QBSK Iosevka",
    file: "Iosevka-Regular.ttf",
    chPerEm: 0.5,
    pixelGrid: 0,
    note: "Narrow, so more columns fit the same width. Box-drawing built for terminals.",
    licence: "SIL OFL 1.1",
  },
  {
    id: "jetbrains",
    label: "JetBrains Mono",
    family: "QBSK JetBrains Mono",
    file: "JetBrainsMono-Regular.ttf",
    chPerEm: 0.6,
    pixelGrid: 0,
    note: "High legibility, forgiving on poor displays. Wider than Iosevka.",
    licence: "SIL OFL 1.1",
  },
  {
    id: "plex",
    label: "IBM Plex Mono",
    family: "QBSK IBM Plex Mono",
    file: "IBMPlexMono-Regular.ttf",
    chPerEm: 0.6,
    pixelGrid: 0,
    note: "More editorial in tone; same cell width as JetBrains Mono.",
    licence: "SIL OFL 1.1",
  },
];

export const DEFAULT_FONT_ID = "unifont";

export function fontById(id: string): FontChoice {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]!;
}
