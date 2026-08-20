#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { ScreenBuffer } from "../engine/buffer.js";
import { computeDiff } from "../engine/diff.js";
import { renderFrame } from "../engine/render.js";
import { GameLoop, type FrameMetrics } from "../engine/loop.js";
import { KeyDecoder } from "../engine/input.js";
import { hideCursor, showCursor, RESET } from "../util/ansi.js";
import { formatQbskError, QbskError, QbskRuntimeError } from "../interp/error.js";
import { Interpreter, runQbsk, SceneProgram, type SceneFrame } from "../interp/interpreter.js";
import { dirSaveStore } from "../interp/saveStore.js";
import { AudioDevice } from "../audio/device.js";
import { ExitSignal } from "../interp/natives.js";
import { qbskStr } from "../interp/value.js";
import { tokenize } from "../lexer/lexer.js";
import { printAst } from "../parser/ast.js";
import { parse } from "../parser/parser.js";
import {
  analyzeLayerStaticity,
  analyzeProgram,
  formatLayerStaticityReport,
} from "../analyze/analyzer.js";
import { checkLayout } from "../tools/layout.js";
import { parseArgs, type CliArgs } from "./args.js";

const VERSION = "0.1.0";

const USAGE = `QBSK ${VERSION} — programming language and ASCII engine

usage:
  qbsk run <file.qbsk> [args]              runs a scene or script
  qbsk run --no-audio <file.qbsk>          runs with sound disabled (docs/audio.md)
  qbsk run --ansi <file.qbsk>              emits the scene with ANSI truecolor
  qbsk run --ansi --loop <file.qbsk>       animated frame loop (--fps N --frames N)
  qbsk check <file.qbsk>                   validates syntax and semantics
  qbsk check --layers <file.qbsk>          reports conservative layer staticity
  qbsk fmt <file.qbsk|dir>                 reports layout problems (never rewrites)
  qbsk repl                                 interactive console
  qbsk lex <file.qbsk> --tokens            prints the token stream
  qbsk parse <file.qbsk> --ast             prints the AST
  qbsk profile <file.qbsk> --frames 300    frame loop metrics (M14)
  qbsk --version                            version`;

function printTokens(source: string, file: string): void {
  const tokens = tokenize(source, file);
  for (const t of tokens) {
    const value = t.value === null ? "" : `  ${JSON.stringify(t.value)}`;
    console.log(
      `${file}:${t.span.start.line}:${t.span.start.col}  ${t.type.padEnd(12)}${value}`,
    );
  }
}

function printAstFromSource(source: string, file: string): void {
  const result = parse(source, file);
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(formatQbskError(source, err));
    }
    process.exit(1);
  }
  console.log(printAst(result.ast));
}

function runRepl(): void {
  const interp = new Interpreter({ print: (line) => console.log(line) });
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "qbsk> ",
  });
  rl.prompt();
  rl.on("line", (line) => {
    if (line.trim() !== "") {
      const parsed = parse(line, "<repl>");
      if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
          console.error(formatQbskError(line, err));
        }
      } else {
        try {
          interp.evalProgram(parsed.ast);
          const value = interp.lastExprValue;
          if (value !== null && value.type !== "null") {
            console.log(qbskStr(value));
          }
        } catch (err) {
          if (err instanceof ExitSignal) {
            process.exit(err.code);
          }
          if (err instanceof QbskRuntimeError) {
            console.error(formatQbskError(line, err));
          } else {
            console.error(`qbsk: ${(err as Error).message}`);
          }
        }
      }
    }
    rl.prompt();
  });
  rl.on("close", () => {
    process.exit(0);
  });
}

/**
 * Read a source file, or fail the way QBSK fails (§15.4, invariant I3).
 *
 * `run` and `profile` called `readFileSync` OUTSIDE their try block, so a missing file
 * or a directory dumped a raw Node `ENOENT`/`EISDIR` stack trace — the author asked for
 * a file that is not there and got a page of internals. `lex`/`parse`/`check` caught it,
 * but then called `readFileSync` AGAIN inside the catch to build the snippet, which
 * throws a second time for exactly the case that got them there.
 *
 * One reader for every command: the source is read once, the failure is one line, and
 * the caller keeps the text it already has for formatting.
 */
