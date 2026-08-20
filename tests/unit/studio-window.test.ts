// The window snapshot (docs/studio.md §15).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WindowMirror,
  readWindowSnapshot,
  windowImagePath,
  windowPath,
} from "../../studio/mcp/window.js";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qbsk-window-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WindowMirror publishes what the window painted", () => {
  it("writes a snapshot a reader can pick up", () => {
    const m = new WindowMirror(root);
    m.write(["abc", "def"], "console", false);
    const snap = readWindowSnapshot(root);
    expect(snap).not.toBeNull();
    expect(snap!.text).toEqual(["abc", "def"]);
    expect(snap!.showing).toBe("console");
    expect(snap!.width).toBe(3);
    expect(snap!.height).toBe(2);
  });

  it("the sequence advances so a reader can tell frames apart", () => {
    const m = new WindowMirror(root);
    m.write(["a"], "scene", false);
    const first = readWindowSnapshot(root)!.seq;
    m.write(["b"], "scene", false);
    expect(readWindowSnapshot(root)!.seq).toBe(first + 1);
  });

  // The engine emits nothing when nothing changed; capturing an identical window
  // thirty times a second would be the one place that ignored its own rule.
  it("reports whether the grid CHANGED, which is what gates the capture", () => {
    const m = new WindowMirror(root);
    expect(m.write(["a"], "scene", false)).toBe(true);
    expect(m.write(["a"], "scene", false)).toBe(false);
    expect(m.write(["b"], "scene", false)).toBe(true);
  });

  it("carries the image path only once an image exists", () => {
    const m = new WindowMirror(root);
    m.write(["a"], "scene", false);
    expect(readWindowSnapshot(root)!.image).toBeNull();
    m.write(["b"], "scene", true);
    expect(readWindowSnapshot(root)!.image).toBe(windowImagePath(root));
  });

  it("writes the PNG bytes it is handed", () => {
    const m = new WindowMirror(root);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    m.writeImage(png);
    expect(readFileSync(windowImagePath(root))).toEqual(png);
  });

  it("creates its directory rather than requiring one", () => {
    const m = new WindowMirror(join(root, "deep", "deeper"));
    expect(() => m.write(["a"], "scene", false)).not.toThrow();
    expect(readWindowSnapshot(join(root, "deep", "deeper"))).not.toBeNull();
  });

  // A snapshot is a convenience. A locked file or a full disk must never take down
  // the window the person is actually using — the same rule the session journal has.
  it("a write it cannot perform is swallowed, not thrown", () => {
    const m = new WindowMirror("\0invalid\0path");
    expect(() => m.write(["a"], "scene", false)).not.toThrow();
    expect(() => m.writeImage(Buffer.from([1]))).not.toThrow();
  });
});

describe("readWindowSnapshot", () => {
  it("is null when the window has never published", () => {
    expect(readWindowSnapshot(root)).toBeNull();
  });

  // The file is on disk and anything could have written it. Validated, not trusted.
  it("malformed content reads as no window, never as a crash", () => {
    mkdirSync(join(root, ".qbsk-studio"), { recursive: true });
    writeFileSync(windowPath(root), "not json at all", "utf8");
    expect(readWindowSnapshot(root)).toBeNull();

    writeFileSync(windowPath(root), JSON.stringify({ seq: "x" }), "utf8");
    expect(readWindowSnapshot(root)).toBeNull();

    writeFileSync(windowPath(root), JSON.stringify({ seq: 1, at: 1 }), "utf8");
    expect(readWindowSnapshot(root)).toBeNull();
  });

  // The channel is observation, not control (§15). It carries characters and a path;
  // there is no shape of record that could make anything run.
  it("has no write path — the reader is a function, not an object with methods", () => {
    expect(typeof readWindowSnapshot).toBe("function");
    const m = new WindowMirror(root);
    const surface = Object.getOwnPropertyNames(
      Object.getPrototypeOf(m) as object,
    ).sort();
    // Allowlist rather than blocklist, so ADDING a capability fails this test on
    // purpose — the same discipline MirrorReader is held to in the other direction.
    expect(surface).toEqual(["constructor", "write", "writeImage"].sort());
  });
});
