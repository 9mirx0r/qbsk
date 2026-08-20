// The 16 ANSI names as packed truecolor 0xRRGGBB, plus the `#rrggbb` literal (§7.5).
//
// The names were the only thing an author could write until 2026-08-19, and the note here
// said truecolor was "deferred to M13+". It was not deferred to anything: `sgrOf` has
// emitted 24-bit SGR since the renderer was written, and the buffer, the diff and the
// WebGL painter all carry the full 24 bits. The language could emit sixteen million
// colours and name sixteen. §15.16 records the whole of it.
//
// The 256-colour palette really is deferred, and on purpose: it is a second spelling of
// values `#rrggbb` already reaches.

export const NAMED_COLORS: Record<string, number> = {
  black: 0x000000,
  red: 0xcd0000,
  green: 0x00cd00,
  yellow: 0xcdcd00,
  blue: 0x0000ee,
  magenta: 0xcd00cd,
  cyan: 0x00cdcd,
  white: 0xe5e5e5,
  "bright-black": 0x7f7f7f,
  "bright-red": 0xff0000,
  "bright-green": 0x00ff00,
  "bright-yellow": 0xffff00,
  "bright-blue": 0x5c5cff,
  "bright-magenta": 0xff00ff,
  "bright-cyan": 0x00ffff,
  "bright-white": 0xffffff,
};

const HEX_LITERAL = /^#[0-9a-fA-F]{6}$/;

/** Whether a string is SHAPED like a hex literal, so a caller can say which mistake it is. */
export function looksHex(value: string): boolean {
  return value.startsWith("#");
}

/**
 * A colour name or a `#rrggbb` literal, packed. `null` for anything else.
 *
 * Six digits and no other spelling. `#f70` would be a second way to write a value this
 * already reaches, and a second way to write it is a second way to get it wrong.
 */
export function resolveColor(name: string): number | null {
  const named = NAMED_COLORS[name];
  if (named !== undefined) {
    return named;
  }
  // Case-insensitive because §2.2 of the game design document — the first consumer —
  // writes every one of its nine in capitals.
  return HEX_LITERAL.test(name) ? Number.parseInt(name.slice(1), 16) : null;
}
