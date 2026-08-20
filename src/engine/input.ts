// The terminal key decoder (docs/engine.md §8).
//
// Bytes on stdin become the canonical names of `keys.ts` — THE SAME names the Studio
// window produces. A scene that works in one host and not the other is worse than one
// that works in neither, which is why the vocabulary lives in one file and both hosts
// decode into it rather than each inventing its own spelling.
//
// A decoder rather than a `chunk.toString()` switch because `\x1b[A` can arrive split
// across two `data` events. Decoding per chunk turns one arrow press into three keys —
// `escape`, `[`, `A` — which is the bug this class exists to make impossible.

import { QUEUE_LIMIT } from "./keys.js";

/** Re-exported so the cap has one definition and the spec has one number. */
export const KEY_QUEUE_MAX = QUEUE_LIMIT;

/** Complete escape sequences this decoder knows. */
const SEQUENCES = new Map<string, string>([
  ["[A", "arrow-up"],
  ["[B", "arrow-down"],
  ["[C", "arrow-right"],
  ["[D", "arrow-left"],
  ["[H", "home"],
  ["[F", "end"],
  ["OA", "arrow-up"],
  ["OB", "arrow-down"],
  ["OC", "arrow-right"],
  ["OD", "arrow-left"],
  ["OH", "home"],
  ["OF", "end"],
]);

/** Single control bytes with a name. */
const CONTROLS = new Map<number, string>([
  [0x03, "ctrl-c"],
  [0x08, "backspace"],
  [0x09, "tab"],
  [0x0a, "enter"],
  [0x0d, "enter"],
  [0x7f, "backspace"],
]);

/** The longest escape body worth waiting for before giving up on it. */
const MAX_SEQUENCE = 12;

export class KeyDecoder {
  /** Bytes seen but not yet resolved into a key. */
  private pending = "";

  /**
   * Feeds a chunk and returns the keys it completed.
   *
   * A partial escape stays in `pending` and comes out on a later push or on `flush`;
   * it is never guessed at.
   */
  push(chunk: Buffer): string[] {
    this.pending += chunk.toString("utf8");
    return this.drain(false);
  }

  /**
   * Resolves whatever is left when the stream goes quiet.
   *
   * This is what makes a lone `\x1b` become `escape`: while more bytes might still
   * arrive it could be the start of an arrow, so it waits. Called on an idle tick.
   */
  flush(): string[] {
    return this.drain(true);
  }

  private drain(atEnd: boolean): string[] {
    const out: string[] = [];
    while (this.pending.length > 0) {
      const ch = this.pending[0]!;
      const code = ch.codePointAt(0)!;

      if (code === 0x1b) {
        const rest = this.pending.slice(1);
        if (rest.length === 0) {
          // Could still become an arrow. Only the end of the stream settles it.
          if (atEnd) {
            out.push("escape");
            this.pending = "";
          }
          return out;
        }
        const consumed = this.escapeAt(rest, atEnd, out);
        if (consumed === null) {
          return out;
        }
        this.pending = this.pending.slice(1 + consumed);
        continue;
      }

      this.pending = this.pending.slice(ch.length);
      const control = CONTROLS.get(code);
      if (control !== undefined) {
        out.push(control);
        continue;
      }
      // A NUL and the other unnamed control bytes are not keys. Emitting them as
      // characters would put unprintable text into an input line.
      if (code < 0x20 || code === 0x7f) {
        continue;
      }
      // The space bar has a NAME, matching `keyFromDom` — a scene binding `space`
      // must work in both hosts, and " " as a key name is easy to write wrong.
      out.push(code === 0x20 ? "space" : ch);
    }
    return out;
  }

  /**
   * Resolves the body of an escape sequence.
   *
   * Returns how many characters after the `\x1b` were consumed, or null when more
   * bytes are needed. A body that grows past `MAX_SEQUENCE` without matching is
   * DROPPED rather than spelled out: a terminal sends plenty this does not know, and
   * emitting `[`, `2`, `~` as three keys is worse than silence.
   */
  private escapeAt(rest: string, atEnd: boolean, out: string[]): number | null {
    // A second escape means the first one was the key.
    if (rest[0] === "\x1b") {
      out.push("escape");
      return 0;
    }
    if (rest[0] !== "[" && rest[0] !== "O") {
      // Cannot be a sequence this decoder knows, so the escape stood alone and
      // whatever follows is the next key.
      out.push("escape");
      return 0;
    }
    for (let length = 2; length <= Math.min(rest.length, MAX_SEQUENCE); length += 1) {
      const body = rest.slice(0, length);
      const name = SEQUENCES.get(body);
      if (name !== undefined) {
        out.push(name);
        return length;
      }
      // A final byte in the CSI range ends an unknown sequence: consume and drop it.
      const last = body[body.length - 1]!;
      if (length > 2 && last >= "@" && last <= "~") {
        return length;
      }
    }
    if (rest.length >= MAX_SEQUENCE || atEnd) {
      return rest.length;
    }
    return null;
  }
}