function readSource(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "file not found"
        : code === "EISDIR"
          ? "this is a directory, not a file"
          : code === "EACCES"
            ? "permission denied"
            : (err as Error).message;
    console.error(`qbsk: cannot read '${file}': ${reason}`);
    process.exit(1);
  }
}

function parseFlagInt(value: string | undefined, dflt: number, flag: string): number {  if (value === undefined) {
    return dflt;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`qbsk: ${flag} expects an int >= 1, got '${value}'`);
    process.exit(1);
  }
  return n;
}

// Frame loop (M14, persistent interpreter): the AST is parsed ONCE; the top level
// runs ONCE in a SceneProgram; each frame the loop advances the game clock by fixed
// dt, dispatches events and re-composes the scene; the composed canvas goes into the
// double buffer and the ANSI diff is emitted. With emit=false (profile) nothing
// is written to stdout except the metrics summary.
function runFrameLoop(
  args: CliArgs,
  source: string,
  opts: { fps: number; frames: number; emit: boolean },
): void {
  const parsed = parse(source, args.file ?? "test.qbsk");
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      console.error(formatQbskError(source, err));
    }
    process.exit(1);
  }
  const runtime = { gameTime: 0 };
  // Profile mode composes without emitting; it must not make noise either.
  const loopAudio = new AudioDevice({
    enabled: !args.flags.includes("no-audio") && opts.emit,
  });
  const program = new SceneProgram(parsed.ast, {
    baseDir: dirname(resolve(args.file ?? "test.qbsk")),
    scriptArgs: args.scriptArgs,
    runtime,
    // Saves live beside the script: <script-dir>/saves/<slot>.qbdata (§13.5).
    saveStore: dirSaveStore(dirname(resolve(args.file ?? "test.qbsk"))),
  });
  if (program.error) {
    console.error(formatQbskError(source, program.error));
    process.exit(1);
  }
  if (program.exitCode !== null) {
    process.exit(program.exitCode);
  }
  let stepDt = 0;
  let buffer: ScreenBuffer | null = null;

  const frameFn = (): FrameMetrics | null => {
    const t0 = performance.now();
    const frame: SceneFrame = program.step(stepDt);
    loopAudio.frame(frame.audioPlan, runtime.gameTime);
    const t1 = performance.now();
    if (frame.error) {
      // This path leaked the hidden cursor long before raw mode existed. With raw
      // mode it would leak the terminal's echo as well, which outlives the program.
      restore();
      console.error(formatQbskError(source, frame.error));
      process.exit(1);
    }
    if (frame.exitCode !== null) {
      // A program can END ITSELF (docs/engine.md §18). Every piece of this was already
      // in place — the interpreter latches the code, SceneFrame carries it, step()
      // keeps reporting it — and this function simply never looked, so `exit(7)` in a
      // handler rendered the remaining frames and exited 0. "Press q to quit" was
      // unimplementable, which is a strange thing for a game engine not to support.
      //
      // Restored the same way the error path restores: raw mode and the hidden cursor
      // outlive the process, so leaving either behind breaks the user's terminal.
      restore();
      process.exit(frame.exitCode);
    }
    if (frame.canvas === null) {
      return null;
    }
    const t2 = performance.now();
    // A scene's size can CHANGE between frames: `width` and `height` are expressions,
    // so a program with `scene S(width: w, ...)` reshapes itself as `w` moves. The
    // buffer used to be allocated once from the first frame and never revisited, so
    // frame 2 reached computeDiff with a row shorter than the buffer and died as a raw
    //   TypeError: Cannot read properties of undefined (reading 'char')
    // A host stack trace reaching the author is the RULE #4 violation §15 removed from
    // the language; it was still alive here. Studio already did this
    // (studio/main/host.ts:313-321) — the CLI is now consistent with it.
    //
    // A fresh buffer starts with an empty front, so the next diff redraws everything:
    // correct, because the whole screen geometry just changed.
    if (
      buffer === null ||
      buffer.width !== frame.canvas.width ||
      buffer.height !== frame.canvas.height
    ) {
      buffer = new ScreenBuffer(frame.canvas.width, frame.canvas.height);
    }
    buffer.paintCanvas(frame.canvas);
    const t3 = performance.now();
    const diff = computeDiff(buffer.front, buffer.back, buffer.width, buffer.dirtyLines);
    const ansi = renderFrame(diff, buffer.width);
    const t4 = performance.now();
    const cells = diff.reduce((acc, d) => acc + d.changed, 0);
    if (opts.emit) {
      process.stdout.write(ansi);
    }
    buffer.swap();
    const m: FrameMetrics = {
      scriptMs: t1 - t0,
      composeMs: t2 - t1,
      diffMs: t3 - t2,
      emitMs: t4 - t3,
      cells,
      bytes: ansi.length,
    };
    return m;
  };

  // --- Terminal input (docs/engine.md §8) ---
  //
  // Gated on opts.emit, which correctly excludes `qbsk profile`: enabling raw mode
  // in a benchmark would corrupt a run that is supposed to be non-interactive.
  //
  // The guard is `typeof setRawMode === 'function'` and not a truthiness check,
  // because when stdin is a PIPE the method is undefined rather than falsy and an
  // unguarded call throws — which would break every piped verification run in this
  // repository.
  const stdin = process.stdin;
  const interactive =
    opts.emit &&
    stdin.isTTY === true &&
    typeof stdin.setRawMode === "function";
  const decoder = new KeyDecoder();
  let quit = false;

  /**
   * Puts the terminal back and lets the process end.
   *
   * Idempotent, because it runs from the normal path, the error path and the signal
   * handlers, and any of them can happen after another. Leaving raw mode on returns
   * the user a terminal with no echo — worse than a crash, because it outlives the
   * program.
   */
  let restored = false;
  const restore = (): void => {
    if (restored) {
      return;
    }
    restored = true;
    if (interactive) {
      try {
        stdin.setRawMode(false);
      } catch {
        // Nothing useful to do: the terminal is already gone.
      }
      stdin.removeAllListeners("data");
      process.stdout.removeAllListeners("resize");
      // WITHOUT THIS A PIPED RUN NEVER EXITS. A 'data' listener puts stdin in
      // flowing mode and holds the event loop open — measured at 8000 ms still
      // alive, against 1081 ms with the pause.
      stdin.pause();
    }
    if (opts.emit) {
      process.stdout.write(RESET + showCursor);
    }
  };

  if (interactive) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", (chunk: Buffer) => {
      for (const name of decoder.push(chunk)) {
        if (name === "ctrl-c") {
          // Raw mode stops the OS generating SIGINT, so this is the ONLY way out
          // for an interactive user. Forgetting it makes the loop unkillable
          // except by closing the terminal.
          quit = true;
          continue;
        }
        program.pressKey(name);
      }
    });
  }

  // Terminal resize (ROADMAP M19 DoD). Node raises "resize" on the stdout TTY for both
  // SIGWINCH and the Windows console event, so one listener covers both and no signal
  // has to be handled by hand. Queued like a key: the program sees it inside step().
  if (interactive) {
    // The size the terminal ALREADY is, before anything changes. Without this a scene
    // could only learn the window it was in by being resized — so a responsive layout
    // opened at whatever `scene S(width:, height:)` declared and stayed there until the
    // author dragged the corner. Found running the arena in a stock cmd.exe, where 113x48
    // does not fit and the game had no way to know.
    program.resize(process.stdout.columns ?? 0, process.stdout.rows ?? 0);
    process.stdout.on("resize", () => {
      program.resize(process.stdout.columns ?? 0, process.stdout.rows ?? 0);
    });
  }

  if (opts.emit) {
    process.stdout.write(hideCursor);
  }
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("uncaughtException", (err) => {
    restore();
    console.error(err);
    process.exit(1);
  });
  const loop = new GameLoop({ fps: opts.fps, frames: opts.frames }, {
    update: (dt) => {
      // gameTime is advanced by SceneProgram.step (interpreter.ts): the clock
      // belongs to the program, so no host has to remember to tick it.
      stepDt = dt;
    },
    render: () => {
      // A lone escape only resolves once nothing follows it (§8.1), so the idle tick
      // is where it surfaces.
      if (interactive) {
        for (const name of decoder.flush()) {
          if (name === "ctrl-c") {
            quit = true;
          } else {
            program.pressKey(name);
          }
        }
      }
      if (quit) {
        loop.stop();
        return "";
      }
      const m = frameFn();
      if (m !== null) {
        loop.report(m);
      }
      return "";
    },
  });
  loop
    .run()
    .then((stats) => {
      restore();
      console.log(formatStats(stats, opts.fps));
    })
    .catch((err: unknown) => {
      // loop.run() had no .catch, so an error escaping a frame left the terminal in
      // whatever state it was in and the process alive.
      restore();
      console.error(err);
      process.exit(1);
    });
}

