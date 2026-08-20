import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runQbsk } from "../../src/interp/interpreter.js";
import { McpSessionHost } from "../../studio/mcp/session.js";
import { McpServer, type McpTool } from "../../studio/mcp/server.js";
import { buildResources, LIMIT_ROWS } from "../../studio/mcp/generate-manual.js";
import type { InspectResult, KeyResult, LoadResult, McpHost, ToolError } from "../../studio/mcp/types.js";

// An earlier release (docs/studio.md §11): the embedded MCP surface, headless. The same
// McpSessionHost/McpServer classes run inside the Electron main process; here they
// are driven directly and over the raw JSON-RPC wire, with no window and no agent
// copying anything between windows.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const languageDoc = readFileSync(join(root, "docs", "language.md"), "utf8");

// A scene whose bug is an undefined read (enmy vs enemy) — used by the criterion-5
// end-to-end round trip below.
const BUGGY_SCENE = [
  "var enemy = 2",
  "scene Battle(width: 12, height: 4)",
  "  layer l z: 1",
  "    fill \".\"",
  "    put \"H\" at (1, 1)",
  "    put \"E\" at (10, 1)",
  "    put enmy at (0, 0)",
].join("\n");

const FIXED_SCENE = BUGGY_SCENE.replace("enmy", "enemy");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "qbsk-mcp-"));
}

function wire(host: McpHost): { server: McpServer; sent: string[] } {
  const sent: string[] = [];
  const server = new McpServer(host, { send: (m) => sent.push(m) });
  return { server, sent };
}

// Sends one JSON-RPC request over the wire and returns the parsed response object.
function rpc(
  server: McpServer,
  sent: string[],
  method: string,
  params?: unknown,
  id: string | number = 1,
): { result: unknown } | { error: { code: number; message: string } } {
  const before = sent.length;
  const req: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) req.params = params;
  server.handle(JSON.stringify(req));
  expect(sent.length).toBe(before + 1);
  return JSON.parse(sent[sent.length - 1]!) as never;
}

// The tool payload inside a tools/call result.
function toolPayload(
  response: { result: unknown } | { error: { code: number; message: string } },
): unknown {
  if ("error" in response) throw new Error(`unexpected protocol error: ${response.error.message}`);
  const content = (response.result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text);
}

// Narrow an rpc() response to its success arm. `rpc` returns a union, so reading
// `.result` off it directly does not typecheck — and casting the union away would
// throw out the very check that catches a malformed response.
function okResult(
  response: { result: unknown } | { error: { code: number; message: string } },
): unknown {
  if ("error" in response) throw new Error(`unexpected protocol error: ${response.error.message}`);
  return response.result;
}

describe("MCP session host: qbsk_check (docs/studio.md §11.4)", () => {
  it("a clean program reports no problems", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.check("var a = 1\nprint(a + 1)", "t.qbsk");
    expect(res.ok).toBe(true);
    expect(res.clean).toBe(true);
    expect(res.problems).toHaveLength(0);
  });

  // `ok` is the envelope shared by every tool: it means the CALL ran, and it stays
  // true when the source is broken. `clean` is the verdict. An agent that reads `ok`
  // and not `clean` would proceed with broken source, so this pins the distinction.
  it("`clean` is false when problems are found, while `ok` stays true", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.check("print(nope)", "t.qbsk");
    expect(res.ok).toBe(true);
    expect(res.problems.length).toBeGreaterThan(0);
    expect(res.clean).toBe(false);
    expect(res.clean).toBe(res.problems.length === 0);
  });

  it("an undefined read comes back with span, source line and fragment", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.check(BUGGY_SCENE, "t.qbsk");
    expect(res.ok).toBe(true);
    expect(res.problems.length).toBeGreaterThan(0);
    const p = res.problems[0]!;
    expect(p.kind).toBe("semantic");
    expect(p.message).toContain("'enmy' is not defined");
    expect(p.file).toBe("t.qbsk");
    expect(p.start.line).toBeGreaterThan(0);
    expect(p.source).toContain("enmy");
    expect(p.fragment).toContain("^");
  });

  it("natives are not flagged as undefined", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.check("print(len([1, 2, 3]))\nupper(\"hi\")", "t.qbsk");
    expect(res.problems).toHaveLength(0);
  });

  it("a syntax error in the source is reported, not thrown", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.check("scene X(width: 10)\n  layer", "t.qbsk");
    expect(res.ok).toBe(true);
    expect(res.problems[0]!.kind).toBe("syntax");
  });

  // A `use` resolves relative to the INCLUDING FILE, which docs/studio.md §11.4 states
  // as the contract ("module/sprite resolution inside QBSK stays relative to the
  // including file, exactly as the interpreter does today"). check() resolved against
  // the project root instead, so every example that loads a module reported phantom
  // problems under MCP while `qbsk check` on the same file exited 0 — the agent was
  // told real, working source was broken.
  //
  // This is the SECOND time this bug shipped: loadProgram() carries an earlier release comment
  // fixing exactly this, and check() was left behind. An earlier release missed it for the stated
  // reason that no test scene loaded an external resource — so this test uses a real
  // example that does, which is the only kind that can catch it.
  it("a real example's `use` resolves relative to the file, not the project root", () => {
    const host = new McpSessionHost(root, new Map());
    const source = readFileSync(join(root, "examples", "turns.qbsk"), "utf8");
    const res = host.check(source, "examples/turns.qbsk");
    expect(res.problems).toHaveLength(0);
    expect(res.clean).toBe(true);
  });

  // The same file through the loading path, which already resolved correctly: the two
  // paths must agree, because an agent that checks clean and then fails to load (or the
  // reverse) cannot tell which answer to believe.
  it("check and eval agree on the same file", () => {
    const host = new McpSessionHost(root, new Map());
    const source = readFileSync(join(root, "examples", "turns.qbsk"), "utf8");
    const checked = host.check(source, "examples/turns.qbsk");
    const evaluated = host.eval(source, "examples/turns.qbsk");
    expect(checked.clean).toBe(true);
    expect(evaluated.ok).toBe(true);
  });
});

