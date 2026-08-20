// Renderer bootstrap (docs/studio.md §3/§4): asks the main process for a frame
// and paints the resulting DiffLine[]. No Node access, no src/.
//
// The painter is CHOSEN at startup (§4.2) — WebGL where it runs, DOM where it does not —
// and nothing below this line knows which. `grid` keeps its name and its four methods.
import type { MirrorEvent, SceneRun, StudioApi, StudioFrame } from "../shared/api.js";
import { choosePainter, type Painter } from "./painter.js";
import { showFatal, BOOT_HINT } from "./fatal.js";
import { CRT_PRESETS, crtById } from "./glshader.js";
import { fitFontSize, gridForBox, snapToFontGrid, CELL_ASPECT, cellAspectFor } from "./fit.js";
import { gutterRows, selectionFor, stripText } from "../shared/marks.js";
import { emptyText } from "../shared/inspect.js";
import { recentLabel } from "../shared/recent.js";
import type { InspectState } from "../shared/api.js";
import type { ErrorMark } from "../shared/marks.js";
import { FONTS, DEFAULT_FONT_ID, fontById, type FontChoice } from "./fonts.js";

declare global {
  interface Window {
    api: StudioApi;
  }
}

const api = window.api;

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing #${id}`);
  }
  return node;
}

const glCanvas = document.getElementById("glcanvas");
// The CRT look is read BEFORE the painter is built, so a reader who turned it off does
// not get one frame of the default on every start.
const CRT_KEY = "qbsk.studio.crt";
let crtId = localStorage.getItem(CRT_KEY) ?? CRT_PRESETS[0]!.id;
const chosen = choosePainter(
  el("canvas"),
  glCanvas instanceof HTMLCanvasElement ? glCanvas : null,
  8,
  16,
  '"GNU Unifont", monospace',
  crtById(crtId),
);
const grid: Painter = chosen.painter;
// Only the winner is shown. Leaving both visible stacks an empty grid over the painted
// one, which looks like the painter failed rather than like it was not chosen.
if (glCanvas instanceof HTMLCanvasElement) {
  glCanvas.style.display = chosen.backend === "webgl" ? "" : "none";
}
el("canvas").style.display = chosen.backend === "dom" ? "" : "none";
const editor = el("editor") as HTMLTextAreaElement;
const gutter = el("gutter");
const errorStrip = el("errorStrip") as HTMLButtonElement;
const inspector = el("inspector");
const statusFile = el("stFile");
const statusLnCol = el("stLnCol");
const statusFps = el("stFps");
const statusMs = el("stMs");
const statusMcp = el("stMcp");
const mcpLog = el("mcpLog");
const canvasCaption = el("canvasCaption");

let currentFile = "";
let lastRun: SceneRun | null = null;

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function log(kind: "call" | "ok" | "err", msg: string): void {
  const row = document.createElement("div");
  row.className = `log-${kind}`;
  row.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  mcpLog.prepend(row);
}

function updateLnCol(): void {
  const before = editor.value.slice(0, editor.selectionStart ?? 0);
  const lines = before.split("\n");
  statusLnCol.textContent =
    `ln ${lines.length}, col ${(lines[lines.length - 1] ?? "").length + 1}`;
}

async function run(): Promise<void> {
  const source = editor.value;
  log("call", `qbsk_eval → "${baseName(currentFile) || "editor.qbsk"}"`);
  let res: SceneRun;
  try {
    res = await api.run(source, currentFile || "editor.qbsk", currentCellAspect());
  } catch (err) {
    log("err", `qbsk_eval failed: ${(err as Error).message}`);
    statusFps.textContent = "error";
    return;
  }
  if (!res.ok) {
    log("err", `qbsk_eval → ${res.error}`);
    // §18 — the MCP log still gets the whole rendered error, trace included. The
    // strip and the gutter are what the author sees without looking away from the code.
    showError(res.errorMark);
    statusFps.textContent = "error";
    statusMs.textContent = "—";
    return;
  }
  showError(null);
  grid.reset(res.width, res.height);
  grid.paint(res.diff);
  noteSceneSize(res.width, res.height);
  lastRun = res;
  canvasCaption.textContent = `Canvas — ${res.width}×${res.height}`;
  statusFps.textContent = "static";
  statusMs.textContent = `${res.elapsedMs.toFixed(2)} ms/frame`;
  log(
    "ok",
    `qbsk_eval → "${baseName(currentFile)}": ${res.cells} cells changed, ` +
      `${res.elapsedMs.toFixed(2)} ms`,
  );
}

