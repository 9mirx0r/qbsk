// The failure a user can actually see (studio/renderer/fatal.ts).
//
// A boot failure used to go to the MCP log panel — a collapsible strip inside the window —
// so the Studio opened to a window that did nothing and said nothing. The only diagnostic
// was `npm run smoke` reporting "no report from renderer" with no reason, and finding the
// real cause (a stale build) took a whole session.
//
// ⚠️ THE FIRST VERSION OF THIS FILE PASSED AND WAS WRONG. It built the overlay as an HTML
// string with `style=` attributes, which the Studio's CSP (`style-src 'self'`) REFUSES —
// so it rendered unstyled in the real window while every case here went green. It was
// caught by deliberately breaking the boot and looking at the window, and that is why the
// styles are now data applied through the CSSOM, and why this file asserts the shape rather
// than a blob of markup.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fatalParts, OVERLAY_STYLE, OVERLAY_ID, BOOT_HINT } from "../../studio/renderer/fatal.js";

const text = (report: Parameters<typeof fatalParts>[0]): string =>
  fatalParts(report).map((p) => p.text).join("\n");

describe("the overlay says what happened", () => {
  it("carries the title, the message, the detail and the hint", () => {
    const shown = text({
      title: "The Studio could not start",
      message: "Cannot find module './painter.js'",
      detail: "renderer.js:1",
      hint: BOOT_HINT,
    });
    expect(shown).toContain("The Studio could not start");
    expect(shown).toContain("Cannot find module");
    expect(shown).toContain("renderer.js:1");
    expect(shown).toContain("npm run build");
  });

  it("names the likeliest cause, because this Studio has actually had it", () => {
    expect(BOOT_HINT).toContain("build is out of date");
  });

  it("omits the detail and the hint when there is nothing honest to say", () => {
    // A blank row under the message reads as missing information rather than as absence.
    const parts = fatalParts({ title: "Failed", message: "boom" });
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.text.length > 0)).toBe(true);
  });

  it("puts the message where the eye lands, in the alarm colour", () => {
    const parts = fatalParts({ title: "t", message: "m" });
    expect(parts[2]!.text).toBe("m");
    expect(parts[2]!.style["color"]).toBe("#ff5555");
  });
});

describe("it depends on nothing that might itself be broken", () => {
  it("covers the window and sits above everything", () => {
    expect(OVERLAY_STYLE["position"]).toBe("fixed");
    expect(OVERLAY_STYLE["inset"]).toBe("0");
    expect(OVERLAY_STYLE["z-index"]).toBe("2147483647");
  });

  it("paints its own background, so a broken stylesheet cannot hide it", () => {
    expect(OVERLAY_STYLE["background"]).toBeTruthy();
    expect(OVERLAY_STYLE["color"]).toBeTruthy();
    expect(OVERLAY_STYLE["font"]).toContain("monospace");
  });

  it("names itself, so a second failure can tell it is already there", () => {
    // Two stacked overlays hide the first message, and the first is the one that says what
    // happened — a boot failure often arrives twice, as a rejection and then as an error.
    expect(OVERLAY_ID).toBe("qbsk-fatal");
  });
});

describe("what the CSP and the injection risk require of the source", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "..", "..", "studio", "renderer", "fatal.ts"),
    "utf8",
  );

  it("never builds a `style=` attribute, which the CSP refuses", () => {
    // `style-src 'self'` blocks inline style attributes and `<style>` blocks. Setting
    // properties through `element.style` is CSSOM and is not covered — that is the only
    // route that survives, and the first version took the other one.
    expect(source).not.toMatch(/style="/);
    expect(source).toContain("style.setProperty");
  });

  it("never uses innerHTML or insertAdjacentHTML for the message", () => {
    // An error message is text and often contains `<`. `textContent` shows it;
    // `innerHTML` would make a diagnostic into an injection point.
    // USE, not mention: the first version of this assertion matched the word anywhere and
    // failed on the comment two lines above it, which is a test measuring its own prose.
    const code = source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(code).not.toMatch(/\.innerHTML\s*=/);
    expect(code).not.toMatch(/insertAdjacentHTML\s*\(/);
    expect(code).toContain("textContent");
  });
});
