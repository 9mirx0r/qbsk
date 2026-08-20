// The window half of the session mirror (docs/studio.md §12.4).
//
// Pure: Node builtins and ../mcp/journal only, never "electron". The Electron
// wiring lives in index.ts — this module just turns "the journal grew" into a
// stream of records, so it can be tested headless.
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { MirrorRecord } from "../mcp/journal.js";
import { parseRecords } from "../mcp/journal.js";

/**
 * Follows an append-only journal from a byte offset. READ ONLY, by construction:
 * this class has no method that writes, so the window cannot reach the agent's
 * session through it. That is the §12.2 boundary, expressed in code rather than
 * in a comment.
 */
export class MirrorReader {
  private offset = 0;
  private lastSize = -1;

  constructor(private readonly path: string) {}

  get file(): string {
    return this.path;
  }

  /** True once the session has created its journal. */
  exists(): boolean {
    return existsSync(this.path);
  }

  /**
   * Returns whatever was appended since the previous call. If the file shrank the
   * session restarted (the writer truncates on reset), so we rewind and re-read
   * from the top rather than emitting garbage from a stale offset.
   */
  read(): MirrorRecord[] {
    if (!existsSync(this.path)) {
      this.offset = 0;
      this.lastSize = -1;
      return [];
    }
    const size = statSync(this.path).size;
    if (size < this.offset) {
      this.offset = 0;
    }
    if (size === this.offset) {
      this.lastSize = size;
      return [];
    }
    const length = size - this.offset;
    const buf = Buffer.allocUnsafe(length);
    const fd = openSync(this.path, "r");
    let read: number;
    try {
      read = readSync(fd, buf, 0, length, this.offset);
    } finally {
      closeSync(fd);
    }
    const chunk = buf.subarray(0, read).toString("utf8");
    // Only advance past whole lines: a torn trailing line is re-read next time.
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline < 0) {
      return [];
    }
    this.offset += Buffer.byteLength(chunk.slice(0, lastNewline + 1), "utf8");
    this.lastSize = size;
    return parseRecords(chunk.slice(0, lastNewline + 1));
  }
}

/**
 * The poll-loop state the window's mirror watch needs, kept pure so it is testable
 * headless (docs/studio.md §12.4: "If the journal disappears or ends, the window
 * reports it in the status bar rather than freezing on a stale frame").
 *
 * `read()` alone cannot distinguish "no session yet" from "the session ended": a
 * vanished journal returns the same empty list either way. This watcher remembers
 * whether a session was ever seen, and when one was and the journal is gone, it
 * reports the end — once — instead of leaving the window on a stale "live" frame.
 */
export class SessionWatcher {
  private sawSession = false;
  private goneReported = false;

  constructor(private readonly reader: MirrorReader) {}

  /**
   * Returns the records to forward. A vanished journal yields a synthetic `end`
   * record (seq 0, never part of the journal itself) so the renderer's existing
   * end handling fires; every 80 ms poll after that returns nothing until a new
   * session's reset record arrives. `read()` is still called while the journal is
   * gone: it rewinds the byte offset, so when a NEW session recreates the file
   * the reader starts from the top instead of parsing a stale position.
   */
  poll(): MirrorRecord[] {
    if (this.sawSession && !this.reader.exists()) {
      this.reader.read();
      if (!this.goneReported) {
        this.goneReported = true;
        return [{ t: "end", seq: 0 }];
      }
      return [];
    }
    const records = this.reader.read();
    if (records.length > 0) {
      this.sawSession = true;
      this.goneReported = false;
    }
    return records;
  }
}
