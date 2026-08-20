// Glyph atlas bookkeeping for the WebGL painter (docs/studio.md §4.2).
//
// PURE. Nothing here touches WebGL or a canvas — this file answers "which slot does this
// character live in and where is that slot", and a shader that samples the wrong slot
// draws the wrong letter. That is the part worth testing, and mocking a GL context does
// not test it. Rasterising the glyphs is the caller's job, driven by `takePending`.
//
// Slots are assigned ON FIRST USE rather than from a fixed character list. QBSK's glyph
// vocabulary is open — a `.qbdata` can hold anything, `braille()` generates 256 of them
// (§11.15), and tiles bring more — so a fixed list would be a list that is wrong as soon
// as an author types something not on it.

export interface PendingGlyph {
  char: string;
  slot: number;
}

export class GlyphAtlas {
  private readonly slots = new Map<string, number>();
  private pending: PendingGlyph[] = [];
  private missing = new Set<string>();

  /**
   * @param cols   slots across
   * @param rows   slots down
   * @param cellW  pixels per slot, across
   * @param cellH  pixels per slot, down
   */
  constructor(
    private readonly cols: number,
    private readonly rows: number,
    private readonly cellW = 16,
    private readonly cellH = 32,
  ) {
    // Slot 0 is the space, always, and it is claimed before anything else can take it.
    // The fg and bg textures start as zeroed bytes, which reads as slot 0 for every
    // cell; if slot 0 held whatever character was seen first, a grid would come up tiled
    // with it before a single cell was painted.
    this.slots.set(" ", 0);
  }

  get capacity(): number {
    return this.cols * this.rows;
  }

  get textureWidth(): number {
    return this.cols * this.cellW;
  }

  get textureHeight(): number {
    return this.rows * this.cellH;
  }

  /** Whether any character has been asked for that there was no room to place. */
  get overflowed(): boolean {
    return this.missing.size > 0;
  }

  /** Which characters those were, so a caller can name them rather than hint at them. */
  get overflowedChars(): string[] {
    return [...this.missing];
  }

  /**
   * The slot for `char`, assigning one if this is the first time it is asked for.
   *
   * Returns 0 — the space — when the atlas is full, and records the character in
   * `overflowedChars`. Silence here would be §14's shape exactly: the wrong glyph on
   * screen, no error, and a defect that reaches the author as "sometimes a character is
   * missing". The fallback is the space rather than an arbitrary slot because a blank
   * reads as absence, while a wrong letter reads as a different word.
   */
  slotOf(char: string): number {
    const existing = this.slots.get(char);
    if (existing !== undefined) {
      return existing;
    }
    const slot = this.slots.size;
    if (slot >= this.capacity) {
      this.missing.add(char);
      return 0;
    }
    this.slots.set(char, slot);
    this.pending.push({ char, slot });
    return slot;
  }

  /**
   * The glyphs assigned since the last call, and clears the list.
   *
   * The caller rasterises only these. Redrawing the whole atlas whenever one new glyph
   * appears is how a painter meant to be fast stops being one — and a scene that reveals
   * text one character at a time would do it on every frame.
   */
  takePending(): PendingGlyph[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Top-left pixel of a slot in the atlas texture, counted across then down. */
  pixelOf(slot: number): { x: number; y: number } {
    return {
      x: (slot % this.cols) * this.cellW,
      y: Math.floor(slot / this.cols) * this.cellH,
    };
  }
}
