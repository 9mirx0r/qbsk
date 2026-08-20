// Copies the static renderer assets (HTML/CSS) into the build output. The
// TypeScript sources are emitted by tsc; these files are not compiled.
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const studioDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(studioDir, "renderer");
const outDir = resolve(studioDir, "..", "dist-studio", "studio", "renderer");
mkdirSync(outDir, { recursive: true });

for (const f of readdirSync(srcDir)) {
  const full = join(srcDir, f);
  if (!statSync(full).isDirectory() && /\.(html|css)$/.test(f)) {
    copyFileSync(full, join(outDir, f));
  }
}

// The project font (font/ at the repo root) travels with the renderer so
// @font-face can reach it by a relative URL under file://. Its license notice is
// copied alongside it: the OFL requires the license to accompany the font.
const fontSrc = resolve(studioDir, "..", "font");
const fontOut = join(outDir, "font");
mkdirSync(fontOut, { recursive: true });
for (const f of readdirSync(fontSrc)) {
  const full = join(fontSrc, f);
  if (!statSync(full).isDirectory() && /\.(otf|ttf|woff2?|md)$/i.test(f)) {
    copyFileSync(full, join(fontOut, f));
  }
}