// --- Engine settings: fonts (docs/studio.md §14) --------------------------
//
// The chosen font drives BOTH the CSS variable the grid renders with and the
// aspect ratio play mode fits by. Those must move together: the first version of
// play mode hard-coded 0.6 while Unifont is actually 0.5, so the fit
// under-estimated how much fits and picked a smaller size than it could.

// The console key (docs/studio.md §14.5).
//
// F1 and not the backtick every console has used since Quake: on a Spanish keyboard
// the backtick is a DEAD key — it waits for a vowel to compose `à` and never reports
// itself as a keydown, so the traditional choice is simply unreachable for a large
// part of the world. F1 is one press on every layout, and keyFromDom drops the
// function keys, so binding it costs a scene nothing.
const CONSOLE_KEY = "qbsk.studio.consoleKey";
const DEFAULT_CONSOLE_KEY = "F1";

let consoleKey = localStorage.getItem(CONSOLE_KEY) ?? DEFAULT_CONSOLE_KEY;
let bindCapture = false;

function keyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key === "`") return "` (backtick)";
  return key;
}

function showBind(): void {
  const btn = document.getElementById("btnBindConsole");
  if (btn !== null) {
    btn.textContent = bindCapture ? "press a key…" : keyLabel(consoleKey);
  }
}

function startBind(): void {
  bindCapture = true;
  showBind();
}

function finishBind(key: string): void {
  bindCapture = false;
  // A modifier alone is not a binding: it would fire on the way to every shortcut.
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
    showBind();
    log("err", "a modifier on its own cannot open the console");
    return;
  }
  // Escape leaves play mode and closes this dialog; F5 toggles play mode. Binding
  // either would take away a key the user needs to get out of somewhere.
  if (key === "Escape" || key === "F5") {
    showBind();
    log("err", `${key} belongs to the window and cannot open the console`);
    return;
  }
  consoleKey = key;
  localStorage.setItem(CONSOLE_KEY, key);
  showBind();
  log("ok", `console key → ${keyLabel(key)}`);
}

const FONT_KEY = "qbsk.studio.font";
const SIZE_KEY = "qbsk.studio.fontSize";

let currentFont: FontChoice = fontById(
  localStorage.getItem(FONT_KEY) ?? DEFAULT_FONT_ID,
);
let windowedSize = Number(localStorage.getItem(SIZE_KEY) ?? "16") || 16;

function applyFont(): void {
  const root = document.documentElement;
  root.style.setProperty("--grid-font", `"${currentFont.family}", monospace`);
  root.style.setProperty("--grid-size", `${windowedSize}px`);
  const preview = document.getElementById("fontPreview");
  if (preview !== null) {
    preview.style.fontFamily = `"${currentFont.family}", monospace`;
    preview.style.fontSize = `${windowedSize}px`;
  }
  const note = document.getElementById("fontNote");
  if (note !== null) {
    note.textContent = `${currentFont.note} — ${currentFont.licence}`;
  }
  applyFit();
}

/**
 * The cell shape the chosen font actually has, for the engine (F0 criterion 4).
 *
 * The picker changed how the grid LOOKED and not what the engine DREW: diagonals were
 * computed as if every cell were 1:2 whatever the font. Sent with `run` and `live`
 * rather than stored in main, because main has no font — it is the renderer's choice
 * and it travels with the program it applies to.
 */
function currentCellAspect(): number {
  return cellAspectFor(currentFont.chPerEm);
}

function setFont(id: string): void {
  const before = currentCellAspect();
  currentFont = fontById(id);
  localStorage.setItem(FONT_KEY, currentFont.id);
  applyFont();
  log("ok", `font → ${currentFont.label}`);
  // A running program was built with the old cell shape and keeps it: restarting it
  // under the reader would throw away whatever state the scene had reached. Said out
  // loud rather than left to be noticed — the diagonals will not change until the next
  // run, and a silent "nothing happened" is how a working control reads as broken.
  if (liveRunning && Math.abs(currentCellAspect() - before) > 1e-9) {
    log("call", `cell shape → ${currentCellAspect().toFixed(2)} on the next run`);
  }
}

