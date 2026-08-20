// stdio transport entry for the embedded MCP server (docs/studio.md §11.2):
// JSON-RPC 2.0 over stdin/stdout, one JSON object per line. No socket, no port.
// Usage: node studio/mcp/stdio.ts [--root <projectRoot>]
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { McpServer } from "./server.js";
import { McpSessionHost } from "./session.js";
import { buildResources } from "./generate-manual.js";

const rootIndex = process.argv.indexOf("--root");
const root =
  rootIndex !== -1 && process.argv[rootIndex + 1] !== undefined
    ? resolve(process.argv[rootIndex + 1]!)
    : process.cwd();

const resources = buildResources(root);
const host = new McpSessionHost(root, resources);
const server = new McpServer(host, {
  send: (message) => process.stdout.write(message + "\n"),
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  server.handle(trimmed);
});

// The session ends when its client does: stdin closing is the agent disconnecting.
// The `end` journal record is what stops the window from freezing on a stale frame
// (docs/studio.md §12.4) — without this handler it never fires, because nothing
// else in this process knows the session is over. The exit handler covers every
// other way out, including a parent that kills us mid-transport.
rl.on("close", () => host.end());
process.on("exit", () => host.end());
