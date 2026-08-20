// The GENERATED manual (docs/studio.md §11.6): every agent-facing resource is derived
// from the source of truth, never hand-written. Natives are introspected from
// src/interp/natives.ts (names + arity + exact runtime error), examples are EXECUTED
// and their real output embedded, and semantics come from docs/language.md. The test
// suite re-runs this generator and compares the embedded outputs against fresh runs,
// so a lie in the manual turns a test red.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNatives } from "../../src/interp/natives.js";
import { runQbsk } from "../../src/interp/interpreter.js";

export const LIMIT_ROWS = 24;

function section(doc: string, header: string): string {
  const idx = doc.indexOf(`## ${header}`);
  if (idx === -1) return `(section '${header}' not found in docs/language.md)`;
  const next = doc.indexOf("\n## ", idx + 3);
  const end = next === -1 ? doc.length : next;
  return doc.slice(idx, end).trim();
}

function nativeEntries(): { name: string; arity: string; error: string }[] {
  const env = createNatives({ print: () => {} });
  const out: { name: string; arity: string; error: string }[] = [];
  for (const name of env.names()) {
    const fn = env.get(name);
    let arity = "0";
    let error = "";
    if (fn !== undefined && fn.type === "native") {
      const span = {
        file: "native",
        start: { line: 1, col: 1, offset: 0 },
        end: { line: 1, col: 1, offset: 0 },
      };
      try {
        fn.fn([], span);
      } catch (err) {
        // Only Error instances carry a real QBSK error message. `exit` throws an
        // ExitSignal and zero-arity natives succeed, so both keep arity "0" and a
        // blank error cell.
        if (err instanceof Error) {
          error = err.message;
          const match = /expects (\d+)(?: or (\d+))? arguments/.exec(error);
          if (match !== null) {
            arity = match[2] !== undefined ? `${match[1]}–${match[2]}` : match[1]!;
          }
        }
      }
    }
    out.push({ name, arity, error });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function buildExampleResources(
  examplesDir: string,
  map: Map<string, string>,
): void {
  const stems = readdirSync(examplesDir)
    .filter((f) => f.endsWith(".qbsk"))
    .sort();
  const indexLines = ["# QBSK examples\n", "Each example runs with `qbsk run examples/<file>`:\n"];
  for (const stem of stems) {
    const file = join(examplesDir, stem);
    const source = readFileSync(file, "utf8");
    const res = runQbsk(source, file);
    const lines = res.out;
    const truncated = lines.length > LIMIT_ROWS;
    const shown = truncated ? lines.slice(0, LIMIT_ROWS) : lines;
    const stemName = stem.replace(/\.qbsk$/, "");
    indexLines.push(`- \`qbsk://examples/${stemName}\` — ${stem}`);
    map.set(
      `qbsk://examples/${stemName}`,
      [
        `# ${stem}\n`,
        "## Source",
        "",
        "```qbsk",
        source,
        "```",
        "",
        "## Output (executed)",
        "",
        "```",
        ...(shown.length > 0 ? shown : ["(no output)"]),
        ...(truncated ? ["…"] : []),
        "```",
        "",
        res.error !== null ? `## Error\n\n\`\`\`\n${res.error.message}\n\`\`\`\n` : "",
      ].join("\n"),
    );
  }
  map.set(
    "qbsk://examples",
    indexLines.join("\n") + "\n\nRead `qbsk://examples/<stem>` for source and output.\n",
  );
}

// Build the full resource map for a project root. Cheap enough to run at server
// startup; regenerated (and re-verified) by the test suite on every run.
export function buildResources(projectRoot: string): Map<string, string> {
  const root = resolve(projectRoot);
  const examplesDir = join(root, "examples");
  const languageDoc = readFileSync(join(root, "docs", "language.md"), "utf8");
  const map = new Map<string, string>();

  map.set("qbsk://language", languageDoc);
  map.set("qbsk://scene-dsl", section(languageDoc, "7. Declarative canvas DSL") + "\n");
  map.set(
    "qbsk://natives",
    [
      "# Native function reference (generated)\n",
      "Generated from src/interp/natives.ts — names, arity and the exact error each",
      "function raises when called with the wrong argument count:\n",
      "",
      "| Name | Arity | Arity error when called with 0 args |",
      "|---|---|---|",
      ...nativeEntries().map(
        (e) => `| \`${e.name}\` | ${e.arity} | \`${e.error}\` |`,
      ),
      "",
      "Every native enforces its types with a readable error naming the expected and",
      "the received type; a type error never surfaces as a raw JS throw (RULE #4).",
      "",
    ].join("\n"),
  );

  map.set(
    "qbsk://manual",
    [
      "# QBSK manual (generated)\n",
      "This manual is GENERATED from the source of truth: `docs/language.md`, the native",
      "environment and the executed `examples/`. If it contradicts what you observe,",
      "the manual is wrong and the test suite must have caught it — report it.\n",
      "## 1. Driving the engine\n",
      "You control the running environment through the `qbsk_*` tools: `qbsk_check`",
      "validates without running, `qbsk_eval` runs code against the live program,",
      "`qbsk_read_screen` shows the painted grid, `qbsk_inspect`/`qbsk_list_vars` read",
      "live bindings, `qbsk_open`/`qbsk_save` manage project files, `qbsk_loop` controls",
      "the frame loop. Every QBSK error comes back structured — kind, span, the `^^^`",
      "fragment and a suggestion — so correct yourself and continue; never guess.\n",
      "## 2. A minimal scene\n",
      "A scene declares a width/height and layers of primitives; the DSL re-composes",
      "per frame from live variables (language.md §7.7):\n",
      "```qbsk",
      "var x = 5",
      "scene P(width: 40, height: 10)",
      "  layer l z: 1",
      "    fill \".\"",
      "    put \"@\" at (x, 5)",
      "```",
      "Evaluate it with `qbsk_eval`, then read the grid with `qbsk_read_screen`.",
      "Mutate `x` with `qbsk_eval`, step the loop, read the screen again — the `@` moves.\n",
      "## 3. Language semantics\n",
      section(languageDoc, "6. Semantics"),
      "\n## 4. Scene DSL\n",
      section(languageDoc, "7. Declarative canvas DSL"),
      "\n## 5. Natives\n",
      "See `qbsk://natives` for the full table. Short form:\n",
      nativeEntries()
        .map((e) => `- \`${e.name}\` — ${e.arity} args`)
        .join("\n"),
      "\n## 6. Examples\n",
      "See `qbsk://examples`. Each has its source and its REAL executed output.",
      "",
    ].join("\n"),
  );

  buildExampleResources(examplesDir, map);
  return map;
}