function setFontSize(px: number): void {
  windowedSize = px;
  localStorage.setItem(SIZE_KEY, String(px));
  applyFont();
}

// --- Engine settings: tiles (docs/engine.md §15) --------------------------
//
// A tileset is presentation only, chosen in the settings dialog and applied over
// whatever the window paints. Main loads the file and ships glyph -> data URL; the
// renderer stores the map and the painter consults it for the cells the diff
// reported. An empty path, a load failure and QBSK_STUDIO_NO_TILES all mean the
// same thing to the painter: characters (docs/engine.md §15.3).

const TILES_KEY = "qbsk.studio.tileset";
let tilesetPath = localStorage.getItem(TILES_KEY) ?? "";

async function applyTileset(path: string): Promise<void> {
  tilesetPath = path;
  localStorage.setItem(TILES_KEY, path);
  const res = await api.tileset(path);
  if (!res.ok) {
    // A broken tileset must not blank the window: characters stay, and the failure
    // is reported rather than silent (docs/engine.md §15.3, an earlier release).
    grid.setTiles(null);
    log("err", `tileset → ${res.error}`);
    return;
  }
  if (res.tiles === null) {
    grid.setTiles(null);
    log("ok", "tileset → none, painting characters");
    return;
  }
  grid.setTiles(new Map(Object.entries(res.tiles)));
  log("ok", `tileset → ${Object.keys(res.tiles).length} glyphs mapped`);
}

// --- Play mode (docs/studio.md §13) ---------------------------------------
//
// Scales the FONT, never the grid. The number of rows and columns is whatever the
// scene declared, so a frame read back in play mode is byte-identical to the same
// frame windowed — scaling never becomes a second rendering path.

let playing = false;
// Exiting clears the inline font-size rather than restoring a remembered value:
// the stylesheet's own rule takes over again, so the windowed look is exact by
// construction and cannot drift from styles.css.
let sceneCols = 0;
let sceneRows = 0;

function applyFit(): void {
  const canvas = el("canvas");
  if (sceneCols <= 0 || sceneRows <= 0) {
    canvas.style.fontSize = "";
    return;
  }
  const wrap = el("canvasWrap").getBoundingClientRect();
  // Snap DOWN to the font's pixel grid: Unifont is drawn on 16px and goes soft
  // between multiples of 8. Down, never up — the scene must still fit.
  const raw = fitFontSize({
    cols: sceneCols,
    rows: sceneRows,
    availWidth: wrap.width,
    availHeight: wrap.height,
    chPerEm: currentFont.chPerEm,
  });
  // Outline fonts scale freely (pixelGrid 0); bitmap-derived ones only look right
  // on their grid, so snap DOWN — never up, which would clip the scene.
  const snapped =
    currentFont.pixelGrid > 0 ? snapToFontGrid(raw, currentFont.pixelGrid) : raw;
  // WINDOWED fits too, and it must — the fit used to run only in play mode, so a
  // scene taller than the panel simply had its bottom rows cut off. The console is
  // 26 rows and the panel showed about thirteen, which put the PROMPT LINE off
  // screen: you were typing into something you could not see.
  //
  // Windowed is capped at the chosen size rather than growing to fill: the settings
  // slider is a preference, and a fit that overrode it upwards would make that
  // setting do nothing. It shrinks to fit and never grows past what you asked for.
  const px = playing ? snapped : Math.min(snapped, windowedSize);
  canvas.style.fontSize = `${px}px`;
  // The GPU painter draws into a texture and has no font-size to inherit, so the cell it
  // was sized for has to follow the fit rather than be assumed. Derived from the same two
  // numbers the DOM path uses: the font's own width ratio, and the .cell line-height.
  grid.setCellSize?.(
    Math.max(1, Math.round(px * currentFont.chPerEm)),
    Math.max(1, Math.round(px * CELL_ASPECT)),
  );
}

function setPlaying(on: boolean): void {
  playing = on;
  document.body.classList.toggle("play", on);
  applyFit();
  log("call", on ? "play mode → on (esc to exit)" : "play mode → off");
}

function noteSceneSize(cols: number, rows: number): void {
  sceneCols = cols;
  sceneRows = rows;
  applyFit();
}

