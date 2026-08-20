// Electron main process (docs/studio.md §3): window lifecycle + IPC handlers.
// This is the ONLY file that imports "electron" besides the preload. All QBSK
// work is delegated to the pure host (./host.js).
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readScene, runStaticScene, StudioFrameHost } from "./host.js";
import { MirrorReader, SessionWatcher } from "./mirror.js";
import { journalPath } from "../mcp/journal.js";
import { WindowMirror } from "../mcp/window.js";
import { keyFromDom } from "../../src/engine/keys.js";
import { EngineConsole } from "./console.js";
import { AudioDevice } from "../../src/audio/device.js";
import { loadTileset, tileDataUrls } from "../../src/engine/tileset.js";
import { formatQbskError } from "../../src/interp/error.js";
import type { GridSmoke, LiveStart, SceneRun, TilesetLoad } from "../shared/api.js";

// The live program and its clock (docs/studio.md §14.4). Module-level because there
// is exactly one window and exactly one live program; a second would mean two clocks
// competing to paint the same canvas.
let liveHost: StudioFrameHost | null = null;
let liveTimer: NodeJS.Timeout | null = null;

/** 30 Hz: a console does not need 60, and half the frames is half the IPC traffic. */
const LIVE_FPS = 30;

// The console and its own clock (docs/studio.md §14). Separate from the scene program
// on purpose: opening a console must not disturb whatever was running, and closing it
// must leave that program exactly where it was.
const engineConsole = new EngineConsole(null);

// What the window publishes about itself (docs/studio.md §15). The OPPOSITE direction
// from the session mirror: this one lets an agent see what the person is looking at,
// which is everything the agent did not draw itself. It carries characters and an image
// path — never a command — so it is observation in the same sense §12 is, pointed the
// other way.
let windowMirror: WindowMirror | null = null;
let capturing = false;

/**
 * Publishes a painted frame, and captures a PNG only when the grid CHANGED.
 *
 * The engine emits nothing when nothing changed; capturing an identical window thirty
 * times a second would be the one place in this codebase that ignored its own rule.
 * The `capturing` flag guards against a second capture starting before the first
 * resolved, which at 30 Hz would queue them faster than they complete.
 */
function publish(win: BrowserWindow, text: string[], showing: string): void {
  if (windowMirror === null || win.isDestroyed()) {
    return;
  }
  const changed = windowMirror.write(text, showing, true);
  if (!changed || capturing) {
    return;
  }
  capturing = true;
  void win.webContents
    .capturePage()
    .then((image) => windowMirror?.writeImage(image.toPNG()))
    .catch(() => {
      // Swallowed like every other mirror failure: a snapshot must never take down
      // the window the person is actually using.
    })
    .finally(() => {
      capturing = false;
    });
}

// Studio gets sound (docs/audio.md §3). The window had none: StudioFrameHost composed
// an audio plan every frame and nobody read it, so every `tone` in every example was
// silent here while the CLI played it. One device for both the scene and the console —
// they are never on screen at the same time, so they can never overlap.
//
// Disabled by QBSK_STUDIO_SMOKE, because the smoke run compares bytes and has no
// business spawning audio players.
const audio = new AudioDevice({ enabled: process.env.QBSK_STUDIO_SMOKE !== "1" });
let consoleHost: StudioFrameHost | null = null;
let consoleTimer: NodeJS.Timeout | null = null;
let consoleOpen = false;

function stopConsole(): void {
  if (consoleTimer !== null) {
    clearInterval(consoleTimer);
    consoleTimer = null;
  }
  consoleOpen = false;
}

function stopLive(): void {
  if (liveTimer !== null) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
  liveHost = null;
  engineConsole.setTarget(null);
}

const here = dirname(fileURLToPath(import.meta.url));
// dist-studio/studio/main -> dist-studio/studio
const studioRoot = resolve(here, "..");
// dist-studio/studio -> repo root
const repoRoot = resolve(studioRoot, "..", "..");

