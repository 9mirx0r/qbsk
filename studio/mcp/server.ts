// The embedded MCP server (docs/studio.md §11): JSON-RPC 2.0 dispatch over a
// line-delimited transport, delegating every tool to the host that owns the
// interpreter state. Pure — no Electron — so the same class runs headless in tests
// and inside the main process.
import type { McpHost, QbskErrorShape, ToolError } from "./types.js";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface McpResource {
  uri: string;
  name: string;
  description: string;
}

export interface McpCallResult {
  ok: boolean;
  data: unknown;
}

export type McpTransport = {
  send(message: string): void;
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

const TOOLS: McpTool[] = [
  {
    name: "qbsk_check",
    description:
      "Validate QBSK source WITHOUT running it (an earlier release analyzer). Read `clean` (or `problems.length`) for the verdict — NOT `ok`, which only reports that the call ran and is true even when problems were found. Each problem carries a span, source fragment and a 'did you mean' hint. Use it before qbsk_eval to catch arity/typo/undefined-name mistakes.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The QBSK source to analyze." },
        file: {
          type: "string",
          description: "Logical file name for spans and module resolution. Defaults to 'check.qbsk'.",
        },
      },
      required: ["source"],
    },
  },
  {
    name: "qbsk_eval",
    description:
      "Run QBSK code in the live environment: reads see live variables, print output is captured, and the painted grid is returned so you can see the result. Loads the program on first call; later calls evaluate against the running program's state. Errors come back structured (span + fragment).",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "The QBSK code to evaluate." },
        file: {
          type: "string",
          description: "Logical file name for spans. Defaults to 'eval.qbsk'.",
        },
      },
      required: ["source"],
    },
  },
  {
    name: "qbsk_read_screen",
    description:
      "Read back the current painted grid: width, height, the rows of text as drawn, changed-cell count and per-frame ms. Closes the loop — write, run, see what was drawn, compare against intent, correct.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "qbsk_read_window",
    description:
      "Read what QBSK Studio's WINDOW is showing right now: the character grid, what it is showing, how many ms old the snapshot is, and the path of a PNG capture. Different from qbsk_read_screen, which returns what THIS session painted — this returns what the person is looking at.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "qbsk_inspect",
    description:
      "Read one live variable's value and QBSK type (feeds the inspector panel): { name, value, type, binding }. Binding is 'var' | 'const' | 'native'. Fails structurally if the name is not a live binding.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The live binding name." },
      },
      required: ["name"],
    },
  },
  {
    name: "qbsk_list_vars",
    description:
      "List the names of every live top-level binding, so qbsk_inspect knows what it can read.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "qbsk_open",
    description:
      "Read a project file. The path is relative to the project root; a path escaping the root is a structured error, not a permission bypass.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root." },
      },
      required: ["path"],
    },
  },
  {
    name: "qbsk_save",
    description:
      "Write a project file. The path is relative to the project root; a path escaping the root is a structured error.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the project root." },
        source: { type: "string", description: "File contents." },
      },
      required: ["path", "source"],
    },
  },
  {
    name: "qbsk_loop",
    description:
      "Control the frame loop. Commands: 'start' arms it (the host drives frames), 'stop' disarms it (interpreter state is kept), 'step' advances gameTime by dt (default 1/60) and runs exactly one frame, 'status' reports running/frames/error with no side effects, 'reload' re-creates the program from the current source.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["start", "stop", "step", "status", "reload"],
        },
        dt: {
          type: "number",
          description: "Frame delta in seconds, step only (default 1/60).",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "qbsk_key",
    description:
      "Press a key on the loaded program and advance frames — this is how you PLAY it, not just inspect it. Canonical names ('arrow-left', 'space', '.'); a wrong one is an error carrying the right one. `handled` false means nothing is bound to that key; `turn` unchanged means it was a free action. Keys only fire when frames run, so this presses AND steps.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Canonical key name, e.g. 'arrow-up', 'space', 'i', '.'.",
        },
        steps: {
          type: "number",
          description: "Frames to advance after the press (default 1). Turn-based games need 1; an animated reaction needs several.",
        },
        dt: {
          type: "number",
          description: "Seconds per frame (default 1/60).",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "qbsk_trace",
    description:
      "Read the session log: what happened and why, in order. Every tool call, load, key press, turn, print and error as one readable line, newest last. Call it when something behaves unexpectedly — it separates 'no handler' from 'handler ran, move blocked' from 'handler threw', which look identical on the grid. Pass `next` back as `since` to poll; `dropped` reports discarded entries.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max entries to return, newest kept (default 50).",
        },
        since: {
          type: "number",
          description: "Return only entries after this seq — pass the previous call's `next`.",
        },
      },
      required: [],
    },
  },
  {
    name: "qbsk_load",
    description:
      "Run a project file as the program — the source never crosses the wire, so this costs no context. Use it instead of qbsk_open + qbsk_eval. Always loads fresh, so calling it again re-reads from disk (what you want after qbsk_save). Analyzes first by default: `problems` non-empty means NOTHING was loaded. Pass check:false to run a file the analyzer rejects.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root, e.g. 'examples/turns.qbsk'.",
        },
        check: {
          type: "boolean",
          description: "Analyze before running (default true). false loads regardless of analyzer problems.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "qbsk_generate_sprite",
    description:
      "Procedurally generate a 16x16 or 32x32 pixel-art sprite, outlined (an earlier release). Same seed -> same sprite. Writes .qbdata + SVG under examples/res/generated/, returns the SVG inline. Omit `shape` for a free-form blob (untargeted). Pass shape:'sword' for a mask-gated, recognizable silhouette; an unknown shape is a structured error, never a silent blob fallback.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "number", description: "Any integer. Same seed -> same sprite." },
        size: {
          type: "number",
          description: "16 or 32 (default 16) — matches common CDDA/Dwarf Fortress tileset sizes.",
        },
        shape: {
          type: "string",
          description: "Optional. A known silhouette name (currently: 'sword') for mask-gated, targeted generation instead of a free-form blob.",
        },
      },
      required: ["seed"],
    },
  },
];

