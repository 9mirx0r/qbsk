// `npm run doctor` — what this terminal can and cannot do.
//
// Written because "no se ve nada" has at least four different causes on Windows and they
// are not distinguishable by looking: the frame loop needs a real TTY, a window at least
// 113 x 48, ANSI escape processing, and truecolor. A terminal missing any one of them
// shows either nothing or a wall of `[1;81H`, and the two look the same from here.
//
// Everything below is printed in PLAIN TEXT first and then demonstrated, so the report is
// readable even in the terminal that is failing.

const need = { cols: 113, rows: 48 };
const out = process.stdout;

const line = (k, v) => console.log("  " + k.padEnd(22) + v);

console.log("");
console.log("QBSK doctor");
console.log("-".repeat(60));

console.log("");
console.log("TERMINAL");
line("is a TTY", out.isTTY === true ? "yes" : "NO  <- the frame loop needs one");
line("columns", out.columns === undefined ? "unknown" : String(out.columns));
line("rows", out.rows === undefined ? "unknown" : String(out.rows));

const cols = out.columns ?? 0;
const rows = out.rows ?? 0;
const bigEnough = cols >= need.cols && rows >= need.rows;
line(
  "big enough for 113x48",
  out.isTTY !== true
    ? "cannot tell"
    : bigEnough
      ? "yes"
      : `NO  <- need ${need.cols}x${need.rows}, have ${cols}x${rows}`,
);

console.log("");
console.log("ENVIRONMENT");
for (const key of ["TERM", "TERM_PROGRAM", "WT_SESSION", "ConEmuANSI", "COLORTERM", "SHELL"]) {
  line(key, process.env[key] ?? "(not set)");
}
line("platform", `${process.platform} node ${process.version}`);

console.log("");
console.log("COLOUR — three swatches follow. You should see the WORDS in colour.");
console.log("  If you see something like [38;2;255;0;0m instead, this terminal is not");
console.log("  processing ANSI at all, and that is the whole problem.");
console.log("");
const swatch = (r, g, b, label) =>
  console.log(`  [38;2;${r};${g};${b}m${label}[0m`);
swatch(255, 0, 0, "red      — should be red");
swatch(255, 127, 0, "orange   — should be orange, not yellow");
swatch(139, 0, 255, "purple   — should be purple, not blue");

console.log("");
console.log("CURSOR — a box should be drawn below, three rows tall.");
console.log("  If instead you see the escape codes as text, cursor addressing is off");
console.log("  and the frame loop cannot draw anything at all.");
console.log("");
if (out.isTTY === true) {
  const top = "[s";
  const back = "[u";
  out.write(top);
  out.write("  +--------+\n  |  ok    |\n  +--------+\n");
  out.write(back);
  out.write("[3B");
} else {
  console.log("  (skipped — not a TTY, so there is no cursor to address)");
}

console.log("");
console.log("-".repeat(60));
const problems = [];
if (out.isTTY !== true) {
  problems.push(
    "This is not a real terminal. `npm run play` needs one — run it from Windows\n" +
      "    Terminal, PowerShell or cmd directly, not from inside an editor's output pane.",
  );
} else if (!bigEnough) {
  problems.push(
    `The window is ${cols}x${rows} and the arena is ${need.cols}x${need.rows}. Maximise it,\n` +
      "    or make the font smaller (Ctrl+- in Windows Terminal), until doctor says yes.",
  );
}
if (problems.length === 0) {
  console.log("Nothing here is in the way. If the swatches above were coloured and the");
  console.log("box was drawn, `npm run play` will work.");
} else {
  console.log("What is in the way:");
  for (const p of problems) {
    console.log("  - " + p);
  }
}
console.log("");