// Stays hello.qbsk: `npm run smoke` compares the painted window against
// tests/golden/hello.qbsk.out byte for byte (docs/studio.md §7), so this is a
// guard, not a preference. Other scenes arrive over the session mirror (§12)
// instead of by editing this line.
const DEFAULT_SCENE = resolve(repoRoot, "examples", "hello.qbsk");

// The console draws itself (docs/studio.md §14.3): it is a QBSK scene, not a CSS panel.
const CONSOLE_SCENE = resolve(repoRoot, "examples", "console.qbsk");

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#16334f",
    title: "QBSK Studio",
    webPreferences: {
      preload: join(studioRoot, "bridge", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Surface renderer console messages so the smoke run can diagnose failures
  // (docs/studio.md §7). Ignored outside smoke mode.
  // ⚠️ Electron changed this signature. It used to be `(event, level, message, line,
  // sourceId)` and is now `(event, details)` with `details.level` and `details.message`.
  // On Electron 38 the old destructuring bound `level` to the details OBJECT and `message`
  // to `undefined`, so every renderer error printed as `[renderer:[object Object]]
  // undefined` — or, once the template stopped being reached, as nothing at all. That is
  // why `npm run smoke` could say "no report from renderer" and give no reason: the one
  // channel built to explain a boot failure was the thing that had failed.
  //
  // Both shapes are read, so this does not break again on the next signature change.
  win.webContents.on("console-message", (...args: unknown[]) => {
    if (process.env.QBSK_STUDIO_SMOKE !== "1") {
      return;
    }
    const second = args[1];
    if (second !== null && typeof second === "object") {
      const details = second as { level?: unknown; message?: unknown };
      console.log(`[renderer:${String(details.level)}] ${String(details.message)}`);
      return;
    }
    console.log(`[renderer:${String(args[1])}] ${String(args[2])}`);
  });

  void win.loadFile(join(studioRoot, "renderer", "index.html"));
  return win;
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  ipcMain.handle("studio:defaultScene", () => {
    const source = readFileSync(DEFAULT_SCENE, "utf8");
    return { file: DEFAULT_SCENE, source };
  });

  ipcMain.handle("studio:read", (_event, file: string): string => {
    return readFileSync(file, "utf8");
  });

  // --- Tiles (C1, docs/engine.md §15) ---
  //
  // Loads a tileset file and ships glyph -> data URL to the renderer. The load is
  // never a crash: every failure is returned as `tiles: null` with a message, and the
  // painter falls back to characters — the documented degradation (engine.md §15.3).
  // Smoke and QBSK_STUDIO_NO_TILES=1 short-circuit to no tiles, so those runs never
  // depend on a tileset file existing.
  ipcMain.handle("studio:tiles", (_event, path: string): TilesetLoad => {
    if (
      process.env.QBSK_STUDIO_SMOKE === "1" ||
      process.env.QBSK_STUDIO_NO_TILES === "1"
    ) {
      return { ok: true, tiles: null, error: null };
    }
    if (typeof path !== "string" || path === "") {
      return { ok: true, tiles: null, error: null };
    }
    try {
      const source = readFileSync(path, "utf8");
      const tiles = loadTileset(source, path);
      if (tiles.errors.length > 0) {
        return {
          ok: false,
          tiles: null,
          error: tiles.errors
            .map((err) => formatQbskError(source, err))
            .join("\n"),
        };
      }
      return {
        ok: true,
        tiles: Object.fromEntries(tileDataUrls(tiles.glyphs)),
        error: null,
      };
    } catch (err) {
      return { ok: false, tiles: null, error: (err as Error).message };
    }
  });

  // Open a scene from disk. The toolbar's Open button was drawn since an earlier release and
  // wired to nothing, so Studio could only ever show the default scene — the second
  // dead button found in this codebase, after Stop.
  //
  // Returns the source with the path, in one round trip: the renderer needs both to
  // fill the editor and to resolve a `use` relative to the file, and two calls would
  // let them disagree about which file is open.
  ipcMain.handle(
    "studio:openScene",
    async (event): Promise<{ file: string; source: string } | null> => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        title: "Open a QBSK scene",
        defaultPath: resolve(repoRoot, "examples"),
        filters: [{ name: "QBSK scene", extensions: ["qbsk"] }],
        properties: ["openFile"],
      };
      const result =
        owner === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(owner, options);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      return readScene(result.filePaths[0]!);
    },
  );

  ipcMain.handle("studio:pickTileset", async (event): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Choose a QBSK tileset",
      filters: [{ name: "QBSK tileset", extensions: ["qbdata"] }],
      properties: ["openFile"],
    };
    const result =
      owner === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(owner, options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0]!;
  });

  ipcMain.handle(
    "studio:run",
    (_event, source: string, file: string, cellAspect?: number): SceneRun => {
      const run = runStaticScene(source, file, cellAspect);
      publish(win, run.text, "static");
      return run;
    },
  );

  // --- The live program (docs/studio.md §14.4) ---
  //
  // The window's frame engine has existed since an earlier release (StudioFrameHost) and was
  // never instantiated: `studio:run` composes once and throws the program away, so
  // `on tick` and `on key` could not fire and every animated example was a still.
  //
  // THE CLOCK LIVES HERE, in main, with the program. The renderer stays a pure
  // painter fed by the existing one-way StudioFrame flow; putting the clock in the
  // renderer would split ownership of one program across a process boundary.
  //
  // setInterval and not a fixed-timestep accumulator: this drives a WINDOW, where a
  // late frame should be shown late rather than compensated for. The CLI's GameLoop
  // owns the deterministic path, and goldens are pinned there.
  ipcMain.handle(
    "studio:live",
    (event, source: string, file: string, cellAspect?: number): LiveStart => {
      stopLive();
      const host = new StudioFrameHost(source, file, cellAspect);
      if (host.error !== null) {
        return { ok: false, error: host.error };
      }
      liveHost = host;
      // The console must point at the program that is actually running, or `vars`
      // would report a scene the user replaced three runs ago.
      engineConsole.setTarget(host);
      const sender = event.sender;
      const dt = 1 / LIVE_FPS;
      liveTimer = setInterval(() => {
        if (liveHost !== host || sender.isDestroyed()) {
          return;
        }
        // The console is MODAL: while it is open the scene neither steps nor paints.
        // Two clocks sending frames would fight over one canvas, and a game advancing
        // invisibly behind a console is worse than one that waits.
        if (consoleOpen) {
          return;
        }
        const frame = host.next(dt);
        if (frame === null) {
          // A runtime error latches in the interpreter and every later step is a
          // no-op, so keep stopping rather than spinning at 30 Hz forever.
          stopLive();
          return;
        }
        audio.frame(host.audioPlan, host.gameTime);
        publish(win, frame.text, "scene");
        sender.send("studio:frame", frame);
      }, Math.round(1000 / LIVE_FPS));
      return { ok: true, error: null };
    },
  );

  // The window changed shape; a scene that reads its size gets to know. Queued like a
  // key, so it lands inside the next step rather than mid-frame.
  ipcMain.handle("studio:resize", (_event, cols: number, rows: number) => {
    // `liveHost` and not a captured `host`: the handler outlives any one run, and a
    // resize that arrived between two scenes would otherwise reach a dead program.
    liveHost?.resize(cols, rows);
    return null;
  });

  ipcMain.handle("studio:stopLive", () => {
    stopLive();
    return null;
  });

  // Keys reach the window's OWN program (docs/studio.md §14.5). `on` and not
  // `handle`: a keystroke has no answer to wait for. A press with no live program is
  // dropped rather than queued — a key typed before a scene is running belongs to
  // nothing, and holding it would make it arrive at a surprising moment later.
  ipcMain.on("studio:key", (_event, domKey: string) => {
    if (typeof domKey !== "string") {
      return;
    }
    // Decoded HERE and not in the renderer: keyFromDom returns null for a modifier or
    // a function key, so Shift held down does not fire a handler once per repeat, and
    // F5 stays with play mode instead of being stealable by a scene.
    const name = keyFromDom(domKey);
    if (name === null) {
      return;
    }
    // While the console is open it takes the whole keyboard. Splitting keys between a
    // console and a game is how you end up typing `vars` and moving the player four
    // cells — one owner at a time, and the owner is whoever is on screen.
    if (consoleOpen) {
      engineConsole.key(name);
      return;
    }
    liveHost?.pressKey(name);
  });

  // The console (docs/studio.md §14). Its scene is examples/console.qbsk — the console
  // is a QBSK program like any other, so it needs no privileged rendering path.
  ipcMain.handle("studio:console", (event, open: boolean): LiveStart => {
    consoleOpen = open;
    if (!open) {
      engineConsole.announce(false);
      stopConsole();
      return { ok: true, error: null };
    }
    engineConsole.setTarget(liveHost);
    engineConsole.announce(true);
    if (consoleHost === null) {
      const source = readFileSync(CONSOLE_SCENE, "utf8");
      const host = new StudioFrameHost(source, CONSOLE_SCENE);
      if (host.error !== null) {
        consoleOpen = false;
        return { ok: false, error: host.error };
      }
      consoleHost = host;
    }
    const sender = event.sender;
    const dt = 1 / LIVE_FPS;
    consoleTimer = setInterval(() => {
      if (consoleHost === null || sender.isDestroyed()) {
        return;
      }
      // The view is refreshed BEFORE the step, so what the scene draws is the console
      // state as of this frame — the whole point of the one-way data path (§14.6).
      consoleHost.setHostData(engineConsole.view());
      const frame = consoleHost.next(dt);
      // Consumed AFTER the step, so the scene saw the sound for exactly one frame and
      // the device gets its gap before the next one.
      engineConsole.endFrame();
      if (frame !== null) {
        audio.frame(consoleHost.audioPlan, consoleHost.gameTime);
        publish(win, frame.text, "console");
        sender.send("studio:frame", frame);
      }
    }, Math.round(1000 / LIVE_FPS));
    return { ok: true, error: null };
  });

  // Automated acceptance check (docs/studio.md §7): only active when
  // QBSK_STUDIO_SMOKE=1; otherwise the renderer report is a no-op.
  ipcMain.handle("studio:smoke", (_event, payload: GridSmoke) => {
    if (process.env.QBSK_STUDIO_SMOKE === "1") {
      console.log(`QBSK_STUDIO_SMOKE=${JSON.stringify(payload)}`);
      app.quit();
    }
    return null;
  });

  const win = createWindow();
  // Never under smoke: that run compares bytes and has no business writing snapshots
  // or capturing pages.
  if (process.env.QBSK_STUDIO_SMOKE !== "1") {
    windowMirror = new WindowMirror(repoRoot);
  }

  // The session mirror (docs/studio.md §12.4): poll the agent's frame journal and
  // forward whatever was appended. Read-only — MirrorReader has no write path, so
  // the window cannot reach the agent's session through this channel.
  //
  // Polling rather than fs.watch: watch on Windows misses appends to a file kept
  // open by another process, which is exactly our case. 80 ms is well under a
  // frame at the rates Studio runs at, and a read that finds nothing costs a stat.
  if (process.env.QBSK_STUDIO_SMOKE !== "1") {
    // SessionWatcher owns the poll state (docs/studio.md §12.4): it reports a
    // vanished journal as an end instead of leaving the window on a stale frame.
    const watcher = new SessionWatcher(new MirrorReader(journalPath(repoRoot)));
    const timer = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(timer);
        return;
      }
      const records = watcher.poll();
      if (records.length === 0) {
        return;
      }
      win.webContents.send("studio:mirror", records);
    }, 80);
    win.on("closed", () => clearInterval(timer));
  }

  // Smoke watchdog: if the renderer never reports back, quit with a failure
  // instead of hanging the smoke run (docs/studio.md §7).
  if (process.env.QBSK_STUDIO_SMOKE === "1") {
    const watchdog = setTimeout(() => {
      console.error("QBSK_STUDIO_SMOKE: no report from renderer, aborting");
      process.exit(1);
    }, 20000);
    watchdog.unref();
  }

  // The live clock must die with the window, or the interval keeps stepping a program
  // whose painter is gone and holds the process open after the last window closes.
  win.on("closed", () => {
    stopLive();
    stopConsole();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
