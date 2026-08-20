// Launches the Studio in smoke mode and verifies the window paints the default
// scene byte-for-byte equal to the terminal golden (docs/studio.md §7).
// The renderer reports its grid back over IPC; the main process prints
// QBSK_STUDIO_SMOKE=<json> and quits. Exit 0 = the window paints what the
// terminal paints, exit 1 = mismatch, missing report or launch failure.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

process.env.QBSK_STUDIO_SMOKE = "1";
process.env.ELECTRON_ENABLE_LOGGING = "1";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(studioRoot, "..");
const golden = readFileSync(
  join(repoRoot, "tests", "golden", "hello.qbsk.out"),
  "utf8",
).replace(/\n+$/, "");

const child = spawn(electronPath, ["."], {
  cwd: studioRoot,
  stdio: ["ignore", "pipe", "inherit"],
});
let stdout = "";
child.stdout.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  stdout += text;
  process.stdout.write(text);
});
child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
child.on("exit", (code) => {
  const line = stdout
    .split("\n")
    .find((l) => l.startsWith("QBSK_STUDIO_SMOKE="));
  if (code !== 0) {
    console.error(`smoke: electron exited with code ${code}`);
    process.exit(code ?? 1);
  }
  if (!line) {
    console.error("smoke: no QBSK_STUDIO_SMOKE report (renderer or watchdog failed)");
    process.exit(1);
  }
  const payload = JSON.parse(line.slice("QBSK_STUDIO_SMOKE=".length));
  const text = payload.text.replace(/\n+$/, "");
  console.log(
    `smoke: window grid ${payload.width}x${payload.height}, ${payload.cells} cells painted`,
  );
  if (text === golden) {
    console.log(
      "smoke: PASS — window grid is byte-for-byte equal to tests/golden/hello.qbsk.out",
    );
    process.exit(0);
  }
  let d = -1;
  for (let i = 0; i < Math.min(text.length, golden.length); i += 1) {
    if (text[i] !== golden[i]) {
      d = i;
      break;
    }
  }
  console.error(`smoke: FAIL — window grid differs from golden at offset ${d}`);
  process.exit(1);
});