describe("MCP session host: qbsk_eval and persistence (docs/studio.md §11.4)", () => {
  it("first eval loads the program, captures print and paints the grid", () => {
    const host = new McpSessionHost(root, new Map());
    const source = [
      "var x = 5",
      "print(\"loaded\")",
      "scene P(width: 8, height: 3)",
      "  layer l z: 1",
      "    fill \".\"",
      "    put \"@\" at (x, 1)",
    ].join("\n");
    const res = host.eval(source, "p.qbsk");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.print).toContain("loaded");
    expect(res.grid).not.toBeNull();
    expect(res.grid!.rows[1]).toBe(".....@..");
    expect(res.grid!.cells).toBe(24);
  });

  it("a later eval mutates live state and the grid moves (the whole point of an earlier release)", () => {
    const host = new McpSessionHost(root, new Map());
    const source = [
      "var x = 5",
      "scene P(width: 8, height: 3)",
      "  layer l z: 1",
      "    fill \".\"",
      "    put \"@\" at (x, 1)",
    ].join("\n");
    const first = host.eval(source, "p.qbsk");
    expect(first.ok).toBe(true);
    const second = host.eval("x = x + 1", "p.qbsk");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.grid!.rows[1]).toBe("......@.");
    // The diff repainted exactly the two moved cells, not the whole grid.
    expect(second.grid!.cells).toBe(2);
  });

  // The test above this one proves print works when the eval LOADS the program. A
  // snippet against an already-live program went through a different path and dropped
  // it: the snippet interpreter builds its own natives (whose `print` appends to the
  // returned `out`) and then throws that env away in favour of `liveEnv`, so the name
  // `print` resolved to the PROGRAM's native, writing to the program's sink instead.
  //
  // Found by playing the examples, not by reading the code: two debugging evals during
  // a playthrough came back with `print: []` while qbsk_trace showed the lines. An eval
  // that silently discards its own output is worse than one that fails — the agent
  // concludes the program printed nothing and debugs the wrong thing.
  it("a snippet's print reaches the caller, not only the program's sink", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval(
      ["var x = 5", "scene P(width: 8, height: 3)", "  layer l z: 1", "    fill \".\""].join("\n"),
      "p.qbsk",
    );
    const res = host.eval('print("from the snippet")\nprint("x is {x}")', "e.qbsk");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.print).toEqual(["from the snippet", "x is 5"]);
  });

  // The value already survived this path, which is what made the missing print look
  // like "snippets do not print" rather than a bug: both come from the same call.
  it("a snippet returns both its value and its print", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval("var x = 1\nscene P(width: 4, height: 2)\n  layer l z: 1\n    fill \".\"", "p.qbsk");
    const res = host.eval('print("side effect")\n40 + 2', "e.qbsk");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(42);
    expect(res.print).toEqual(["side effect"]);
  });

  // Each call answers for itself: an agent reading call N's output must not be shown
  // lines produced by call N-1.
  it("print does not leak from one snippet into the next", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval("var x = 1\nscene P(width: 4, height: 2)\n  layer l z: 1\n    fill \".\"", "p.qbsk");
    host.eval('print("first")', "e.qbsk");
    const second = host.eval('print("second")', "e.qbsk");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.print).toEqual(["second"]);
  });

  it("a runtime error comes back structured with span and fragment, never fatal", () => {
    const host = new McpSessionHost(root, new Map());
    const source = [
      "var x = 5",
      "scene P(width: 4, height: 2)",
      "  layer l z: 1",
      "    fill \".\"",
    ].join("\n");
    host.eval(source, "p.qbsk");
    const res = host.eval("undefined_fn(3)", "p.qbsk") as ToolError;
    expect(res.ok).toBe(false);
    expect(res.error.kind).toBe("runtime");
    expect(res.error.message).toContain("not defined");
    expect(res.error.file).toBe("p.qbsk");
    expect(res.error.source).toBe("undefined_fn(3)");
    expect(res.error.fragment).toContain("^^");
    // The program is still alive: an uncaught snippet error does not kill it.
    const after = host.eval("x = 7", "p.qbsk");
    expect(after.ok).toBe(true);
    expect(host.inspect("x")).toMatchObject({ value: 7 });
  });

  it("a snippet cannot clobber an existing live binding", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval("var x = 5\nscene P(width: 4, height: 2)\n  layer l z: 1\n    fill \".\"", "p.qbsk");
    const res = host.eval("var x = 6", "p.qbsk") as ToolError;
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain("already defined");
    // The live binding is untouched.
    expect(host.inspect("x")).toEqual({
      ok: true,
      name: "x",
      value: 5,
      type: "int",
      binding: "var",
    });
  });
});

