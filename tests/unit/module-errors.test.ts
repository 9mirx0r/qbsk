// An error from a module shows the module's own line (docs/language.md §15.24).
//
// `qbskFragment` indexed whatever source it was handed, regardless of which file the
// error's span named. So an error inside a `use`d module printed the module's file and
// line in the header and then, underneath, the line at that NUMBER in the ENTRY file —
// a caret under a line that had nothing to do with it. §15.20 made it worse by printing
// file names in the trace, so the header was right, the trace was right, and the one
// part an author reads first was wrong.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQbsk } from "../../src/interp/interpreter.js";
import { formatQbskError } from "../../src/interp/error.js";

function inFolder(files: Record<string, string>): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), "qbsk-mod-"));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text, "utf8");
  }
  return { dir, entry: join(dir, "main.qbsk") };
}

function fails(files: Record<string, string>): string {
  const { dir, entry } = inFolder(files);
  const source = files["main.qbsk"]!;
  const r = runQbsk(source, entry, { print: () => {} }, { baseDir: dir });
  expect(r.error, "the program was supposed to fail").not.toBeNull();
  return formatQbskError(source, r.error!);
}

describe("the fragment comes from the file the span names", () => {
  it("shows the module's line, not the entry file's line of that number", () => {
    const out = fails({
      "lib.qbsk": ["export func take(xs, at)", "    return xs[at]", ""].join("\n"),
      "main.qbsk": [
        'use "lib.qbsk" as lib',
        "func caller()",
        "    return lib.take([1, 2], 1.5)",
        "print(str(caller()))",
      ].join("\n"),
    });
    // Line 2 of lib.qbsk is `return xs[at]`. Line 2 of main.qbsk is `func caller()`,
    // which is what used to be printed.
    expect(out).toContain("return xs[at]");
    expect(out).not.toContain("func caller()");
  });

  it("still puts the caret under the failing expression", () => {
    const out = fails({
      "lib.qbsk": ["export func take(xs, at)", "    return xs[at]", ""].join("\n"),
      "main.qbsk": ['use "lib.qbsk" as lib', "print(str(lib.take([1], 1.5)))"].join("\n"),
    });
    const fragment = out.split("\n").find((l) => l.includes("^"));
    expect(fragment).toBeDefined();
    // The caret column is measured against the module's line.
    const line = out.split("\n").find((l) => l.includes("return xs[at]"))!;
    expect(line.indexOf("xs[at]")).toBe(fragment!.indexOf("^"));
  });

  it("names the module in the trace and in the header", () => {
    const out = fails({
      "lib.qbsk": ["export func take(xs, at)", "    return xs[at]", ""].join("\n"),
      "main.qbsk": ['use "lib.qbsk" as lib', "print(str(lib.take([1], 1.5)))"].join("\n"),
    });
    expect(out).toContain("lib.qbsk:2:");
    expect(out).toContain("in take");
  });

  it("leaves an error in the entry file exactly as it was", () => {
    const out = fails({
      "main.qbsk": ["var xs = [1]", "print(str(xs[1.5]))"].join("\n"),
    });
    expect(out).toContain("print(str(xs[1.5]))");
    expect(out).toContain("main.qbsk:2:");
  });
});
