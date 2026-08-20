// The error, on the line that caused it (docs/studio.md §18).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  gutterRows,
  headline,
  lineCount,
  markedRange,
  sameRange,
  selectionFor,
  stripText,
  type ErrorMark,
} from "../../studio/shared/marks.js";

function mark(over: Partial<ErrorMark> = {}): ErrorMark {
  return {
    line: 2,
    col: 5,
    endLine: 2,
    endCol: 9,
    offset: 10,
    endOffset: 14,
    message: "a list index must be an int, got 'float'",
    ...over,
  };
}

describe("the gutter counts lines the way an editor shows them", () => {
  it("an empty document is one line, not zero", () => {
    expect(lineCount("")).toBe(1);
  });

  it("a trailing newline does not open a row", () => {
    // `"a\n".split("\n")` is ["a", ""] and would claim two.
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb\n")).toBe(2);
  });

  it("counts lines with no trailing newline", () => {
    expect(lineCount("a\nb\nc")).toBe(3);
  });

  it("counts blank lines in the middle", () => {
    expect(lineCount("a\n\n\nb")).toBe(4);
  });
});

describe("the gutter marks the error", () => {
  it("marks the line the error is on and no other", () => {
    const rows = gutterRows("a\nb\nc", mark({ line: 2, endLine: 2 }));
    expect(rows.map((r) => r.bad)).toEqual([false, true, false]);
  });

  it("marks every line of a span that covers more than one", () => {
    // A construct that spans lines failed on all of them; pointing at one end is half
    // an answer.
    const rows = gutterRows("a\nb\nc\nd", mark({ line: 2, endLine: 3 }));
    expect(rows.map((r) => r.bad)).toEqual([false, true, true, false]);
  });

  it("marks nothing when there is no error", () => {
    const rows = gutterRows("a\nb\nc", null);
    expect(rows.every((r) => !r.bad)).toBe(true);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3]);
  });
});

describe("clicking the error puts the caret on it", () => {
  it("selects exactly the span", () => {
    expect(selectionFor("0123456789abcdef", mark({ offset: 10, endOffset: 14 }))).toEqual({
      start: 10,
      end: 14,
    });
  });

  it("clamps to a document that got shorter since the run", () => {
    // The author deletes lines between the run and the click. Unclamped, this throws
    // inside the DOM and the fatal overlay appears because someone pressed backspace.
    expect(selectionFor("short", mark({ offset: 10, endOffset: 14 }))).toEqual({
      start: 5,
      end: 5,
    });
  });

  it("never returns an end before its start", () => {
    const s = selectionFor("0123456789abcdef", mark({ offset: 12, endOffset: 4 }));
    expect(s.end).toBeGreaterThanOrEqual(s.start);
  });

  it("places a caret for a zero-width span", () => {
    expect(selectionFor("abcdef", mark({ offset: 3, endOffset: 3 }))).toEqual({
      start: 3,
      end: 3,
    });
  });
});

describe("the strip says where and what", () => {
  it("names the line, the column and the message", () => {
    expect(stripText(mark())).toBe(
      "line 2, col 5 — a list index must be an int, got 'float'",
    );
  });

  it("takes only the first line of a rendered error", () => {
    const rendered = [
      "t.qbsk:88:24 — runtime: a list index must be an int, got 'float'",
      "   |",
      "88 |     return table[at]",
      "   |            ^^^^^^^^^",
      "   in lookup (t.qbsk:88)",
    ].join("\n");
    expect(headline(rendered)).toBe("runtime: a list index must be an int, got 'float'");
  });

  it("drops the location, which the strip already says in its own words", () => {
    expect(headline("t.qbsk:3:1 — parse: expected ')'")).toBe("parse: expected ')'");
  });

  it("survives a line with no dash at all", () => {
    expect(headline("something went wrong")).toBe("something went wrong");
  });

  it("survives an empty string", () => {
    expect(headline("")).toBe("");
  });
});

// --- The parts a unit test cannot reach: the markup and the alignment ------------

const studioDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../studio");
const html = readFileSync(join(studioDir, "renderer/index.html"), "utf8");
const css = readFileSync(join(studioDir, "renderer/styles.css"), "utf8");

