export interface CliArgs {
  command: string;
  file: string | null;
  flags: string[];
  flagValues: Record<string, string>;
  scriptArgs: string[];
}

const COMMANDS = new Set(["run", "repl", "lex", "parse", "check", "profile", "fmt"]);

const VALUE_FLAGS = new Set(["fps", "frames"]);

export function parseArgs(argv: string[]): CliArgs | null {
  if (argv.length === 0) {
    return null;
  }
  const first = argv[0];
  if (first === undefined) {
    return null;
  }
  if (first === "--version" || first === "-v" || first === "version") {
    return { command: "version", file: null, flags: [], flagValues: {}, scriptArgs: [] };
  }
  if (first === "--help" || first === "-h" || first === "help") {
    return { command: "help", file: null, flags: [], flagValues: {}, scriptArgs: [] };
  }
  if (!COMMANDS.has(first)) {
    return null;
  }
  const positionals: string[] = [];
  const flags: string[] = [];
  const flagValues: Record<string, string> = {};
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      const name = a.slice(2, eq);
      flagValues[name] = a.slice(eq + 1);
      continue;
    }
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (VALUE_FLAGS.has(name)) {
        const value = rest[i + 1];
        // §15.8 — a negative number is a VALUE, not the next flag. The old guard
        // rejected anything starting with `-`, so `--fps -5` silently degraded to a
        // boolean flag and the loop ran at the default rate: the author set a frame
        // rate, the CLI ignored it, and nothing said so. Values that look like a
        // number are taken; a real following flag (`--loop`) still is not.
        if (value !== undefined && (!value.startsWith("-") || /^-?\d+(\.\d+)?$/.test(value))) {
          flagValues[name] = value;
          i += 1;
          continue;
        }
      }
      flags.push(name);
      continue;
    }
    if (a.startsWith("-")) {
      flags.push(a.slice(1));
      continue;
    }
    positionals.push(a);
  }
  const file = positionals[0] ?? null;
  const scriptArgs = positionals.slice(1);
  return { command: first, file, flags, flagValues, scriptArgs };
}
