// The session mirror (docs/studio.md §12): the MCP session WRITES frames here and
// the window READS them. There is deliberately no path in the other direction — the
// session never reads this file, so an observer can learn what was drawn and can
// never make anything run. Control stays on stdio, one client, as §11.2 requires.
//
// Pure: Node builtins and ../../src only. Never "electron".
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiffLine } from "../../src/engine/diff.js";

export const JOURNAL_DIR = ".qbsk-studio";
export const JOURNAL_FILE = "session.ndjson";

export function journalPath(root: string): string {
  return join(root, JOURNAL_DIR, JOURNAL_FILE);
}

export type MirrorRecord =
  | { t: "reset"; seq: number; width: number; height: number }
  | { t: "frame"; seq: number; diff: DiffLine[] }
  | { t: "end"; seq: number }
  | { t: "action"; seq: number; tool: string; args: unknown; result: "ok" | "error" };

/**
 * Append-only writer. Every failure is swallowed on purpose: the mirror is an
 * observation convenience, and a full disk or a locked file must never take down
 * the agent's session. A window that stops receiving records reports it (§12.4);
 * it does not get to break the thing it is watching.
 */
export class SessionJournal {
  private readonly path: string;
  private seq = 0;
  private live = false;

  constructor(root: string) {
    this.path = journalPath(root);
  }

  get file(): string {
    return this.path;
  }

  /** Truncate and start a new session. Called when a program loads. */
  reset(width: number, height: number): void {
    this.seq = 0;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, "");
      this.live = true;
      this.write({ t: "reset", seq: this.nextSeq(), width, height });
    } catch {
      this.live = false;
    }
  }

  /** One painted frame, as a diff. Never a full grid — see §12.3. */
  frame(diff: DiffLine[]): void {
    if (!this.live) {
      return;
    }
    this.write({ t: "frame", seq: this.nextSeq(), diff });
  }

  /** An agent tool call, for the action stream (docs/studio.md §12.5). */
  action(tool: string, args: unknown, ok: boolean): void {
    if (!this.live) {
      return;
    }
    this.write({ t: "action", seq: this.nextSeq(), tool, args, result: ok ? "ok" : "error" });
  }

  end(): void {
    if (!this.live) {
      return;
    }
    this.write({ t: "end", seq: this.nextSeq() });
    this.live = false;
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private write(record: MirrorRecord): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    } catch {
      this.live = false;
    }
  }
}

/**
 * Reader half, used by the window and by the tests. Stateless about the file: the
 * caller keeps the byte offset, so watching is "read what was appended since last
 * time" rather than re-parsing the whole journal every frame.
 */
export function parseRecords(chunk: string): MirrorRecord[] {
  const out: MirrorRecord[] = [];
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as MirrorRecord);
    } catch {
      // A torn final line: the writer appended while we were reading. Skipping it
      // is correct — the caller's offset stays before it, so it is read again whole.
    }
  }
  return out;
}