const RESOURCES: McpResource[] = [
  {
    uri: "qbsk://manual",
    name: "QBSK manual",
    description:
      "The full agent-facing manual: grammar, semantics, natives, scene DSL and runnable examples. Read this first.",
  },
  {
    uri: "qbsk://natives",
    name: "Native function reference",
    description: "Every native function: signature, arity and the exact error it raises.",
  },
  {
    uri: "qbsk://scene-dsl",
    name: "Scene DSL guide",
    description: "The declarative scene syntax: scene, layer, primitives, inert DSL names.",
  },
  {
    uri: "qbsk://language",
    name: "Language spec",
    description: "docs/language.md, verbatim.",
  },
  {
    uri: "qbsk://examples",
    name: "Examples index",
    description: "Every example in examples/ with its actual output.",
  },
];

export class McpServer {
  private initialized = false;

  constructor(
    private readonly host: McpHost,
    private readonly transport: McpTransport,
  ) {}

  private resourceBody(uri: string): string | null {
    const body = this.host.resources().get(uri);
    return body ?? null;
  }

  handle(raw: string): void {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      this.respond(null, {
        code: -32700,
        message: "Parse error: not valid JSON-RPC 2.0",
      });
      return;
    }
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      this.respond(req.id ?? null, { code: -32600, message: "Invalid request" });
      return;
    }
    if (req.id === undefined) {
      // Notification: no response.
      return;
    }
    switch (req.method) {
      case "initialize":
        this.initialized = true;
        this.respond(req.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "qbsk-studio", version: "0.1.0" },
        });
        return;
      case "tools/list":
        this.respond(req.id, { tools: TOOLS });
        return;
      case "resources/list":
        this.respond(req.id, { resources: RESOURCES });
        return;
      case "resources/read": {
        const params = (req.params ?? {}) as { uri?: string };
        const body = params.uri ? this.resourceBody(params.uri) : null;
        if (body === null) {
          this.respond(req.id, { code: -32002, message: "Resource not found" });
          return;
        }
        this.respond(req.id, {
          contents: [{ uri: params.uri, mimeType: "text/markdown", text: body }],
        });
        return;
      }
      case "tools/call": {
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const result = this.callTool(params.name ?? "", params.arguments ?? {});
        this.respond(req.id, result);
        return;
      }
      default:
        this.respond(req.id, { code: -32601, message: "Method not found" });
    }
  }

  private callTool(
    name: string,
    args: Record<string, unknown>,
  ): { content: { type: string; text: string }[] } {
    try {
      switch (name) {
        case "qbsk_check":
          return this.textResult(this.host.check(asString(args.source), asString(args.file, "check.qbsk")));
        case "qbsk_eval":
          return this.textResult(this.host.eval(asString(args.source), asString(args.file, "eval.qbsk")));
        case "qbsk_read_screen":
          return this.textResult(this.host.readScreen());
        case "qbsk_read_window":
          return this.textResult(this.host.readWindow());
        case "qbsk_inspect":
          return this.textResult(this.host.inspect(asString(args.name)));
        case "qbsk_list_vars":
          return this.textResult(this.host.listVars());
        case "qbsk_open":
          return this.textResult(this.host.open(asString(args.path)));
        case "qbsk_save":
          return this.textResult(this.host.save(asString(args.path), asString(args.source)));
        case "qbsk_loop":
          return this.textResult(
            this.host.loop(asLoopCommand(args.command), asNumber(args.dt, 1 / 60)),
          );
        case "qbsk_key":
          return this.textResult(
            this.host.key(
              asString(args.key),
              asNumber(args.steps, 1),
              asNumber(args.dt, 1 / 60),
            ),
          );
        case "qbsk_trace":
          return this.textResult(
            this.host.trace(asNumber(args.limit, 50), asNumber(args.since, 0)),
          );
        case "qbsk_load":
          return this.textResult(
            this.host.load(asString(args.path), args.check !== false),
          );
        case "qbsk_generate_sprite":
          return this.textResult(
            this.host.generateSprite(
              asNumber(args.seed, 0),
              asNumber(args.size, 16),
              // `shape` is declared in the schema and accepted by the host, and was
              // dropped here: every mask-gated request silently produced a blob, which
              // is the "silent fallback" the tool description promises never happens.
              args.shape === undefined ? undefined : asString(args.shape),
            ),
          );
        default:
          throw new Error(`unknown tool '${name}'`);
      }
    } catch (err) {
      return this.textResult(this.errorOf(err));
    }
  }

  private textResult(data: unknown): { content: { type: string; text: string }[] } {
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }

  private errorOf(err: unknown): ToolError {
    const shape: QbskErrorShape = {
      kind: "runtime",
      message: err instanceof Error ? err.message : String(err),
      file: "",
      start: { line: 0, col: 0, offset: 0 },
      end: { line: 0, col: 0, offset: 0 },
      source: "",
      fragment: "",
    };
    return { ok: false, error: shape };
  }

  private respond(
    id: string | number | null,
    payload: unknown,
  ): void {
    let message: unknown;
    if (payload !== null && typeof payload === "object" && "code" in (payload as object)) {
      message = { jsonrpc: "2.0", id, error: payload };
    } else {
      message = { jsonrpc: "2.0", id, result: payload };
    }
    this.transport.send(JSON.stringify(message));
  }
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asLoopCommand(v: unknown): "start" | "stop" | "step" | "status" | "reload" {
  if (
    v === "start" ||
    v === "stop" ||
    v === "step" ||
    v === "status" ||
    v === "reload"
  ) {
    return v;
  }
  throw new Error(`invalid loop command '${String(v)}'`);
}