/**
 * Tells the running scene how many cells the window can show.
 *
 * Only while a scene is live: a static compose has no `on resize` to receive it, and
 * sending anyway would be a message into a program that is not running.
 *
 * The grid is measured at the CURRENT font size, which is what a terminal does — the font
 * is fixed and the grid follows. A scene with a constant `scene S(width: 80, ...)` ignores
 * it entirely, so this costs nothing for the scenes that do not care.
 */
let lastSent = "";
async function tellSceneTheSize(): Promise<void> {
  if (!liveRunning) {
    return;
  }
  const wrap = el("canvasWrap").getBoundingClientRect();
  const px = parseFloat(getComputedStyle(el("canvas")).fontSize) || 16;
  const { cols, rows } = gridForBox({
    availWidth: wrap.width,
    availHeight: wrap.height,
    fontPx: px,
    chPerEm: currentFont.chPerEm,
  });
  if (cols <= 0 || rows <= 0) {
    return;
  }
  // A drag fires `resize` dozens of times a second and most of them land on the same
  // cell count. Re-sending is a queued event per frame for no change at all.
  const key = `${cols}x${rows}`;
  if (key === lastSent) {
    return;
  }
  lastSent = key;
  await api.resize(cols, rows);
}

window.addEventListener("resize", () => {
  applyFit();
  void tellSceneTheSize();
});
window.addEventListener("keydown", (ev) => {
  if (ev.key === "F5") {
    ev.preventDefault();
    setPlaying(!playing);
    return;
  }
  // Capturing a new binding takes precedence over everything, or you could never
  // rebind onto a key that already does something.
  if (bindCapture) {
    ev.preventDefault();
    finishBind(ev.key);
    return;
  }
  // The engine console (docs/studio.md §14.5).
  if (ev.key === consoleKey) {
    ev.preventDefault();
    void toggleConsole(!consoleOpen);
    return;
  }
  if (ev.key === "Escape") {
    if (!el("settingsBackdrop").hasAttribute("hidden")) {
      ev.preventDefault();
      openSettings(false);
      return;
    }
    if (playing) {
      ev.preventDefault();
      setPlaying(false);
      return;
    }
  }
  // Everything else goes to the live program (docs/studio.md §14.5) — but only when
  // one is running and the editor does not have the caret, or typing a scene would
  // also be playing it. F5 and Escape returned above, so the window keeps the keys
  // that leave full screen; a scene must never be able to trap the user there.
  if (isTypingInEditor()) {
    return;
  }
  // The console takes the keyboard while it is open, even with no scene running —
  // that is exactly when you most want to type into it.
  if (!liveRunning && !consoleOpen) {
    return;
  }
  const raw = ev.key;
  // The raw name crosses the bridge; main decodes and validates it. A modifier or a
  // function key decodes to null there and is never delivered.
  api.pressKey(raw);
});

function isTypingInEditor(): boolean {
  const active = document.activeElement;
  if (active === null) {
    return false;
  }
  const tag = active.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "INPUT" ||
    (active as HTMLElement).isContentEditable === true
  );
}

// --- The live program (docs/studio.md §14.4) ---
//
// Main owns the SceneProgram and the clock; this is a pure painter fed by pushed
// frames, exactly like the mirror. The difference is that these frames come from the
// window's OWN program, so keys typed here reach it.
let liveRunning = false;
let consoleOpen = false;

async function toggleConsole(open: boolean): Promise<void> {
  const res = await api.toggleConsole(open);
  if (!res.ok) {
    log("err", res.error ?? "the console did not open");
    return;
  }
  consoleOpen = open;
  liveSize = "";
  log("ok", open ? "console → open (` to close)" : "console → closed");
}
let liveFrames = 0;
let liveSize = "";

function applyFrame(frame: StudioFrame): void {
  const size = `${frame.width}×${frame.height}`;
  if (size !== liveSize) {
    // Only on a real size change: reset clears the grid, and doing it every frame
    // would throw away the diffing that makes an unchanged frame cost nothing.
    grid.reset(frame.width, frame.height);
    noteSceneSize(frame.width, frame.height);
    liveSize = size;
    canvasCaption.textContent = `Canvas — ${size} (running)`;
  }
  grid.paint(frame.diff);
  liveFrames += 1;
  void refreshInspector();
  statusFps.textContent = `running · frame ${liveFrames}`;
  statusMs.textContent = `${frame.metrics.cells} cells`;
}


