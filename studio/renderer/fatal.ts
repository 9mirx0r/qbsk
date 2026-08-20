// The failure a user can actually see.
//
// A boot failure used to go to the MCP log panel — a collapsible strip inside the window.
// So when the renderer failed to start, the Studio opened to a window that did nothing and
// said nothing, and the only diagnostic available was `npm run smoke` reporting "no report
// from renderer" with no reason attached. That cost a whole session to find, and what it
// was in the end was a stale build.
//
// ⚠️ THE STYLES ARE APPLIED THROUGH THE CSSOM, NOT AS `style=` ATTRIBUTES, and that is not
// a preference. The Studio's CSP is `style-src 'self'`, so an inline style attribute is
// REFUSED: the first version of this file built the overlay as an HTML string, passed its
// unit tests, and rendered unstyled in the real window. It was found by deliberately
// breaking the boot and looking — which is the only way an error path ever gets checked.
//
// Nothing here reaches for the stylesheet, the font or a class name either. An overlay that
// needs the stylesheet cannot report a broken stylesheet, and the most likely thing to have
// failed is exactly what a normal panel would have leaned on.

/** One line of the overlay: its text, and the styles that make it readable. */
export interface FatalPart {
  text: string;
  style: Record<string, string>;
}

export interface FatalReport {
  /** What failed, in three or four words. */
  title: string;
  /** The error's own message. */
  message: string;
  /** Where it came from — a file and line, a stack, or nothing. */
  detail?: string;
  /** What to try. Omitted when there is nothing honest to suggest. */
  hint?: string;
}

export const OVERLAY_ID = "qbsk-fatal";

/** The overlay's own box: fixed, opaque, and above everything. */
export const OVERLAY_STYLE: Record<string, string> = {
  position: "fixed",
  inset: "0",
  "z-index": "2147483647",
  background: "#0a0a0a",
  color: "#ffb000",
  font: "14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
  padding: "48px",
  overflow: "auto",
  "white-space": "pre-wrap",
  "word-break": "break-word",
};

/**
 * The overlay as DATA — every line and every style, and no DOM anywhere.
 *
 * Returned this way so it can be asserted without a browser, which is the only reason it
 * gets tested at all. An error path nobody tests is an error path that fails when it is
 * finally needed, and this one already failed once.
 */
export function fatalParts(report: FatalReport): FatalPart[] {
  const parts: FatalPart[] = [
    { text: report.title, style: { "font-size": "20px", "font-weight": "700" } },
    { text: "─".repeat(48), style: { color: "#7a5200", margin: "18px 0" } },
    { text: report.message, style: { color: "#ff5555" } },
  ];
  if (report.detail !== undefined && report.detail !== "") {
    parts.push({ text: report.detail, style: { color: "#8a8a8a", "margin-top": "16px" } });
  }
  if (report.hint !== undefined && report.hint !== "") {
    parts.push({ text: report.hint, style: { "margin-top": "22px" } });
  }
  return parts;
}

/**
 * The hint for a failure that happened before the window had drawn anything.
 *
 * A stale `dist-studio` is the failure this Studio has actually had — `npm start` did not
 * build before launching until 2026-08-20, so anyone on an older checkout meets it first.
 * Naming the likeliest cause is worth more than naming none.
 */
export const BOOT_HINT =
  "This usually means the build is out of date. Run `npm run build` in the repository " +
  "root and start the Studio again.";

/**
 * Puts the overlay on screen, once.
 *
 * Idempotent on purpose: a boot failure often arrives twice — the rejection and then the
 * unhandled error — and two stacked overlays hide the first message, which is the one that
 * says what happened.
 *
 * Text goes in through `textContent`, so an error message containing `<` is shown rather
 * than parsed. `innerHTML` here would make a diagnostic into an injection point.
 */
export function showFatal(doc: Document, report: FatalReport): boolean {
  if (doc.getElementById(OVERLAY_ID) !== null) {
    return false;
  }
  const box = doc.createElement("div");
  box.id = OVERLAY_ID;
  box.setAttribute("role", "alert");
  for (const [k, v] of Object.entries(OVERLAY_STYLE)) {
    box.style.setProperty(k, v);
  }
  for (const part of fatalParts(report)) {
    const row = doc.createElement("div");
    row.textContent = part.text;
    for (const [k, v] of Object.entries(part.style)) {
      row.style.setProperty(k, v);
    }
    box.appendChild(row);
  }
  doc.body.appendChild(box);
  return true;
}
