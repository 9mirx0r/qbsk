// Choosing a painter (docs/studio.md §4.2).
//
// The choice itself, not the painters. What matters here is that a machine without WebGL
// still gets a window: `createGlDevice` returns null rather than throwing, and this must
// turn that into `DomGrid` instead of into a blank screen.
import { describe, expect, it, vi, afterEach } from "vitest";

const created = vi.hoisted(() => ({ calls: 0, device: null as unknown }));

vi.mock("../../studio/renderer/gldevice.js", () => ({
  createGlDevice: () => {
    created.calls += 1;
    return created.device;
  },
}));

const { choosePainter } = await import("../../studio/renderer/painter.js");

const fakeDom = () => ({ textContent: "", style: {} as Record<string, string>, append() {} });
const fakeDevice = () => ({ resize() {}, drawGlyph() {}, upload() {}, draw() {} });

afterEach(() => {
  created.calls = 0;
  created.device = null;
});

describe("choosePainter", () => {
  it("takes the GPU painter when the device builds", () => {
    created.device = fakeDevice();
    const chosen = choosePainter(
      fakeDom() as unknown as HTMLElement,
      {} as HTMLCanvasElement, 8, 16, "monospace",
    );
    expect(chosen.backend).toBe("webgl");
  });

  it("falls back to the DOM when WebGL is unavailable, rather than failing", () => {
    // A machine with no GPU path is a machine, not an error. F3's own measurement is
    // what makes this acceptable: the DOM painter costs 0.80 ms on a 450-cell diff.
    created.device = null;
    const chosen = choosePainter(
      fakeDom() as unknown as HTMLElement,
      {} as HTMLCanvasElement, 8, 16, "monospace",
    );
    expect(chosen.backend).toBe("dom");
  });

  it("does not even ask when there is no canvas to draw into", () => {
    choosePainter(fakeDom() as unknown as HTMLElement, null, 8, 16, "monospace");
    expect(created.calls).toBe(0);
  });

  it("gives back the same four methods whichever it chose", () => {
    // The property the whole stage rests on. `renderer.ts` calls these and nothing else,
    // so a painter missing one is a painter that cannot be swapped in.
    created.device = fakeDevice();
    const gl = choosePainter(fakeDom() as unknown as HTMLElement, {} as HTMLCanvasElement, 8, 16, "m");
    created.device = null;
    const dom = choosePainter(fakeDom() as unknown as HTMLElement, {} as HTMLCanvasElement, 8, 16, "m");
    for (const method of ["setTiles", "reset", "paint", "renderText"] as const) {
      expect(typeof gl.painter[method], `webgl ${method}`).toBe("function");
      expect(typeof dom.painter[method], `dom ${method}`).toBe("function");
    }
  });
});