// --- The Inspector: what the live program is holding (docs/studio.md §19) --------

/**
 * When the pane was last filled, so a 30 Hz frame stream does not drive a 30 Hz refresh.
 *
 * The pane is read by a person, and four times a second is faster than anyone can follow
 * a changing number. Refreshing per frame would put the whole variable set across the
 * IPC boundary thirty times a second for a pane nobody is staring at that hard.
 */
let lastInspect = 0;
const INSPECT_MS = 250;

function drawInspector(state: InspectState): void {
  inspector.replaceChildren();
  if (state.rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ins-empty";
    empty.textContent = emptyText(state.live);
    inspector.appendChild(empty);
    return;
  }
  for (const row of state.rows) {
    const line = document.createElement("div");
    line.className = row.type === "func" || row.type === "native" ? "ins-fn" : "ins-row";
    const name = document.createElement("span");
    name.className = "ins-name";
    name.textContent = row.name;
    const type = document.createElement("span");
    type.className = "ins-type";
    type.textContent = row.type;
    const value = document.createElement("span");
    value.className = "ins-value";
    // textContent, not innerHTML: every string here was made up by the program being
    // inspected, and one of them containing `<` must not become markup.
    value.textContent = row.text;
    line.append(name, type, value);
    inspector.appendChild(line);
  }
}

async function refreshInspector(force = false): Promise<void> {
  const now = performance.now();
  if (!force && now - lastInspect < INSPECT_MS) {
    return;
  }
  lastInspect = now;
  drawInspector(await api.inspect());
}

async function startLive(source: string, file: string): Promise<void> {
  const res = await api.live(source, file, currentCellAspect());
  if (!res.ok) {
    log("err", res.error ?? "the scene did not start");
    showError(res.errorMark);
    return;
  }
  showError(null);
  liveRunning = true;
  liveFrames = 0;
  liveSize = "";
  // Once at the start, and not only on a later change: without this a responsive scene
  // opened at whatever its declaration said and stayed there until somebody dragged the
  // window, which is exactly the defect the CLI had.
  lastSent = "";
  void tellSceneTheSize();
  log("ok", "live → program running, keys go to the scene");
  // Once immediately: the first frame is 33 ms away and an empty pane in the meantime
  // reads as the Inspector not working rather than as it waiting.
  void refreshInspector(true);
}

async function stopLive(): Promise<void> {
  if (!liveRunning) {
    return;
  }
  liveRunning = false;
  await api.stopLive();
  void refreshInspector(true);
  log("ok", `live → stopped after ${liveFrames} frames`);
}

// Session mirror (docs/studio.md §12.4): apply what the agent painted, using the
// same two calls a local run uses — so mirroring adds no second painting path.
let mirrorFrames = 0;

// MCP connection state. It used to be written once at boot and left saying "off"
// forever, which was simply wrong: an agent could be driving the window while the
// status claimed nothing was connected. Now it reflects what is actually arriving.
type McpState = "waiting" | "connected" | "ended";
let mcpState: McpState = "waiting";
let lastRecordAt = 0;

function setMcpState(next: McpState): void {
  if (mcpState === next) {
    return;
  }
  mcpState = next;
  statusMcp.textContent =
    next === "connected" ? "MCP connected" : next === "ended" ? "MCP ended" : "MCP waiting";
  statusMcp.className = next === "connected" ? "mcp-on" : "";
}

// A session that stops sending is not "connected" any more, but it has not said
// goodbye either. Fall back to waiting rather than lying in either direction.
setInterval(() => {
  if (mcpState === "connected" && Date.now() - lastRecordAt > 3000) {
    setMcpState("waiting");
    log("ok", "mirror → no frames for 3s, session idle");
  }
}, 1000);

