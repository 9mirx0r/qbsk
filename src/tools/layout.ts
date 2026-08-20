// Layout checking for `qbsk fmt` (docs/language.md §19).
//
// A CHECKER, not a rewriter, and that is a design decision rather than a stage. The
// lexer discards comments — they reach no token, no node, no printer — so the obvious
// "parse and print the AST back" design would delete all 579 comments in examples/. A
// rewriter needs comment-carrying tokens first; §19.1 records that so the next person
// does not rediscover it by destroying somebody's file.
//
// This module is pure: text in, findings out. It never touches the file system, which
// is what makes it impossible for it to corrupt anything.

import type { Span } from "../lexer/token.js";
import { makeSpan } from "../lexer/token.js";

export interface LayoutFinding {
  message: string;
  span: Span;
}

const INDENT_WIDTH = 4;

/** A span covering columns [from, to) of a 1-based line. */
function spanOf(file: string, line: number, from: number, to: number): Span {
  return makeSpan(
    file,
    { line, col: from, offset: 0 },
    { line, col: Math.max(to, from + 1), offset: 0 },
  );
}

/**
 * Layout problems in a QBSK source file, in reading order.
 *
 * Checks LAYOUT only (§19.2). Naming, spacing inside expressions and line length are
 * style opinions, and a tool that enforced opinions on a language this young would be
 * arguing about taste while the language settles.
 */
export function checkLayout(source: string, file: string): LayoutFinding[] {
  const findings: LayoutFinding[] = [];
  // Normalise line endings for analysis; CRLF is not a layout defect on Windows. A
  // leading BOM is consumed for the same reason the lexer consumes it (§15.8): it is
  // invisible, Windows editors write it by default, and counting it as indentation
  // would report "1 space" on a line indented by none.
  const text = source
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  // A `"""` block is raw spatial data (§2.4): its indentation IS the picture, so every
  // rule below is suspended inside one. Checking it would report the art as an error.
  let inCanvasBlock = false;

  let blankRun = 0;
  for (const [i, line] of lines.entries()) {
    const lineNo = i + 1;

    const fenceCount = (line.match(/"""/g) ?? []).length;
    if (inCanvasBlock) {
      if (fenceCount % 2 === 1) {
        inCanvasBlock = false;
      }
      continue;
    }

    if (line.trim().length === 0) {
      blankRun += 1;
      // The last element of split("\n") is the text after the final newline; an empty
      // one there means the file ends in a newline, which is what we want.
      if (blankRun === 2 && i < lines.length - 1) {
        findings.push({
          message: "more than one blank line in a row",
          span: spanOf(file, lineNo, 1, 1),
        });
      }
    } else {
      blankRun = 0;
    }

    if (fenceCount % 2 === 1) {
      inCanvasBlock = true;
      // The opening line still gets the checks below; the block's contents do not.
    }

    if (line.trim().length > 0) {
      const indent = line.length - line.trimStart().length;
      const ws = line.slice(0, indent);

      if (ws.includes("\t")) {
        findings.push({
          message:
            "tabs are not allowed for indentation: use 4 spaces (§2.2)",
          span: spanOf(file, lineNo, 1, indent + 1),
        });
      } else if (indent % INDENT_WIDTH !== 0) {
        findings.push({
          message: `indentation of ${indent} spaces is not a multiple of ${INDENT_WIDTH} (§2.2)`,
          span: spanOf(file, lineNo, 1, indent + 1),
        });
      }
    }

    if (/[ \t]+$/.test(line)) {
      const from = line.replace(/[ \t]+$/, "").length + 1;
      findings.push({
        message: "trailing whitespace",
        span: spanOf(file, lineNo, from, line.length + 1),
      });
    }
  }

  if (text.length > 0) {
    if (!text.endsWith("\n")) {
      findings.push({
        message: "the file does not end in a newline",
        span: spanOf(file, lines.length, 1, 1),
      });
    } else if (text.endsWith("\n\n")) {
      findings.push({
        message: "the file ends in more than one newline",
        span: spanOf(file, lines.length, 1, 1),
      });
    }
  }

  return findings;
}
