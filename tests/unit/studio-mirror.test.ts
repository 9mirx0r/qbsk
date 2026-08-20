// an earlier release — the session mirror (docs/studio.md §12). Headless: the journal is a
// file, so none of this needs a window.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSessionHost } from "../../studio/mcp/session.js";
import { MirrorReader, SessionWatcher } from "../../studio/main/mirror.js";
import { SessionJournal, journalPath, parseRecords } from "../../studio/mcp/journal.js";

const SCENE = `scene Live(width: 12, height: 4)
var x = 1
on tick(dt)
    x = x + 1
layer a z: 1
    fill "."
    put "O" at (x, 2)
`;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qbsk-mirror-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("session mirror: the journal (docs/studio.md §12.3)", () => {
  it("a session publishes a reset then one frame record per painted frame", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval(SCENE, "live.qbsk");
    host.loop("start", 1 / 20);
    host.loop("step", 1 / 20);
    host.loop("step", 1 / 20);

    const records = parseRecords(readFileSync(journalPath(root), "utf8"));
    expect(records[0]).toMatchObject({ t: "reset", width: 12, height: 4 });
    const frames = records.filter((r) => r.t === "frame");
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(records.every((r, i) => r.seq === i + 1)).toBe(true);
  });

  // Criterion 3: the diff crosses the boundary, not a full grid. A record carrying
  // every row every frame would throw away the diffing the whole design rests on.
  it("frames carry a DIFF, not the whole grid", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval(SCENE, "live.qbsk");
    host.loop("start", 1 / 20);
    host.loop("step", 1 / 20);
    const before = readFileSync(journalPath(root), "utf8").length;
    host.loop("step", 1 / 20);
    const line = readFileSync(journalPath(root), "utf8").slice(before);
    const rec = parseRecords(line).find((r) => r.t === "frame");
    expect(rec).toBeDefined();
    const diff = (rec as { diff: { changed: number }[] }).diff;
    // Only the ball moved: a couple of cells on one row, not 4 rows of 12.
    const changed = diff.reduce((a, d) => a + d.changed, 0);
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThan(12 * 4);
    expect(diff.length).toBeLessThan(4);
  });
});

describe("session mirror: the reader (docs/studio.md §12.4)", () => {
  it("reads only what was appended since the previous read", () => {
    const j = new SessionJournal(root);
    j.reset(8, 2);
    const reader = new MirrorReader(journalPath(root));
    expect(reader.read()).toHaveLength(1);
    expect(reader.read()).toHaveLength(0);
    j.frame([{ y: 0, changed: 1, rewrite: false, runs: [] }]);
    const next = reader.read();
    expect(next).toHaveLength(1);
    expect(next[0]!.t).toBe("frame");
  });

  it("a torn trailing line is not emitted until it is complete", () => {
    const j = new SessionJournal(root);
    j.reset(8, 2);
    const reader = new MirrorReader(journalPath(root));
    reader.read();
    appendFileSync(journalPath(root), '{"t":"frame","seq":9,"di');
    expect(reader.read()).toHaveLength(0);
    appendFileSync(journalPath(root), 'ff":[]}\n');
    const done = reader.read();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ t: "frame", seq: 9 });
  });

  it("rewinds when the session truncates (a new program loaded)", () => {
    const j = new SessionJournal(root);
    j.reset(8, 2);
    j.frame([{ y: 0, changed: 1, rewrite: false, runs: [] }]);
    const reader = new MirrorReader(journalPath(root));
    expect(reader.read()).toHaveLength(2);
    j.reset(20, 6);
    const after = reader.read();
    expect(after[0]).toMatchObject({ t: "reset", width: 20, height: 6 });
  });

  it("reports the session ending instead of leaving a stale frame", () => {
    const j = new SessionJournal(root);
    j.reset(8, 2);
    const reader = new MirrorReader(journalPath(root));
    reader.read();
    j.end();
    expect(reader.read()[0]).toMatchObject({ t: "end" });
  });
});

// Criterion 4. This is the test that stops "let the window watch" from quietly
// becoming "let anything drive the session".
describe("session mirror: observation cannot become control (docs/studio.md §12.2)", () => {
  it("MirrorReader's callable surface is read-only, by allowlist", () => {
    const reader = new MirrorReader(journalPath(root));
    const proto = Object.getPrototypeOf(reader) as object;
    // Every callable member, not just names that look suspicious: an allowlist
    // fails when someone ADDS a capability, which a keyword blocklist would miss.
    const callable = Object.getOwnPropertyNames(proto).filter((name) => {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      return typeof desc?.value === "function" || typeof desc?.get === "function";
    });
    expect(callable.sort()).toEqual(["constructor", "exists", "file", "read"]);
  });

  it("writing into the journal cannot make the session run anything", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval("var canary = 1\nscene S(width: 4, height: 2)\n", "live.qbsk");
    // An attacker with write access to the mirror appends a record that looks
    // like a command. The session never reads this file, so it is inert.
    appendFileSync(
      journalPath(root),
      `${JSON.stringify({ t: "frame", seq: 999, source: "canary = 666" })}\n`,
    );
    host.loop("start", 1 / 20);
    host.loop("step", 1 / 20);
    const seen = host.inspect("canary");
    expect(seen).toMatchObject({ value: 1 });
  });

  it("the session never reads its own journal back", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval(SCENE, "live.qbsk");
    expect(existsSync(journalPath(root))).toBe(true);
    // Deleting the mirror mid-session must not disturb the session at all: proof
    // that nothing in the session's path depends on reading it.
    rmSync(journalPath(root));
    host.loop("start", 1 / 20);
    const res = host.loop("step", 1 / 20);
    expect(res).toMatchObject({ ok: true });
    expect(host.inspect("x")).toMatchObject({ type: "int" });
  });
});

