// Preload bridge (docs/studio.md §3): exposes a minimal `window.api` via
// contextBridge. The window runs with contextIsolation and no nodeIntegration,
// so this is the only channel from the renderer to the main process. Compiled
// from .cts to .cjs: sandboxed preloads must be CommonJS.
import { contextBridge, ipcRenderer } from "electron";
import type { LiveFailure, StudioApi } from "../shared/api.js";

const api: StudioApi = {
  async defaultScene() {
    return (await ipcRenderer.invoke(
      "studio:defaultScene",
    )) as Awaited<ReturnType<StudioApi["defaultScene"]>>;
  },
  async readScene(file: string) {
    return (await ipcRenderer.invoke(
      "studio:read",
      file,
    )) as Awaited<ReturnType<StudioApi["readScene"]>>;
  },
  async run(source: string, file: string, cellAspect?: number) {
    return (await ipcRenderer.invoke(
      "studio:run",
      source,
      file,
      cellAspect,
    )) as Awaited<ReturnType<StudioApi["run"]>>;
  },
  async smoke(payload: Parameters<StudioApi["smoke"]>[0]) {
    await ipcRenderer.invoke("studio:smoke", payload);
  },
  // Session mirror (docs/studio.md §12.4): main -> renderer only. There is no
  // matching send() in this bridge, so the renderer cannot push anything back
  // into the agent's session through the mirror.
  onMirror(handler: Parameters<StudioApi["onMirror"]>[0]) {
    ipcRenderer.on(
      "studio:mirror",
      (_event, records: Parameters<typeof handler>[0]) => {
        handler(records);
      },
    );
  },
  // The live program (docs/studio.md §14.4): main owns the SceneProgram and the
  // clock, the renderer paints what arrives and forwards keys.
  async live(source: string, file: string, cellAspect?: number) {
    return (await ipcRenderer.invoke(
      "studio:live",
      source,
      file,
      cellAspect,
    )) as Awaited<ReturnType<StudioApi["live"]>>;
  },
  onFrame(handler: Parameters<StudioApi["onFrame"]>[0]) {
    ipcRenderer.on(
      "studio:frame",
      (_event, frame: Parameters<typeof handler>[0]) => {
        handler(frame);
      },
    );
  },
  async resize(cols: number, rows: number) {
    await ipcRenderer.invoke("studio:resize", cols, rows);
  },
  onLiveError(handler: (failure: LiveFailure) => void) {
    ipcRenderer.on("studio:liveError", (_event, failure: LiveFailure) => {
      handler(failure);
    });
  },
  async stopLive() {
    await ipcRenderer.invoke("studio:stopLive");
  },
  // The FIRST renderer -> main send in this bridge, and the distinction matters:
  // it addresses the window's OWN program, never the agent's MCP session. The
  // asymmetry §12.2 protects is observer-cannot-write-to-session; this channel
  // cannot reach that session, so it does not weaken it (docs/studio.md §14.2).
  // Fire-and-forget rather than invoke: a keystroke has no answer to wait for, and
  // making the renderer await one would couple typing latency to the frame clock.
  // Sends the RAW KeyboardEvent.key; main decodes it (docs/studio.md §14.5). The
  // renderer does not import from src/, and a name from the renderer is validated on
  // the trusted side rather than believed.
  pressKey(domKey: string) {
    ipcRenderer.send("studio:key", domKey);
  },
  async toggleConsole(open: boolean) {
    return (await ipcRenderer.invoke(
      "studio:console",
      open,
    )) as Awaited<ReturnType<StudioApi["toggleConsole"]>>;
  },
  async tileset(path: string) {
    return (await ipcRenderer.invoke(
      "studio:tiles",
      path,
    )) as Awaited<ReturnType<StudioApi["tileset"]>>;
  },
  async openScene() {
    return (await ipcRenderer.invoke(
      "studio:openScene",
    )) as Awaited<ReturnType<StudioApi["openScene"]>>;
  },
  async pickTileset() {
    return (await ipcRenderer.invoke(
      "studio:pickTileset",
    )) as Awaited<ReturnType<StudioApi["pickTileset"]>>;
  },
};

contextBridge.exposeInMainWorld("api", api);
