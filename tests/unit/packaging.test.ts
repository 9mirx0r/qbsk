import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function runNpm(args: string[]): string {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileSync(npm, args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

describe("packaging: qbsk is an installable npm package", () => {
  it("bin maps the qbsk command to the compiled CLI entry", () => {
    expect(pkg.bin).toEqual({ qbsk: "./dist/cli/main.js" });
  });

  it("files whitelist only dist/, LICENSE and package.json", () => {
    expect(pkg.files).toEqual(["dist/", "LICENSE"]);
    expect(existsSync(join(root, "LICENSE"))).toBe(true);
  });

  it("engines.node targets the LTS line", () => {
    expect(pkg.engines.node).toBe(">=24");
  });

  it("prepack builds before packing", () => {
    expect(pkg.scripts.prepack).toBe("npm run build");
  });

  it("the CLI source carries a shebang", () => {
    const src = readFileSync(join(root, "src", "cli", "main.ts"), "utf8");
    expect(src.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("CLI version and package.json version agree", () => {
    const src = readFileSync(join(root, "src", "cli", "main.ts"), "utf8");
    const m = src.match(/const VERSION = "([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(pkg.version);
  });

  // This test runs a full build AND a pack — real I/O and a tsc compile. The
  // 5s vitest default is routinely crossed under load, so it gets a timeout
  // that fits the work it does. Never shrink the assertions to save time.
  it(
    "npm pack --dry-run ships only whitelisted files and the CLI runs",
    () => {
      runNpm(["run", "build"]);
      const out = runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
      const jsonStart = out.indexOf("[");
      expect(jsonStart).toBeGreaterThanOrEqual(0);
      const [summary] = JSON.parse(out.slice(jsonStart)) as Array<{
        files: { path: string }[];
      }>;
      expect(summary).toBeDefined();
      const paths = summary!.files.map((f) => f.path);
      expect(paths).toContain("LICENSE");
      expect(paths).toContain("package.json");
      for (const p of paths) {
        expect(p).toMatch(/^(dist\/.+|README\.md|LICENSE|package\.json)$/);
      }
      const entry = join(root, "dist", "cli", "main.js");
      expect(existsSync(entry)).toBe(true);
      const firstLine = readFileSync(entry, "utf8").split("\n", 1)[0];
      expect(firstLine).toBe("#!/usr/bin/env node");
    },
    30000,
  );
});