describe("MCP session host: qbsk_read_screen, inspect, list_vars (docs/studio.md §11.4)", () => {
  it("read_screen before any frame is a structured not-found", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.readScreen() as ToolError;
    expect(res.ok).toBe(false);
    expect(res.error.kind).toBe("semantic");
    expect(res.error.message).toContain("no scene");
  });

  it("inspect reports value, QBSK type and binding kind", () => {
    const host = new McpSessionHost(root, new Map());
    const source = [
      "var x = 5",
      "const C = \"hi\"",
      "func add(a, b)",
      "    return a + b",
      "scene P(width: 4, height: 2)",
      "  layer l z: 1",
      "    fill \".\"",
    ].join("\n");
    host.eval(source, "p.qbsk");
    expect(host.inspect("x")).toEqual({
      ok: true,
      name: "x",
      value: 5,
      type: "int",
      binding: "var",
    });
    expect(host.inspect("C")).toMatchObject({ ok: true, type: "str", binding: "const" });
    expect(host.inspect("print")).toMatchObject({ ok: true, binding: "native" });
    expect(host.inspect("add")).toMatchObject({ ok: true, type: "func", binding: "var" });
    const missing = host.inspect("zzz") as ToolError;
    expect(missing.ok).toBe(false);
    expect(missing.error.message).toContain("'zzz' is not defined");
  });

  it("list_vars returns every live top-level binding, and is empty before a load", () => {
    const host = new McpSessionHost(root, new Map());
    expect(host.listVars().names).toHaveLength(0);
    host.eval("var p1 = 1\nvar p2 = [1, 2]\nscene P(width: 4, height: 2)\n  layer l z: 1\n    fill \".\"", "p.qbsk");
    const names = host.listVars().names;
    expect(names).toContain("p1");
    expect(names).toContain("p2");
    expect(names).toContain("P");
    expect(names).toContain("print");
  });
});