function formatStats(s: import("../engine/loop.js").LoopStats, fps: number): string {
  return [
    `frames: ${s.frames}  updates: ${s.updates}  target: ${fps} fps`,
    `fps mean: ${s.fpsMean.toFixed(1)}  p99: ${s.fpsP99.toFixed(1)}`,
    `cells/frame: ${s.cellsPerFrame.toFixed(2)}  bytes/frame: ${s.bytesPerFrame.toFixed(1)}`,
    `ms/frame — script: ${s.msScript.toFixed(3)}  compose: ${s.msCompose.toFixed(3)}  ` +
      `diff: ${s.msDiff.toFixed(3)}  emit: ${s.msEmit.toFixed(3)}`,
  ].join("\n");
}

export function main(argv: string[]): void {
  const args = parseArgs(argv);
  if (args === null) {
    console.error(USAGE);
    process.exit(1);
  }
  switch (args.command) {
    case "version":
      console.log(`QBSK ${VERSION}`);
      return;
    case "help":
      console.log(USAGE);
      return;
    case "lex": {
      if (args.file === null) {
        console.error("qbsk lex: missing the .qbsk file");
        process.exit(1);
      }
      // Read before the try: readSource reports its own failure, so the try is left
      // for what it is actually guarding — lexing (§15.4).
      const lexSource = readSource(args.file);
      try {
        printTokens(lexSource, args.file);
      } catch (err) {
        if (err instanceof QbskError) {
          console.error(formatQbskError(lexSource, err));
          process.exit(1);
        }
        console.error(`qbsk: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }
    case "parse": {
      if (args.file === null) {
        console.error("qbsk parse: missing the .qbsk file");
        process.exit(1);
      }
      const parseSource = readSource(args.file);
      try {
        printAstFromSource(parseSource, args.file);
      } catch (err) {
        if (err instanceof QbskError) {
          console.error(formatQbskError(parseSource, err));
          process.exit(1);
        }
        console.error(`qbsk: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }
    case "run": {
      if (args.file === null) {
        console.error("qbsk run: missing the .qbsk file");
        process.exit(1);
      }
      const source = readSource(args.file);
      const fps = parseFlagInt(args.flagValues.fps, 20, "--fps");
      const frames = args.flagValues.frames !== undefined
        ? parseFlagInt(args.flagValues.frames, 0, "--frames")
        : undefined;
      if (args.flags.includes("ansi") && args.flags.includes("loop")) {
        runFrameLoop(args, source, { fps, frames: frames ?? 120, emit: true });
        return;
      }
      try {
        // --no-audio is a true disable flag for a default-on capability
        // (docs/audio.md §6). Silence must never change what the program prints.
        const audio = new AudioDevice({ enabled: !args.flags.includes("no-audio") });
        const result = runQbsk(source, args.file, {
          print: (line) => console.log(line),
        }, {
          baseDir: dirname(resolve(args.file)),
          scriptArgs: args.scriptArgs,
          saveStore: dirSaveStore(dirname(resolve(args.file))),
        });
        if (result.error) {
          console.error(formatQbskError(source, result.error));
          process.exit(1);
        }
        if (result.exitCode !== null) {
          process.exit(result.exitCode);
        }
        audio.frame(result.audioPlan, 0);
        if (args.flags.includes("ansi") && result.canvas !== null) {
          const buffer = new ScreenBuffer(result.canvas.width, result.canvas.height);
          buffer.paintCanvas(result.canvas);
          const diff = computeDiff(buffer.front, buffer.back, buffer.width, buffer.dirtyLines);
          const ansi = renderFrame(diff, buffer.width);
          process.stdout.write(ansi + "\n");
        }
      } catch (err) {
        if (err instanceof QbskError) {
          console.error(formatQbskError(source, err));
          process.exit(1);
        }
        console.error(`qbsk: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }
    case "profile": {
      if (args.file === null) {
        console.error("qbsk profile: missing the .qbsk file");
        process.exit(1);
      }
      const source = readSource(args.file);
      const frames = args.flagValues.frames !== undefined
        ? parseFlagInt(args.flagValues.frames, 300, "--frames")
        : 300;
      runFrameLoop(args, source, { fps: 60, frames, emit: false });
      return;
    }
    case "check": {
      if (args.file === null) {
        console.error("qbsk check: missing the .qbsk file");
        process.exit(1);
      }
      const checkSource = readSource(args.file);
      try {
        const result = parse(checkSource, args.file);
        const problems = [
          ...result.errors,
          ...(result.errors.length === 0
            ? analyzeProgram(result.ast, args.file, dirname(resolve(args.file)))
            : []),
        ];
        if (problems.length > 0) {
          for (const err of problems) {
            console.error(formatQbskError(checkSource, err));
          }
          process.exit(1);
        }
        if (args.flags.includes("layers")) {
          for (const line of formatLayerStaticityReport(analyzeLayerStaticity(result.ast))) {
            console.log(line);
          }
        }
        console.log(`OK: '${args.file}' has no problems`);
      } catch (err) {
        if (err instanceof QbskError) {
          console.error(formatQbskError(checkSource, err));
          process.exit(1);
        }
        console.error(`qbsk: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }
    case "fmt": {
      if (args.file === null) {
        console.error("qbsk fmt: missing the .qbsk file or directory");
        process.exit(1);
      }
      // A CHECKER (docs/language.md §19): it reports and exits non-zero, and never
      // opens a file for writing. That is why it cannot corrupt anything, and why
      // there is no `--write` — see §19.1.
      const target = resolve(args.file);
      const files = statSync(target).isDirectory()
        ? readdirSync(target)
            .filter((f) => f.endsWith(".qbsk"))
            .map((f) => join(target, f))
        : [target];

      let problems = 0;
      for (const path of files) {
        const source = readSource(path);
        for (const finding of checkLayout(source, path)) {
          console.error(
            formatQbskError(source, new QbskError(finding.message, finding.span, "syntax")),
          );
          problems += 1;
        }
      }
      if (problems > 0) {
        console.error(
          `qbsk fmt: ${problems} layout problem${problems === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}`,
        );
        process.exit(1);
      }
      console.log(
        `OK: ${files.length} file${files.length === 1 ? "" : "s"} with clean layout`,
      );
      return;
    }
    case "repl":
      runRepl();
      return;
    default:
      console.error(`qbsk ${args.command}: not implemented yet (not yet built)`);
      process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main(process.argv.slice(2));
}