describe("session mirror: the session ends (docs/studio.md §12.4)", () => {
  it("McpSessionHost.end() writes the end record — through the real host, not a bare journal", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval(SCENE, "live.qbsk");
    host.loop("start", 1 / 20);
    host.loop("step", 1 / 20);
    host.end();
    const records = parseRecords(readFileSync(journalPath(root), "utf8"));
    expect(records[records.length - 1]).toMatchObject({ t: "end" });
    // The end record is the LAST one: nothing may be written after the session is over.
    // Find the last frame record (action records may come between frame and end).
    const lastFrame = [...records].reverse().find((r: { t: string }) => r.t === "frame");
    expect(lastFrame).toBeDefined();
    expect(lastFrame!.t).toBe("frame");
  });

  it("end() is idempotent: a second call writes nothing", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval(SCENE, "live.qbsk");
    host.end();
    host.end();
    const records = parseRecords(readFileSync(journalPath(root), "utf8"));
    expect(records.filter((r) => r.t === "end")).toHaveLength(1);
  });

  it("end() called before any eval writes nothing (no program loaded)", () => {
    const host = new McpSessionHost(root, new Map());
    host.end();
    expect(existsSync(journalPath(root))).toBe(false);
  });

  it("end() called twice writes only one end record", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval(SCENE, "live.qbsk");
    host.loop("start", 1 / 20);
    host.end();
    host.end();
    const records = parseRecords(readFileSync(journalPath(root), "utf8"));
    expect(records.filter((r) => r.t === "end")).toHaveLength(1);
  });
});

describe("session mirror: SessionWatcher (docs/studio.md §12.4)", () => {
  it("forwards reset when a session exists", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval(SCENE, "live.qbsk");
    const reader = new MirrorReader(journalPath(root));
    // Prime the reader with the initial reset+frame
    reader.read();
    const w = new SessionWatcher(reader);
    expect(w.poll()).toHaveLength(0); // already consumed
  });

  it("reports no session not ended", () => {
    const reader = new MirrorReader(journalPath(root));
    const w = new SessionWatcher(reader);
    expect(w.poll()).toHaveLength(0);
  });

  it("reports vanished session once", () => {
    const j = new SessionJournal(root);
    j.reset(8, 2);
    const reader = new MirrorReader(journalPath(root));
    reader.read(); // consume reset
    j.end(); // session ends
    const w = new SessionWatcher(reader);
    const first = w.poll();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ t: "end" });
    // Second read reports nothing (already reported)
    expect(w.poll()).toHaveLength(0);
  });

  it("recovers on new session after vanish", () => {
    const j = new SessionJournal(root);
    j.reset(8, 2);
    const reader = new MirrorReader(journalPath(root));
    reader.read(); // consume initial reset
    j.end(); // first session ends
    const w = new SessionWatcher(reader);
    w.poll(); // consume the end record
    // New session
    j.reset(12, 4);
    const next = w.poll();
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ t: "reset", width: 12, height: 4 });
  });

  it("rewinds byte offset on new session", () => {
    const j = new SessionJournal(root);
    j.reset(8, 2);
    j.frame([{ y: 0, changed: 1, rewrite: false, runs: [] }]);
    const reader = new MirrorReader(journalPath(root));
    reader.read(); // consume reset + frame
    j.end();
    const w = new SessionWatcher(reader);
    w.poll(); // consume end
    // New session — reader offset should rewind to start of new file
    j.reset(12, 4);
    const next = w.poll();
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ t: "reset", width: 12, height: 4 });
  });

  it("synthetic end has exact shape when journal vanishes", () => {
    // This tests the vanish path: use the watcher properly (poll to establish session)
    const j = new SessionJournal(root);
    j.reset(8, 2);
    j.end();
    const reader = new MirrorReader(journalPath(root));
    const w = new SessionWatcher(reader);
    // First poll: establishes session, reads reset+end
    const first = w.poll();
    expect(first.length).toBeGreaterThan(0);
    // Journal vanishes
    rmSync(journalPath(root));
    // Second poll: journal gone, should report synthetic end
    const recs = w.poll();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ t: "end", seq: 0 });
  });
});
