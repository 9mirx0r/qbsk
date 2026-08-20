// What the live program is holding (docs/studio.md §19).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clip,
  emptyText,
  MAX_ROWS,
  MAX_TEXT,
  moreText,
  orderRows,
  type InspectRow,
} from "../../studio/shared/inspect.js";

function row(name: string, type: string, text = "1"): InspectRow {
  return { name, type, text };
}

describe("a value is clipped before it reaches the pane", () => {
  it("leaves a short value alone", () => {
    expect(clip("[1, 2, 3]")).toBe("[1, 2, 3]");
  });

  it("clips a long one and says so", () => {
    const long = "x".repeat(500);
    const out = clip(long);
    expect(out).toHaveLength(MAX_TEXT);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a value of exactly the limit alone", () => {
    const exact = "y".repeat(MAX_TEXT);
    expect(clip(exact)).toBe(exact);
  });

  it("takes a limit of its own", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
  });
});

describe("the rows that change come first", () => {
  it("puts values above functions", () => {
    const rows = orderRows([
      row("attack", "func"),
      row("hp", "int"),
      row("defend", "func"),
      row("name", "str"),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["hp", "name", "attack", "defend"]);
  });

  it("keeps the order inside each group, so a row does not jump between refreshes", () => {
    const rows = orderRows([row("a", "int"), row("b", "int"), row("c", "int")]);
    expect(rows.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("treats a native like a function", () => {
    const rows = orderRows([row("clock", "native"), row("hp", "int")]);
    expect(rows.map((r) => r.name)).toEqual(["hp", "clock"]);
  });

  it("survives having nothing to order", () => {
    expect(orderRows([])).toEqual([]);
  });
});

describe("the two nothings are different sentences", () => {
  it("tells someone who has not pressed Run what to do", () => {
    expect(emptyText(false)).toContain("press Run");
  });

  it("does not send someone with a running program looking for a bug", () => {
    // "no variables" to someone who has not started anything reads as a fault in their
    // code rather than as a step they have not taken.
    expect(emptyText(true)).not.toContain("press Run");
    expect(emptyText(true)).toContain("running");
  });
});

describe("the pane no longer promises a feature instead of having one", () => {
  const studioDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../studio");

  it("the placeholder sentence is gone from the markup", () => {
    const html = readFileSync(join(studioDir, "renderer/index.html"), "utf8");
    expect(html).not.toContain("Populated in Phase 12");
  });

  it("the renderer actually asks for the names", () => {
    const source = readFileSync(join(studioDir, "renderer/renderer.ts"), "utf8");
    expect(source).toContain("api.inspect(");
  });

  it("the pane's rows are built with textContent, never innerHTML", () => {
    // A QBSK string can contain `<`, and this pane's whole job is showing values a
    // program made up.
    const source = readFileSync(join(studioDir, "renderer/renderer.ts"), "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toContain("innerHTML");
  });
});

describe("the pane says what the cap left out", () => {
  it("says nothing when it left nothing out", () => {
    expect(moreText(12, 12)).toBe("");
    expect(moreText(200, 200)).toBe("");
  });

  it("counts the ones it hid", () => {
    // A pane that shows 200 of 1,201 names without saying so is lying about what the
    // program holds.
    expect(moreText(200, 1201)).toBe("… and 1001 more");
  });

  it("never reports a negative remainder", () => {
    expect(moreText(5, 3)).toBe("");
  });

  it("caps at a number a person could actually read", () => {
    // Measured at 1,201 names: 12.7 ms per refresh and 85 KB across IPC four times a
    // second. Capped: 2.8 ms and 14.7 KB.
    expect(MAX_ROWS).toBeLessThanOrEqual(500);
    expect(MAX_ROWS).toBeGreaterThan(50);
  });
});