describe("MCP session host: qbsk_open / qbsk_save with path containment (docs/studio.md §11.2/§11.4)", () => {
  it("open reads a project file, save writes it back", () => {
    const dir = tempRoot();
    try {
      const host = new McpSessionHost(dir, new Map());
      const save = host.save("scene.qbsk", "var a = 1\n");
      expect(save.ok).toBe(true);
      if (!save.ok) return;
      expect(save.bytes).toBe("var a = 1\n".length);
      const open = host.open("scene.qbsk");
      expect(open.ok).toBe(true);
      if (open.ok) expect(open.source).toBe("var a = 1\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a path escaping the root is a structured error, not a permission bypass", () => {
    const dir = tempRoot();
    try {
      const host = new McpSessionHost(dir, new Map());
      for (const path of ["../secret.txt", "..\\..\\etc\\passwd", "sub/../../up.txt"]) {
        const res = host.open(path) as ToolError;
        expect(res.ok).toBe(false);
        expect(res.error.message).toContain("escapes the project root");
      }
      const abs = host.open(resolve(root, "package.json")) as ToolError;
      expect(abs.ok).toBe(false);
      expect(abs.error.message).toContain("relative");
      expect(host.save("../evil.qbsk", "x").ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opening a missing file is a structured not-found", () => {
    const dir = tempRoot();
    try {
      const host = new McpSessionHost(dir, new Map());
      const res = host.open("nope.qbsk") as ToolError;
      expect(res.ok).toBe(false);
      expect(res.error.message).toContain("cannot read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// An earlier release: generateSprite() writes real files, so — same convention as qbsk_save
// above — it runs against a temp root, never the real repo, with examples/lib/
// copied in (that's the only thing generateSpriteAssets actually reads from disk).
describe("MCP session host: qbsk_generate_sprite", () => {
  function rootWithPixelart(): string {
    const dir = tempRoot();
    const libDir = join(dir, "examples", "lib");
    mkdirSync(libDir, { recursive: true });
    copyFileSync(
      join(root, "examples", "lib", "pixelart.qbsk"),
      join(libDir, "pixelart.qbsk"),
    );
    return dir;
  }

  it("generates a sprite, writes qbdata + SVG under examples/res/generated/", () => {
    const dir = rootWithPixelart();
    try {
      const host = new McpSessionHost(dir, new Map());
      const res = host.generateSprite(27, 16);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.width).toBe(16);
      expect(res.height).toBe(16);
      expect(res.svg).toContain("<svg");
      expect(res.filled).toBeGreaterThan(0);
      expect(readFileSync(res.qbdataPath, "utf8")).toContain("shape pixel_sprite");
      expect(readFileSync(res.svgPath, "utf8")).toBe(res.svg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the same seed through the tool call is byte-identical to calling it twice", () => {
    const dir = rootWithPixelart();
    try {
      const host = new McpSessionHost(dir, new Map());
      const a = host.generateSprite(5, 16);
      const b = host.generateSprite(5, 16);
      expect(a.ok && b.ok).toBe(true);
      if (a.ok && b.ok) expect(a.svg).toBe(b.svg);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an invalid size falls back to 16, never crashes", () => {
    const dir = rootWithPixelart();
    try {
      const host = new McpSessionHost(dir, new Map());
      const res = host.generateSprite(1, 999);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.width).toBe(16);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is reachable over the real JSON-RPC wire as qbsk_generate_sprite", () => {
    const dir = rootWithPixelart();
    try {
      const { server, sent } = wire(new McpSessionHost(dir, new Map()));
      const res = rpc(server, sent, "tools/call", {
        name: "qbsk_generate_sprite",
        arguments: { seed: 3, size: 16 },
      });
      const payload = toolPayload(res) as { ok: boolean; svg: string };
      expect(payload.ok).toBe(true);
      expect(payload.svg).toContain("<svg");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP session host: qbsk_loop (docs/studio.md §11.4)", () => {
  it("status before any program reports running=false and 0 frames", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.loop("status", 0);
    expect(res.ok).toBe(true);
    expect(res.status.running).toBe(false);
    expect(res.status.frames).toBe(0);
    expect(res.status.error).toBeNull();
  });

  it("start/stop flip the armed state and step advances exactly one frame", () => {
    const host = new McpSessionHost(root, new Map());
    const source = [
      "var x = 0",
      "on tick(dt)",
      "    x += 1",
      "scene P(width: 8, height: 3)",
      "  layer l z: 1",
      "    fill \".\"",
      "    put \"@\" at (x, 1)",
    ].join("\n");
    const loaded = host.eval(source, "p.qbsk");
    expect(loaded.ok).toBe(true);

    const s0 = host.loop("status", 0);
    expect(s0.status.frames).toBe(1); // the eval's first frame
    expect(host.inspect("x")).toMatchObject({ value: 1 }); // on tick ran once

    host.loop("start", 0);
    expect(host.loop("status", 0).status.running).toBe(true);
    host.loop("stop", 0);
    expect(host.loop("status", 0).status.running).toBe(false);

    const stepped = host.loop("step", 1 / 60);
    expect(stepped.ok).toBe(true);
    expect(stepped.status.frames).toBe(2);
    // gameTime advanced and the tick handler ran again — the state persists.
    expect(host.inspect("x")).toMatchObject({ value: 2 });
    expect(stepped.grid).not.toBeNull();
  });

  it("reload re-creates the program from the current source", () => {
    const host = new McpSessionHost(root, new Map());
    const source = "var x = 7\nscene P(width: 8, height: 3)\n  layer l z: 1\n    fill \".\"";
    host.eval(source, "p.qbsk");
    expect(host.inspect("x")).toMatchObject({ value: 7 });
    host.eval("x = 99", "p.qbsk");
    expect(host.inspect("x")).toMatchObject({ value: 99 });
    const res = host.loop("reload", 0);
    expect(res.ok).toBe(true);
    expect(host.inspect("x")).toMatchObject({ value: 7 });
  });
});

describe("MCP server: JSON-RPC 2.0 over the wire (docs/studio.md §11.2/§11.3)", () => {
  function newServer(): { server: McpServer; sent: string[] } {
    return wire(new McpSessionHost(root, new Map()));
  }

  it("initialize announces capabilities and server identity", () => {
    const { server, sent } = newServer();
    const res = rpc(server, sent, "initialize", { protocolVersion: "2025-03-26" });
    expect(okResult(res)).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "qbsk-studio", version: "0.1.0" },
    });
  });

  it("notifications receive no response", () => {
    const { server, sent } = newServer();
    server.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(sent).toHaveLength(0);
  });

  it("malformed JSON is a -32700 parse error", () => {
    const { server, sent } = newServer();
    server.handle("this is not json");
    const res = JSON.parse(sent[0]!);
    expect(res.id).toBeNull();
    expect(res.error.code).toBe(-32700);
  });

  it("a non-2.0 request is a -32600 invalid request", () => {
    const { server, sent } = newServer();
    server.handle(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "initialize" }));
    const res = JSON.parse(sent[0]!);
    expect(res.error.code).toBe(-32600);
  });

  it("an unknown method is a -32601 method not found", () => {
    const { server, sent } = newServer();
    const res = rpc(server, sent, "bogus/method");
    expect("error" in res && res.error.code).toBe(-32601);
  });

  it("tools/list exposes the full 13-tool surface with short descriptions", () => {
    const { server, sent } = newServer();
    const res = rpc(server, sent, "tools/list");
    const tools = (res as { result: { tools: McpTool[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual([
      "qbsk_check",
      "qbsk_eval",
      "qbsk_read_screen",
      // Added deliberately for an earlier release (docs/studio.md §15): an agent that cannot see
      // the window is blind to everything it did not draw itself. This list is locked
      // on purpose — changing it is a decision, and this is the record of one.
      "qbsk_read_window",
      "qbsk_inspect",
      "qbsk_list_vars",
      "qbsk_open",
      "qbsk_save",
      "qbsk_loop",
      // An earlier release (docs/studio.md §16), same reasoning, two more decisions on the record.
      // `qbsk_key`: the surface could load, inspect and read a game and never press a
      // key — pressKey existed for the CLI and the window and was never wired here, so
      // the one program that proves QBSK makes games could not be played by the agent
      // the surface was built for.
      "qbsk_key",
      // `qbsk_trace`: every other tool answers what it returned and none answered what
      // happened. A key that changes nothing on screen is three different bugs with one
      // appearance, and the grid cannot tell them apart.
      "qbsk_trace",
      // `qbsk_load`: running a file meant open + eval, sending the whole source through
      // the agent to arrive where it started — and eval's meaning depended on whether a
      // program was already live, so "run this file" was conditional on session state.
      "qbsk_load",
      // An earlier release: an agent can generate a real asset (pixel-art sprite), not just read
      // or run QBSK code — also locked on purpose, same reasoning as qbsk_read_window.
      "qbsk_generate_sprite",
    ]);
    // Two-layer rule: descriptions stay short (they are paid every session).
    for (const t of tools) {
      expect(t.description.length).toBeLessThan(400);
    }
    const loop = tools.find((t) => t.name === "qbsk_loop")!;
    const cmd = loop.inputSchema.properties.command as { enum: string[] };
    expect(cmd.enum).toEqual(["start", "stop", "step", "status", "reload"]);
  });

  it("resources/list exposes the generated manual resources", () => {
    const { server, sent } = newServer();
    const res = rpc(server, sent, "resources/list");
    const uris = (res as { result: { resources: { uri: string }[] } }).result.resources.map(
      (r) => r.uri,
    );
    expect(uris).toContain("qbsk://manual");
    expect(uris).toContain("qbsk://natives");
    expect(uris).toContain("qbsk://scene-dsl");
    expect(uris).toContain("qbsk://language");
    expect(uris).toContain("qbsk://examples");
  });

  it("resources/read returns the body as text/markdown; a missing uri is a -32002", () => {
    const resources = new Map([["qbsk://manual", "# manual body"]]);
    const host = new McpSessionHost(root, resources);
    const { server, sent } = wire(host);
    const ok = rpc(server, sent, "resources/read", { uri: "qbsk://manual" });
    const contents = (ok as { result: { contents: { uri: string; mimeType: string; text: string }[] } })
      .result.contents;
    expect(contents[0]).toEqual({
      uri: "qbsk://manual",
      mimeType: "text/markdown",
      text: "# manual body",
    });
    const missing = rpc(server, sent, "resources/read", { uri: "qbsk://nope" }, 2);
    expect("error" in missing && missing.error.code).toBe(-32002);
  });

  it("tools/call wraps QBSK failures as in-band tool results, never protocol errors", () => {
    const { server, sent } = newServer();
    const res = rpc(server, sent, "tools/call", {
      name: "qbsk_eval",
      arguments: { source: "undefined_fn(3)", file: "e.qbsk" },
    });
    const payload = toolPayload(res);
    expect(payload).toMatchObject({ ok: false });
    expect((payload as ToolError).error.kind).toBe("runtime");
    expect((payload as ToolError).error.fragment).toContain("^");
  });

  it("tools/call with an invalid loop command is an in-band error with a clear message", () => {
    const { server, sent } = newServer();
    const res = rpc(server, sent, "tools/call", {
      name: "qbsk_loop",
      arguments: { command: "teleport" },
    });
    const payload = toolPayload(res);
    expect(payload).toMatchObject({ ok: false });
    expect((payload as ToolError).error.message).toContain("invalid loop command");
  });

  it("an unknown tool name is an in-band error, not a protocol error", () => {
    const { server, sent } = newServer();
    const res = rpc(server, sent, "tools/call", { name: "qbsk_wipe_disk", arguments: {} });
    const payload = toolPayload(res);
    expect(payload).toMatchObject({ ok: false });
    expect((payload as ToolError).error.message).toContain("unknown tool");
  });
});

describe("the generated manual is derived from the source of truth (docs/studio.md §11.6)", () => {
  it("qbsk://language is docs/language.md verbatim and the other resources exist", () => {
    const resources = buildResources(root);
    expect(resources.get("qbsk://language")).toBe(languageDoc);
    for (const uri of ["qbsk://manual", "qbsk://natives", "qbsk://scene-dsl", "qbsk://examples"]) {
      expect(resources.get(uri)?.length ?? 0).toBeGreaterThan(100);
    }
  });

  it("qbsk://natives lists the introspected natives with arity and error", () => {
    const resources = buildResources(root);
    const natives = resources.get("qbsk://natives")!;
    expect(natives).toContain("`upper`");
    expect(natives).toContain("function 'upper' expects 1 arguments");
    expect(natives).toContain("`slice`");
    expect(natives).toContain("2–3");
    expect(natives).not.toContain("[object Object]");
  });

  it("the three an earlier release gotchas reach qbsk://language AND qbsk://scene-dsl (§7.8)", () => {
    const resources = buildResources(root);
    const language = resources.get("qbsk://language")!;
    const sceneDsl = resources.get("qbsk://scene-dsl")!;
    // Criterion 4: the agent-facing resources carry the gotchas, generated from the
    // spec — never hand-written twice. All three appear in the whole-language
    // resource AND in the scene-DSL section an agent reads before writing a scene.
    for (const text of [language, sceneDsl]) {
      // Gotcha (a) INVERTED on 2026-08-19. It used to be "you cannot name a layer after
      // a primitive"; §15.15 made every scene word a name outside statement position, so
      // the thing an agent now needs told is the rule that replaced it. The assertion
      // moved with the spec rather than being deleted — an agent reading a stale gotcha
      // writes code around a restriction that is gone.
      expect(text).toContain("a keyword only where the grammar is looking for one");
      expect(text).toContain("Interpolation is eager");
      expect(text).toContain("state directives, not layer-level guards");
    }
  });

  it("lie detector: every example's embedded output matches a fresh execution", () => {
    const resources = buildResources(root);
    const stems = resources
      .get("qbsk://examples")!
      .matchAll(/qbsk:\/\/examples\/([\w-]+)/g);
    let checked = 0;
    for (const m of stems) {
      const stem = m[1]!;
      if (stem === "examples") continue;
      const file = join(root, "examples", `${stem}.qbsk`);
      const source = readFileSync(file, "utf8");
      const fresh = runQbsk(source, file).out;
      const truncated = fresh.length > LIMIT_ROWS;
      const shown = truncated ? fresh.slice(0, LIMIT_ROWS) : fresh;
      const rendered = [
        "```",
        ...(shown.length > 0 ? shown : ["(no output)"]),
        ...(truncated ? ["…"] : []),
        "```",
      ].join("\n");
      const embedded = resources.get(`qbsk://examples/${stem}`)!;
      // If the manual's embedded output ever drifts from what the interpreter
      // really produces, this assertion turns red.
      expect(embedded).toContain(`## Output (executed)\n\n${rendered}`);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });
});

describe("criterion 5: an AI client drives the engine end to end over the wire (docs/studio.md §11.7)", () => {
  it("learns from a resource, writes a scene, checks it, fixes it, evaluates and reads the grid", () => {
    const dir = tempRoot();
    try {
      const resources = buildResources(root);
      const host = new McpSessionHost(dir, resources);
      const { server, sent } = wire(host);
      let id = 0;
      const nextId = (): number => (id += 1);

      // 1. Learn a piece of the language from the manual (the two-layer rule).
      const manual = rpc(server, sent, "resources/read", { uri: "qbsk://manual" }, nextId());
      const manualText = (manual as { result: { contents: { text: string }[] } }).result.contents[0]!.text;
      expect(manualText).toContain("scene");
      expect(manualText).toContain("put");

      // 2. Write a scene with a bug into the project.
      const save = rpc(
        server,
        sent,
        "tools/call",
        { name: "qbsk_save", arguments: { path: "battle.qbsk", source: BUGGY_SCENE } },
        nextId(),
      );
      expect(toolPayload(save)).toMatchObject({ ok: true, path: join(dir, "battle.qbsk") });

      // 3. Check before running: the analyzer catches the typo.
      const check = rpc(
        server,
        sent,
        "tools/call",
        { name: "qbsk_check", arguments: { source: BUGGY_SCENE, file: "battle.qbsk" } },
        nextId(),
      );
      const checkPayload = toolPayload(check);
      expect(checkPayload).toMatchObject({ ok: true });
      const problems = (checkPayload as { problems: { message: string }[] }).problems;
      expect(problems.some((p) => p.message.includes("'enmy' is not defined"))).toBe(true);

      // 4. Fix what the analyzer reported and evaluate.
      const evalRes = rpc(
        server,
        sent,
        "tools/call",
        { name: "qbsk_eval", arguments: { source: FIXED_SCENE, file: "battle.qbsk" } },
        nextId(),
      );
      const evalPayload = toolPayload(evalRes) as {
        ok: boolean;
        grid: { rows: string[] } | null;
      };
      expect(evalPayload.ok).toBe(true);
      expect(evalPayload.grid).not.toBeNull();

      // 5. Read the grid back and confirm what was drawn.
      const screen = rpc(server, sent, "tools/call", { name: "qbsk_read_screen", arguments: {} }, nextId());
      const screenPayload = toolPayload(screen) as { ok: boolean; grid: { rows: string[] } };
      expect(screenPayload.ok).toBe(true);
      const row = screenPayload.grid.rows[1]!;
      expect(row[1]).toBe("H");
      expect(row[10]).toBe("E");
      expect(row).toMatch(/^\.H.*\.\.\.\.\.\.\.\.E\.$/);

      // 6. Loop control round trip: step once and read the state.
      const loop = rpc(
        server,
        sent,
        "tools/call",
        { name: "qbsk_loop", arguments: { command: "status" } },
        nextId(),
      );
      expect(toolPayload(loop)).toMatchObject({ ok: true, status: { running: false } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Regression: qbsk_eval resolved relative paths against the SERVER's cwd instead of
// the project root, so any scene loading a sprite or a `use` module failed with
// "file not found" under MCP while working from the CLI. Found in an earlier release when the
// jail scene gained a sprite; missed in an earlier release because no test scene loaded an
// external resource.
describe("MCP session host: project-relative resource paths", () => {
  it("a scene that loads a sprite resolves it against the project root", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.eval(
      `scene S(width: 10, height: 5)\nlayer a z: 1\n    sprite "res/walk.qba" at (2, 1)\n`,
      "examples/scene.qbsk",
    );
    expect(res).toMatchObject({ ok: true });
    expect((res as { error?: unknown }).error).toBeUndefined();
  });

  it("a missing resource still reports file not found, with the span", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.eval(
      `scene S(width: 10, height: 5)\nlayer a z: 1\n    sprite "res/nope.qba" at (2, 1)\n`,
      "examples/scene.qbsk",
    );
    expect(res).toMatchObject({ ok: false });
  });
});

// An earlier release: the manual generator EXECUTES example snippets, and examples now declare
// tones. Two things must stay true, and neither is guaranteed by the code being
// correct today — only by nothing later wiring a device into the generator.
describe("generating the manual is deterministic and silent (docs/audio.md §3)", () => {
  it("building it twice produces byte-identical resources", () => {
    const a = buildResources(root);
    const b = buildResources(root);
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [uri, text] of a) {
      expect(b.get(uri)).toBe(text);
    }
  });

  it("executed examples carry an audio plan but the generator never plays it", () => {
    // The plan is data on the result; playback requires an AudioDevice, and the
    // generator constructs none. Asserting the plan exists AND that the generator
    // imports no device is what stops a future change from making manual
    // generation audible - a build step that beeps is a bug nobody would expect.
    const withTone = runQbsk(
      'scene S(width: 8, height: 2)\nlayer a z: 1\n    fill "."\n    tone 440',
      "gen.qbsk",
    );
    expect(withTone.error).toBeNull();
    expect(withTone.audioPlan).toHaveLength(1);
    const source = readFileSync(
      join(root, "studio", "mcp", "generate-manual.ts"),
      "utf8",
    );
    expect(source).not.toContain("AudioDevice");
    expect(source).not.toContain("audio/device");
  });
});

// An earlier release (docs/studio.md §16): the agent can press keys and read why things happened.
// examples/turns.qbsk is the program these exist for — its whole design is that nothing
// moves until someone acts, so an agent that cannot press a key cannot play it at all.
describe("MCP session host: qbsk_key (docs/studio.md §16.2)", () => {
  const turns = () => readFileSync(join(root, "examples", "turns.qbsk"), "utf8");

  const loaded = (): McpSessionHost => {
    const host = new McpSessionHost(root, new Map());
    host.eval(turns(), "examples/turns.qbsk");
    return host;
  };

  it("pressing a key with no program loaded is a structured error", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.key("arrow-right", 1, 1 / 60);
    expect(res.ok).toBe(false);
    expect((res as ToolError).error.message).toContain("no program loaded");
  });

  // The analyzer's instinct applied to input: a wrong name teaches instead of doing
  // nothing. "left" silently queued as an unknown key was indistinguishable from a
  // key the game ignores on purpose.
  it("a non-canonical key name is refused with a suggestion", () => {
    const host = loaded();
    const res = host.key("left", 1, 1 / 60);
    expect(res.ok).toBe(false);
    const err = (res as ToolError).error;
    expect(err.message).toContain("left");
    expect(err.suggestion).toBe("arrow-left");
  });

  it("an arrow moves the player and advances the turn", () => {
    const host = loaded();
    const before = host.inspect("playerX");
    const res = host.key("arrow-right", 1, 1 / 60);
    expect(res.ok).toBe(true);
    const after = host.inspect("playerX");
    expect((after as InspectResult).value).not.toBe((before as InspectResult).value);
    expect((res as KeyResult).turn).toBe(1);
    expect((res as KeyResult).handled).toBe(true);
    expect((res as KeyResult).grid).not.toBeNull();
  });

  // `delivered` and `handled` answer different questions, and a game relies on the
  // difference: `i` opens the pack and costs no turn, which is the example's stated
  // reason `advance()` is explicit. A key nothing handles must not look like an error.
  it("a free action is handled but does not cost a turn", () => {
    const host = loaded();
    host.key("arrow-right", 1, 1 / 60);
    const res = host.key("i", 1, 1 / 60) as KeyResult;
    expect(res.handled).toBe(true);
    expect(res.turn).toBe(1);
  });

  it("a canonical key with no handler is delivered but not handled", () => {
    const host = loaded();
    const res = host.key("z", 1, 1 / 60) as KeyResult;
    expect(res.ok).toBe(true);
    expect(res.delivered).toBe(true);
    expect(res.handled).toBe(false);
    expect(res.turn).toBe(0);
  });

  it("steps advances several frames on one press", () => {
    const host = loaded();
    const res = host.key("arrow-down", 4, 1 / 60) as KeyResult;
    expect(res.frames).toBe(4);
  });

  // The proof the whole phase is for: a scripted sequence played entirely through the
  // MCP surface, ending where turns.test.ts's golden sequence ends.
  it("a scripted sequence plays through and the counter agrees", () => {
    const host = loaded();
    for (const k of ["arrow-right", "arrow-right", "arrow-down", ".", "i", "arrow-left"]) {
      const res = host.key(k, 1, 1 / 20);
      expect(res.ok).toBe(true);
    }
    const res = host.key(".", 1, 1 / 20) as KeyResult;
    expect(res.turn).toBe(6);
    expect(res.grid!.rows.join("\n")).toContain("turn 6");
  });
});

describe("MCP session host: qbsk_trace (docs/studio.md §16.3)", () => {
  it("an untouched session traces nothing and says so", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.trace(50, 0);
    expect(res.ok).toBe(true);
    expect(res.entries).toEqual([]);
    expect(res.dropped).toBe(0);
  });

  it("a load, a key and a turn each leave a readable line", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval(readFileSync(join(root, "examples", "turns.qbsk"), "utf8"), "examples/turns.qbsk");
    host.key("arrow-right", 1, 1 / 60);
    const res = host.trace(100, 0);
    const kinds = res.entries.map((e) => e.kind);
    expect(kinds).toContain("load");
    expect(kinds).toContain("key");
    const key = res.entries.find((e) => e.kind === "key")!;
    expect(key.detail).toContain("arrow-right");
    expect(key.seq).toBeGreaterThan(0);
  });

  // A cursor, not a re-read: polling must cost only what happened since.
  it("`since` returns only what is new, and `next` is where to resume", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval("var a = 1", "t.qbsk");
    const first = host.trace(100, 0);
    expect(first.entries.length).toBeGreaterThan(0);
    const again = host.trace(100, first.next);
    expect(again.entries).toEqual([]);
    expect(again.next).toBe(first.next);
  });

  // An agent reasoning over a truncated history without knowing it is truncated draws
  // confident wrong conclusions. The gap must be a reported fact.
  it("the ring drops the oldest and reports how many", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval("var a = 1", "t.qbsk");
    for (let i = 0; i < 1200; i += 1) {
      host.inspect("a");
    }
    const res = host.trace(10, 0);
    expect(res.dropped).toBeGreaterThan(0);
    expect(res.entries.length).toBeLessThanOrEqual(10);
  });

  it("a runtime error is recorded with its span, not only returned", () => {
    const host = new McpSessionHost(root, new Map());
    host.eval("var a = 1", "t.qbsk");
    host.eval("nope(1)", "t.qbsk");
    const res = host.trace(100, 0);
    const err = res.entries.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    expect(err!.detail.length).toBeGreaterThan(0);
  });
});

// An earlier release (docs/studio.md §17): running a file took open + eval, which sent the whole
// source through the agent to arrive where it started — and meant something different
// depending on whether a program was already live.
describe("MCP session host: qbsk_load (docs/studio.md §17)", () => {
  it("runs a file the agent never has to read", () => {
    const host = new McpSessionHost(root, new Map());
    const res = host.load("examples/turns.qbsk", true) as LoadResult;
    expect(res.ok).toBe(true);
    expect(res.lines).toBeGreaterThan(100);
    expect(res.problems).toHaveLength(0);
    expect(res.grid).not.toBeNull();
    // The source is what we deliberately did NOT return.
    expect(res as unknown as { source?: unknown }).not.toHaveProperty("source");
  });

  it("the loaded program is live: its variables and keys are reachable", () => {
    const host = new McpSessionHost(root, new Map());
    host.load("examples/turns.qbsk", true);
    expect((host.inspect("playerX") as InspectResult).value).toBe(8);
    const pressed = host.key("arrow-right", 1, 1 / 20) as KeyResult;
    expect(pressed.turn).toBe(1);
    expect((host.inspect("playerX") as InspectResult).value).toBe(9);
  });

  // The reason `check` defaults to true: a program the analyzer rejects must not reach
  // frame 1, where the same mistake reappears as a runtime error with less information.
  it("analyzer problems are reported and nothing is loaded", () => {
    const host = new McpSessionHost(root, new Map());
    host.save("examples/tmp-load-broken.qbsk", "var a = 1\nprint(nope)\n");
    const res = host.load("examples/tmp-load-broken.qbsk", true) as LoadResult;
    expect(res.ok).toBe(true);
    expect(res.problems.length).toBeGreaterThan(0);
    expect(res.grid).toBeNull();
    // Nothing was loaded, so there is nothing to inspect.
    expect(host.inspect("a").ok).toBe(false);
    rmSync(join(root, "examples", "tmp-load-broken.qbsk"), { force: true });
  });

  it("check: false runs a program the analyzer would reject", () => {
    const host = new McpSessionHost(root, new Map());
    host.save("examples/tmp-load-unchecked.qbsk", "var a = 41\nvar b = a + 1\n");
    const res = host.load("examples/tmp-load-unchecked.qbsk", false) as LoadResult;
    expect(res.ok).toBe(true);
    expect((host.inspect("b") as InspectResult).value).toBe(42);
    rmSync(join(root, "examples", "tmp-load-unchecked.qbsk"), { force: true });
  });

  it("loading twice re-reads the file from disk", () => {
    const host = new McpSessionHost(root, new Map());
    host.save("examples/tmp-load-twice.qbsk", "var v = 1\n");
    host.load("examples/tmp-load-twice.qbsk", true);
    expect((host.inspect("v") as InspectResult).value).toBe(1);
    host.save("examples/tmp-load-twice.qbsk", "var v = 2\n");
    host.load("examples/tmp-load-twice.qbsk", true);
    expect((host.inspect("v") as InspectResult).value).toBe(2);
    rmSync(join(root, "examples", "tmp-load-twice.qbsk"), { force: true });
  });

  it("a missing file and an escaping path are structured errors", () => {
    const host = new McpSessionHost(root, new Map());
    expect((host.load("examples/does-not-exist.qbsk", true) as ToolError).ok).toBe(false);
    const escaped = host.load("../outside.qbsk", true) as ToolError;
    expect(escaped.ok).toBe(false);
    expect(escaped.error.message).toContain("escapes the project root");
  });

  it("the load lands in the trace as a load, not as an eval", () => {
    const host = new McpSessionHost(root, new Map());
    host.load("examples/turns.qbsk", true);
    const entries = host.trace(50, 0).entries;
    expect(entries.some((e) => e.kind === "load")).toBe(true);
    expect(entries.some((e) => e.detail.includes("turns.qbsk"))).toBe(true);
  });

  // A trace that records THAT something failed without recording WHY is the exact
  // blindness §16.1 describes, one level up. Found by reading the trace of this
  // tool's own verification run: two `qbsk_load → error` lines and no reason on either.
  it("a failed load explains itself in the trace, not just that it failed", () => {
    const host = new McpSessionHost(root, new Map());
    host.load("examples/definitely-not-here.qbsk", true);
    host.load("../outside-the-root.qbsk", true);
    const reasons = host
      .trace(50, 0)
      .entries.filter((e) => e.kind === "error")
      .map((e) => e.detail);
    expect(reasons.some((d) => d.includes("file not found"))).toBe(true);
    expect(reasons.some((d) => d.includes("escapes the project root"))).toBe(true);
  });
});
