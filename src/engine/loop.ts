import { performance } from "node:perf_hooks";

// Frame loop (spec engine.md §7): fixed timestep with accumulator (logic runs at
// constant dt) + render at the terminal's real rate. setImmediate yields to the event
// loop (no setInterval, no drift). The clock is injectable for deterministic tests.

export interface LoopOptions {
  fps: number;
  frames?: number;
  now?: () => number;
}

export interface FrameMetrics {
  scriptMs: number;
  composeMs: number;
  diffMs: number;
  emitMs: number;
  cells: number;
  bytes: number;
}

export interface LoopStats {
  frames: number;
  updates: number;
  fpsMean: number;
  fpsP99: number;
  cellsPerFrame: number;
  bytesPerFrame: number;
  msScript: number;
  msCompose: number;
  msDiff: number;
  msEmit: number;
}

export interface LoopHandlers {
  update?: (dt: number) => void;
  render: () => string | null;
}

const STAT_WINDOW = 512;

export class GameLoop {
  private readonly timestep: number;
  private readonly handlers: LoopHandlers;
  private readonly now: () => number;
  private readonly framesLimit: number | undefined;

  private acc = 0;
  private lastTime = 0;
  private frames = 0;
  private updates = 0;
  private stopped = false;
  private done = false;
  private resolveDone: ((s: LoopStats) => void) | null = null;

  private readonly frameDts: number[] = [];
  private totalTime = 0;
  private cells = 0;
  private bytes = 0;
  private msScript = 0;
  private msCompose = 0;
  private msDiff = 0;
  private msEmit = 0;

  constructor(opts: LoopOptions, handlers: LoopHandlers) {
    this.timestep = 1 / opts.fps;
    this.handlers = handlers;
    this.now = opts.now ?? (() => performance.now() / 1000);
    this.framesLimit = opts.frames;
    this.lastTime = this.now();
  }

  step(): void {
    if (this.stopped || this.done) {
      return;
    }
    const t = this.now();
    const dt = t - this.lastTime;
    this.lastTime = t;
    if (dt > 0) {
      this.totalTime += dt;
      this.frameDts.push(dt);
      if (this.frameDts.length > STAT_WINDOW) {
        this.frameDts.shift();
      }
      this.acc += dt;
      while (this.acc >= this.timestep) {
        this.handlers.update?.(this.timestep);
        this.acc -= this.timestep;
        this.updates += 1;
      }
    }
    this.handlers.render();
    this.frames += 1;
    if (this.framesLimit !== undefined && this.frames >= this.framesLimit) {
      this.done = true;
      this.resolveDone?.(this.stats());
    }
  }

  run(): Promise<LoopStats> {
    return new Promise((resolve) => {
      this.resolveDone = resolve;
      this.lastTime = this.now();
      // Next absolute frame slot: pacing waits until the frame mark,
      // never a fixed sleep, so timer jitter does not accumulate (§7).
      let nextFrameAt = this.lastTime;
      const tick = (): void => {
        if (this.stopped || this.done) {
          resolve(this.stats());
          return;
        }
        this.step();
        nextFrameAt += this.timestep;
        const wait = (nextFrameAt - this.now()) * 1000;
        if (wait > 0) {
          setTimeout(tick, wait);
        } else {
          setImmediate(tick);
        }
      };
      setImmediate(tick);
    });
  }

  stop(): void {
    this.stopped = true;
    this.resolveDone?.(this.stats());
  }

  report(m: FrameMetrics): void {
    this.cells += m.cells;
    this.bytes += m.bytes;
    this.msScript += m.scriptMs;
    this.msCompose += m.composeMs;
    this.msDiff += m.diffMs;
    this.msEmit += m.emitMs;
  }

  stats(): LoopStats {
    const frames = Math.max(this.frames, 1);
    const n = this.frameDts.length;
    const latencyP99 =
      n > 0
        ? this.frameDts.slice().sort((a, b) => a - b)[
            Math.max(0, Math.ceil(n * 0.99) - 1)
          ]!
        : 0;
    return {
      frames: this.frames,
      updates: this.updates,
      fpsMean: this.totalTime > 0 ? this.frames / this.totalTime : 0,
      fpsP99: latencyP99 > 0 ? 1 / latencyP99 : 0,
      cellsPerFrame: this.cells / frames,
      bytesPerFrame: this.bytes / frames,
      msScript: this.msScript / frames,
      msCompose: this.msCompose / frames,
      msDiff: this.msDiff / frames,
      msEmit: this.msEmit / frames,
    };
  }
}