/** The declarations of one CSS rule, by selector. */
function rule(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThan(-1);
  const body = css.slice(start + selector.length + 2, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const line of body.split(";")) {
    const colon = line.indexOf(":");
    if (colon > -1) {
      out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return out;
}

describe("the gutter is built where it can line up", () => {
  it("sits beside the textarea, not inside it", () => {
    // A textarea cannot style a range, so the numbers have to be a sibling. If they
    // ever end up inside it, they become part of the source the author is editing.
    const body = html.slice(html.indexOf('id="editorBody"'), html.indexOf("</textarea>"));
    expect(body).toContain('id="gutter"');
    expect(body).toContain('id="editor"');
  });

  it("matches the editor's font size, line height and top padding", () => {
    // THE failure mode of a gutter: a line-height that differs by a hair looks right in
    // a ten-line file and is a whole line out at line 200. Asserted here because no
    // amount of looking at a short file would catch it.
    const g = rule("#gutter");
    const e = rule("#editor");
    expect(g["font-size"]).toBe(e["font-size"]);
    expect(g["line-height"]).toBe(e["line-height"]);
    expect(g["font-family"]).toBe(e["font-family"]);
    expect(g["padding"]?.split(" ")[0]).toBe(e["padding"]?.split(" ")[0]);
  });

  it("marks the bad line with a background rather than a character", () => {
    // A marker glyph in the gutter would push that line's digits over by one.
    const bad = rule(".gut-bad");
    expect(bad["background"]).toBeDefined();
    expect(css).toContain("--bad:");
  });

  it("starts with the strip hidden", () => {
    const strip = html.slice(html.indexOf('id="errorStrip"'));
    expect(strip.slice(0, strip.indexOf(">"))).toContain("hidden");
  });

  it("puts the strip in the editor pane, not in the log at the bottom", () => {
    const pane = html.slice(
      html.indexOf('id="editorPane"'),
      html.indexOf('id="inspectorPane"'),
    );
    expect(pane).toContain('id="errorStrip"');
  });

  it("never builds the strip's text with innerHTML", () => {
    // An error message can contain `<`. A diagnostic that parses its own text as markup
    // is an injection point, and this is the file that would do it.
    const source = readFileSync(join(studioDir, "renderer/renderer.ts"), "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toContain("innerHTML");
  });
});

describe("the gutter cannot go stale (the bug the DOM tests could not see)", () => {
  const source = readFileSync(join(studioDir, "renderer/renderer.ts"), "utf8");

  it("every write to the editor goes through one helper", () => {
    // Assigning to `editor.value` fires no `input` event, and the gutter listens for
    // one. Both writes in this file bypassed it: the gutter was empty at boot and
    // showed the previous file's numbers after an open. Fixing the two sites would
    // have left the third to be written later.
    const writes = [...source.matchAll(/editor\.value\s*=/g)];
    expect(writes).toHaveLength(1);
    const only = source.slice(0, writes[0]!.index);
    expect(only.slice(only.lastIndexOf("function "))).toContain("setEditorSource");
  });

  it("that helper redraws the gutter and clears the previous file's mark", () => {
    const start = source.indexOf("function setEditorSource");
    const body = source.slice(start, source.indexOf("}", start));
    expect(body).toContain("showError(null)");
    expect(body).toContain("updateLnCol()");
  });
});

describe("the marked range, tracked apart from the row numbers", () => {
  it("is null when nothing failed", () => {
    expect(markedRange(null)).toBeNull();
  });

  it("covers one line for a single-line span", () => {
    expect(markedRange(mark({ line: 4, endLine: 4 }))).toEqual({ from: 4, to: 4 });
  });

  it("covers the whole span when it crosses lines", () => {
    expect(markedRange(mark({ line: 2, endLine: 5 }))).toEqual({ from: 2, to: 5 });
  });

  it("survives a span that arrives inverted", () => {
    // Marked nothing and left the previous mark on screen, before this.
    expect(markedRange(mark({ line: 7, endLine: 3 }))).toEqual({ from: 3, to: 7 });
  });

  it("compares two ranges, nulls included", () => {
    expect(sameRange(null, null)).toBe(true);
    expect(sameRange(null, { from: 1, to: 1 })).toBe(false);
    expect(sameRange({ from: 1, to: 2 }, { from: 1, to: 2 })).toBe(true);
    expect(sameRange({ from: 1, to: 2 }, { from: 1, to: 3 })).toBe(false);
  });
});
