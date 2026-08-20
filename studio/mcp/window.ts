// The window snapshot (docs/studio.md §15).
//
// The mirror in §12 runs one way — the MCP session writes frames, the window reads them.
// This is the OPPOSITE direction, and it exists so an agent can see what the window is
// actually showing: its own live scene, its console, whatever the person at the keyboard
// is looking at. Without it the agent is blind to everything it did not draw itself.
//
// It does NOT weaken §12.2. That rule protects one property — an OBSERVER of the agent's
// session must not be able to write into that session — and it is about control flowing
// backwards into a running program. This channel carries a grid of characters and the
// path of an image. Nothing executable crosses it, and it flows towards the controller
// rather than away from it. The two channels are opposites in direction and identical in
// kind: both are observation, neither is control.
//
// Pure: Node builtins only. Never "electron" — the process that captures the PNG passes
// the bytes in, so this file stays unit-testable headless.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const WINDOW_DIR = ".qbsk-studio";
export const WINDOW_FILE = "window.json";
export const WINDOW_IMAGE = "window.png";

export function windowPath(root: string): string {
  return join(root, WINDOW_DIR, WINDOW_FILE);
}

export function windowImagePath(root: string): string {
  return join(root, WINDOW_DIR, WINDOW_IMAGE);
}

export interface WindowSnapshot {
  seq: number;
  /** Epoch milliseconds, so a reader can say how stale this is instead of guessing. */
  at: number;
  width: number;
  height: number;
  /** What the window painted, row by row. For an ASCII app this IS the screen. */
  text: string[];
  /** What the window is showing: the local scene, the console, or a static compose. */
  showing: string;
  /** Absolute path of the PNG, or null when no capture has been written yet. */
  image: string | null;
}

/**
 * Writes what the window is showing, for an agent to read.
 *
 * Every failure is swallowed, exactly like the session journal: a snapshot is a
 * convenience, and a locked file or a full disk must never take down the window that
 * the person is actually using.
 */
export class WindowMirror {
  private readonly path: string;
  private readonly imagePath: string;
  private seq = 0;
  private lastText = "";

  constructor(root: string) {
    this.path = windowPath(root);
    this.imagePath = windowImagePath(root);
  }

  /**
   * Records a painted grid.
   *
   * Returns true when the grid CHANGED, which is the signal to take a fresh PNG. The
   * engine's whole rendering model is "emit nothing when nothing changed", and
   * capturing an identical window thirty times a second would be the one place in this
   * codebase that ignored it.
   */
  write(text: string[], showing: string, hasImage: boolean): boolean {
    const joined = text.join("\n");
    const changed = joined !== this.lastText;
    this.lastText = joined;
    this.seq += 1;
    const snapshot: WindowSnapshot = {
      seq: this.seq,
      at: Date.now(),
      width: text.length === 0 ? 0 : (text[0]?.length ?? 0),
      height: text.length,
      text,
      showing,
      image: hasImage ? this.imagePath : null,
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(snapshot), "utf8");
    } catch {
      // Deliberate: see the class comment.
    }
    return changed;
  }

  /** Writes a captured PNG. The bytes come from the caller, so this file stays pure. */
  writeImage(png: Buffer): void {
    try {
      mkdirSync(dirname(this.imagePath), { recursive: true });
      writeFileSync(this.imagePath, png);
    } catch {
      // Deliberate: see the class comment.
    }
  }
}

/**
 * Reads the last snapshot, or null when the window has never written one.
 *
 * READ-ONLY BY CONSTRUCTION: there is no method here that writes, which is the same
 * shape as `MirrorReader` in the other direction. A reader that could write would turn
 * an observation channel into a control channel.
 */
export function readWindowSnapshot(root: string): WindowSnapshot | null {
  try {
    const raw = readFileSync(windowPath(root), "utf8");
    const parsed = JSON.parse(raw) as WindowSnapshot;
    // Validated rather than trusted: this file is on disk and anything could have
    // written it. A malformed snapshot reads as "no window", never as a crash.
    if (
      typeof parsed.seq !== "number" ||
      typeof parsed.at !== "number" ||
      !Array.isArray(parsed.text)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
