// `qbsk fmt` — layout checking (docs/language.md §19).
//
// A checker, not a rewriter: it reports and exits non-zero, and never writes to a file.
// The reason is §19.1 — the lexer discards comments, so an AST-based rewriter would
// delete all 579 of them in examples/.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLayout } from "../../src/tools/layout.js";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const messages = (src: string): string[] =>
  checkLayout(src, "t.qbsk").map((f) => f.message);

describe("indentation is a multiple of 4 (§19.2)", () => {
  it("accepts 4 and 8", () => {
    expect(messages('layer a z: 1\n    fill "."\n        put "x" at (0, 0)\n')).toEqual([]);
  });

  it("reports 3 spaces — the error the language cannot see for you", () => {
    const m = messages('layer a z: 1\n   fill "."\n');
    expect(m[0]).toMatch(/3 spaces is not a multiple of 4/);
  });

  it("reports 6 spaces", () => {
    expect(messages('layer a z: 1\n      fill "."\n')[0]).toMatch(/6 spaces/);
  });

  it("reports a tab, and says what to use instead", () => {
    const m = messages('layer a z: 1\n\tfill "."\n');
    expect(m[0]).toMatch(/tabs are not allowed/);
    expect(m[0]).toMatch(/4 spaces/);
  });

  it("ignores indentation inside a blank line", () => {
    expect(messages("var x = 1\n   \nvar y = 2\n")).toEqual(["trailing whitespace"]);
  });

  it("a leading BOM is not one space of indentation", () => {
    // Found by running the tool on a file this session wrote: Windows editors add a
    // BOM by default, and counting it reported "1 space" on an unindented line —
    // a false positive on a file whose layout is fine. Same reasoning as §15.8.
    expect(messages("\uFEFFlayer a z: 1\n")).toEqual([]);
  });
});

describe("whitespace and blank lines (§19.2)", () => {
  it("reports trailing whitespace", () => {
    expect(messages("var x = 1   \n")).toEqual(["trailing whitespace"]);
  });

  it("allows one blank line, reports two in a row", () => {
    expect(messages("var x = 1\n\nvar y = 2\n")).toEqual([]);
    expect(messages("var x = 1\n\n\nvar y = 2\n")).toEqual([
      "more than one blank line in a row",
    ]);
  });

  it("reports it once per run, not once per line", () => {
    // Four blank lines is one problem, not three.
    expect(messages("var x = 1\n\n\n\n\nvar y = 2\n")).toEqual([
      "more than one blank line in a row",
    ]);
  });

  it("wants exactly one trailing newline", () => {
    expect(messages("var x = 1\n")).toEqual([]);
    expect(messages("var x = 1")).toEqual(["the file does not end in a newline"]);
    expect(messages("var x = 1\n\n")).toEqual([
      "the file ends in more than one newline",
    ]);
  });

  it("says nothing about an empty file", () => {
    expect(messages("")).toEqual([]);
  });
});

describe("a canvas block is spatial data, not layout (§19.2)", () => {
  it("does not report the art's own indentation", () => {
    // The picture IS the indentation. Checking it would report the drawing as an error.
    const src = [
      "canvas hero at (0, 0):",
      '    """',
      "     O",
      "    /|\\",
      "    / \\",
      '    """',
      "",
    ].join("\n");
    expect(messages(src)).toEqual([]);
  });

  it("resumes checking after the block closes", () => {
    const src = [
      "canvas hero at (0, 0):",
      '    """',
      "   O",
      '    """',
      "   var x = 1",
      "",
    ].join("\n");
    // Only the line AFTER the block is reported, not the art inside it.
    expect(messages(src)).toEqual([
      "indentation of 3 spaces is not a multiple of 4 (§2.2)",
    ]);
  });
});

describe("findings carry a span, like every QBSK error (§8)", () => {
  it("points at the indentation, not at the whole line", () => {
    const f = checkLayout('layer a z: 1\n   fill "."\n', "t.qbsk")[0]!;
    expect(f.span.start.line).toBe(2);
    expect(f.span.start.col).toBe(1);
    expect(f.span.end.col).toBe(4);
  });

  it("points at the trailing space, not at the code before it", () => {
    const f = checkLayout("var x = 1   \n", "t.qbsk")[0]!;
    expect(f.span.start.col).toBe(10);
  });
});

describe("the repository's own examples are clean (§19)", () => {
  it("every example passes its own checker", () => {
    // RULE #5 territory: a tool the project ships should hold for the project's code.
    const dir = join(ROOT, "examples");
    const files = readdirSync(dir).filter(
      (f) => f.endsWith(".qbsk") && statSync(join(dir, f)).isFile(),
    );
    expect(files.length).toBeGreaterThan(0);

    const dirty: string[] = [];
    for (const f of files) {
      const found = checkLayout(readFileSync(join(dir, f), "utf8"), f);
      for (const finding of found) {
        dirty.push(`${f}:${finding.span.start.line}: ${finding.message}`);
      }
    }
    expect(dirty.slice(0, 8)).toEqual([]);
  });
});