function applyMirror(records: MirrorEvent[]): void {
  lastRecordAt = Date.now();
  for (const rec of records) {
    if (rec.t === "reset") {
      grid.reset(rec.width, rec.height);
      noteSceneSize(rec.width, rec.height);
      mirrorFrames = 0;
      canvasCaption.textContent = `Canvas — ${rec.width}×${rec.height} (live)`;
      setMcpState("connected");
      log("call", `mirror → new session ${rec.width}×${rec.height}`);
    } else if (rec.t === "frame") {
      grid.paint(rec.diff);
      mirrorFrames += 1;
      const cells = rec.diff.reduce((acc, d) => acc + d.changed, 0);
      setMcpState("connected");
      statusFps.textContent = `live · frame ${mirrorFrames}`;
      statusMs.textContent = `${cells} cells`;
    } else {
      // The agent's session ended. Say so instead of leaving a stale frame that
      // looks live (docs/studio.md §12.4).
      setMcpState("ended");
      statusFps.textContent = "stale";
      log("ok", `mirror → session ended after ${mirrorFrames} frames`);
    }
  }
}

// --- Settings dialog wiring ------------------------------------------------

function openSettings(open: boolean): void {
  const back = el("settingsBackdrop");
  if (open) {
    back.removeAttribute("hidden");
    (el("setMcpStatus")).textContent = mcpState;
    (el("setMcpFrames")).textContent = String(mirrorFrames);
  } else {
    back.setAttribute("hidden", "");
  }
}

/**
 * The CRT chooser (docs/studio.md §4.2).
 *
 * F3 shipped the settings and wired them to nothing, so `CRT_OFF` — which exists for a
 * reader who cannot look at a curved, scanlined grid — was reachable only by editing the
 * source. It is a control now.
 *
 * On the DOM painter it is DISABLED and says why, rather than accepting a choice it
 * cannot apply. A control that silently does nothing is the ghost feature the review
 * protocol names first, and it is worse here than absence: the reader who most needs
 * "off" would come away believing they had turned it off.
 */
function buildCrtSetting(): void {
  const sel = el("crtSelect") as HTMLSelectElement;
  for (const preset of CRT_PRESETS) {
    const opt = document.createElement("option");
    opt.value = preset.id;
    opt.textContent = preset.label;
    sel.appendChild(opt);
  }
  sel.value = crtId;
  const note = el("crtNote");
  if (grid.setCrt === undefined) {
    sel.disabled = true;
    note.textContent =
      "Unavailable on this machine: the CRT is a shader, and this window is painting " +
      "through the DOM because WebGL could not start.";
    return;
  }
  note.textContent =
    "Curvature, scanlines, bloom, aberration and vignette, in the same pass that draws " +
    "the grid. Off is the exact grid a screenshot comparison needs.";
  sel.addEventListener("change", () => {
    crtId = sel.value;
    localStorage.setItem(CRT_KEY, crtId);
    grid.setCrt?.(crtById(crtId));
    log("ok", `CRT → ${sel.options[sel.selectedIndex]?.textContent ?? crtId}`);
  });
}

function buildSettings(): void {
  const sel = el("fontSelect") as HTMLSelectElement;
  for (const f of FONTS) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.label;
    sel.appendChild(opt);
  }
  sel.value = currentFont.id;
  sel.addEventListener("change", () => setFont(sel.value));

  buildCrtSetting();

  const size = el("fontSize") as HTMLInputElement;
  size.value = String(windowedSize);
  el("fontSizeOut").textContent = `${windowedSize}px`;
  size.addEventListener("input", () => {
    const px = Number(size.value);
    el("fontSizeOut").textContent = `${px}px`;
    setFontSize(px);
  });

  el("btnSettings").addEventListener("click", () => openSettings(true));
  el("btnSettingsClose").addEventListener("click", () => openSettings(false));
  el("settingsBackdrop").addEventListener("click", (ev) => {
    // Click outside the dialog closes it; clicks inside must not.
    if (ev.target === el("settingsBackdrop")) {
      openSettings(false);
    }
  });

  const tiles = el("tilesetPath") as HTMLInputElement;
  tiles.value = tilesetPath;
  tiles.addEventListener("change", () => void applyTileset(tiles.value));
  el("btnPickTiles").addEventListener("click", async () => {
    const path = await api.pickTileset();
    if (path !== null) {
      tiles.value = path;
      await applyTileset(path);
    }
  });
  el("btnClearTiles").addEventListener("click", () => {
    tiles.value = "";
    void applyTileset("");
  });
}

