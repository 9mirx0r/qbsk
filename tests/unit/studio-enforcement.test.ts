import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// An earlier release, criterion 4: the one-way dependency arrow of docs/studio.md §2.
// `src/` must never import Electron and must never import from `studio/`.
// The rule is worthless if nothing checks it — this test is the check.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE =
  /\bfrom\s*["']([^"']+)["']|import\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g;

describe("studio: the one-way dependency arrow (docs/studio.md §2)", () => {
  const srcFiles = listTsFiles(join(root, "src"));

  it("src/ has TS files to scan (the test is not vacuously green)", () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it("no src/ file imports electron", () => {
    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      const specs: string[] = [];
      for (const m of source.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (spec !== undefined) {
          specs.push(spec);
        }
      }
      const bad = specs.filter((s) => s === "electron");
      expect(
        bad,
        `${relative(root, file)} imports Electron: [${bad.join(", ")}]`,
      ).toEqual([]);
    }
  });

  it("no src/ file imports from studio/", () => {
    for (const file of srcFiles) {
      const source = readFileSync(file, "utf8");
      const specs: string[] = [];
      for (const m of source.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (spec !== undefined) {
          specs.push(spec);
        }
      }
      const bad = specs.filter((s) => s.includes("studio"));
      expect(
        bad,
        `${relative(root, file)} imports from studio/: [${bad.join(", ")}]`,
      ).toEqual([]);
    }
  });

  it("root package.json has no electron dependency (Electron lives only in studio/)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps).not.toHaveProperty("electron");
  });

  it("the shipped build (tsconfig.build.json) compiles only src/", () => {
    const build = JSON.parse(
      readFileSync(join(root, "tsconfig.build.json"), "utf8"),
    );
    expect(build.include).toEqual(["src"]);
  });

  it("studio/package.json \"main\" resolves to a real file after a build", () => {
    // Electron resolves `main` relative to the package.json directory. A stale
    // or wrong path is invisible to tsc, eslint and this suite's other tests —
    // it only breaks when a human launches the app.
    const pkg = JSON.parse(
      readFileSync(join(root, "studio", "package.json"), "utf8"),
    );
    expect(pkg.main).toBeDefined();
    const entry = resolve(root, "studio", pkg.main);
    expect(relative(root, entry)).toMatch(/^dist-studio[\\/]/);
    expect(entry.endsWith(".js")).toBe(true);
    expect(
      existsSync(entry),
      `studio/package.json "main" (${pkg.main}) does not exist — run "npm run build" in studio/`,
    ).toBe(true);
  });
});