async function init(): Promise<void> {
  const dflt = await api.defaultScene();
  currentFile = dflt.file;
  setEditorSource(dflt.source);
  statusFile.textContent = baseName(dflt.file);
  statusMcp.textContent = "MCP waiting";
  buildSettings();
  applyFont();
  // §18 — a scene that dies mid-frame marks the line, exactly as a failed static
  // run does. THREE paths reach the editor now; wiring only the static one left the Run
  // button -- the one an author actually presses -- reporting nothing at all.
  api.onLiveError((failure) => {
    log("err", `live → ${failure.error}`);
    showError(failure.errorMark);
    statusFps.textContent = "error";
  });
  api.onMirror(applyMirror);
  api.onFrame(applyFrame);
  // Apply the saved tileset at boot, like the font. Under smoke main returns no
  // tiles, so this never depends on a tileset file existing for the byte check.
  await applyTileset(tilesetPath);
  await run();
  // Report the painted grid back; the main process verifies it in smoke mode.
  const painted = lastRun;
  await api.smoke({
    width: painted?.width ?? 0,
    height: painted?.height ?? 0,
    cells: painted?.cells ?? 0,
    text: grid.renderText(),
  });
}


// --- The error, on the line that caused it (docs/studio.md §18) ------------------

/** The mark from the last run, or null when the last run succeeded. */
let currentMark: ErrorMark | null = null;

/**
 * Redraws the line numbers, marking the error's lines.
 *
 * One row element per line rather than one text node, because the mark is a background
 * on a row: a marker CHARACTER would shift the digits and make that one line's numbers
 * sit a column further right than every other.
 */
function drawGutter(): void {
  const rows = gutterRows(editor.value, currentMark);
  gutter.replaceChildren();
  for (const row of rows) {
    const div = document.createElement("div");
    div.textContent = String(row.line);
    if (row.bad) {
      div.className = "gut-bad";
    }
    gutter.appendChild(div);
  }
  gutter.scrollTop = editor.scrollTop;
}

/** Shows or clears the strip under the editor. */
function showError(mark: ErrorMark | null): void {
  currentMark = mark;
  if (mark === null) {
    errorStrip.hidden = true;
    errorStrip.textContent = "";
  } else {
    errorStrip.hidden = false;
    // textContent, not innerHTML: an error message can contain `<`, and a diagnostic
    // that parses its own text as markup is an injection point.
    errorStrip.textContent = stripText(mark);
  }
  drawGutter();
}

// Clicking the strip puts the caret on the error. The offsets are clamped inside
// `selectionFor`, because the author can type between the run and the click.
errorStrip.addEventListener("click", () => {
  if (currentMark === null) {
    return;
  }
  const sel = selectionFor(editor.value, currentMark);
  editor.focus();
  editor.setSelectionRange(sel.start, sel.end);
  updateLnCol();
});


/**
 * Puts source in the editor and brings everything that mirrors it back in step.
 *
 * ONE door, because assigning to `editor.value` fires NO `input` event. The gutter
 * listens for one, so both programmatic writes in this file -- the default scene at boot
 * and the file picker -- left the line numbers showing the previous document, and the
 * boot case left them showing nothing at all. Fixing the two sites would have left the
 * third to be written later; this makes the third impossible.
 *
 * It also clears the error mark, which belonged to the OLD source: kept, it would point
 * a red line at whatever happens to be on that line of the new one.
 */
function setEditorSource(text: string): void {
  editor.value = text;
  showError(null);
  updateLnCol();
}

editor.addEventListener("input", drawGutter);
editor.addEventListener("scroll", () => {
  gutter.scrollTop = editor.scrollTop;
});

editor.addEventListener("keyup", updateLnCol);
editor.addEventListener("click", updateLnCol);
// Run means RUN: the program stays alive, so `on tick` animates and `on key` fires
// (docs/studio.md §14.4). Until now every animated example was a still in the window.
// A static scene is unharmed - it composes each frame and the diff is empty after the
// first, which is exactly what the differential renderer is for.
el("btnRun").addEventListener("click", () => {
  void startLive(editor.value, currentFile || "editor.qbsk");
});
// Was wired to nothing since an earlier release.
el("btnStop").addEventListener("click", () => void stopLive());

/**
 * Opens a scene from disk (the toolbar's Open button).
 *
 * It was drawn since an earlier release and wired to nothing, so Studio could only ever show the
 * scene it booted with — the second dead button in this codebase after Stop, and the
 * reason opening `awakening.qbsk` meant pasting its source into the editor by hand.
 *
 * Stops whatever is running BEFORE loading. A live program from the previous file would
 * otherwise keep painting over the new one, which reads as the open having failed.
 */

// --- Recent files (docs/studio.md §20) -----------------------------------------

const recentMenu = el("recentMenu");

/** Loads a scene the same way `openScene` does, so there is one way to open a file. */
async function loadScene(picked: { file: string; source: string }): Promise<void> {
  await stopLive();
  currentFile = picked.file;
  setEditorSource(picked.source);
  statusFile.textContent = baseName(picked.file);
  log("ok", `open → ${baseName(picked.file)}`);
  // Run it: a scene that opens to a blank canvas looks like the open did not work.
  await startLive(picked.source, picked.file);
}

function hideRecent(): void {
  recentMenu.hidden = true;
  recentMenu.replaceChildren();
}

async function showRecent(): Promise<void> {
  if (!recentMenu.hidden) {
    hideRecent();
    return;
  }
  const files = await api.recentFiles();
  recentMenu.replaceChildren();
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rec-empty";
    empty.textContent = "nothing opened yet — use the Open button";
    recentMenu.appendChild(empty);
  }
  for (const file of files) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "rec-row";
    // textContent: a folder can be called anything, including something that parses as
    // markup, and a path is never markup.
    row.textContent = recentLabel(file);
    row.title = file;
    row.addEventListener("click", () => {
      hideRecent();
      void (async () => {
        const picked = await api.openRecent(file);
        if (picked === null) {
          // Renamed or deleted between the menu opening and the click. Reported rather
          // than silently doing nothing, which reads as a broken button.
          log("err", `open → ${baseName(file)} is no longer there`);
          return;
        }
        await loadScene(picked);
      })();
    });
    recentMenu.appendChild(row);
  }
  recentMenu.hidden = false;
}

el("btnFolder").addEventListener("click", () => {
  void showRecent();
});
// Anywhere else closes it. Without this the menu stays open behind the next click and
// covers the toolbar buttons under it.
document.addEventListener("click", (event) => {
  const target = event.target;
  if (
    !recentMenu.hidden &&
    target instanceof Node &&
    !recentMenu.contains(target) &&
    !el("btnFolder").contains(target)
  ) {
    hideRecent();
  }
});

async function openScene(): Promise<void> {
  const picked = await api.openScene();
  if (picked === null) {
    return;
  }
  await loadScene(picked);
}

el("btnOpen").addEventListener("click", () => void openScene());
// A button as well as a key, because a key that does not exist on your layout is not
// a way in at all — which is exactly what the backtick was.
el("btnConsole").addEventListener("click", () => void toggleConsole(!consoleOpen));
el("btnBindConsole").addEventListener("click", startBind);
el("btnBindReset").addEventListener("click", () => finishBind(DEFAULT_CONSOLE_KEY));
showBind();
el("btnPlay").addEventListener("click", () => setPlaying(!playing));

// THREE HOOKS, AND THE OVERLAY IS THE POINT OF ALL THREE. A boot failure used to go to
// `log()`, which writes into the MCP panel -- a collapsible strip inside the window. So the
// Studio opened to a window that did nothing and said nothing, and the only diagnostic was
// `npm run smoke` saying "no report from renderer" with no reason attached.
//
// The overlay goes ON the window and depends on nothing: no stylesheet, no font and no
// class names, because the thing that failed is quite likely one of those.
function reportFatal(title: string, err: unknown, hint?: string): void {
  const error = err instanceof Error ? err : new Error(String(err));
  showFatal(document, {
    title,
    message: error.message,
    detail: error.stack?.split("\n").slice(1, 4).join("\n"),
    hint,
  });
  log("err", `${title}: ${error.message}`);
}

// Anything that throws after the module loaded, including inside an event handler -- which
// no `catch` around `init` can see.
window.addEventListener("error", (event) => {
  reportFatal("The Studio hit an error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  reportFatal("The Studio hit an error", event.reason);
});

void init().catch((err) => {
  reportFatal("The Studio could not start", err, BOOT_HINT);
});
