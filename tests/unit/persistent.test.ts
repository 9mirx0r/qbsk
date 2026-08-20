import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SceneProgram, runQbsk } from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";

// An earlier release — persistent state model (docs/language.md §7.7). The interpreter is
// created once, the top level runs once; per frame the handlers dispatch and the
// scene re-composes from the live environment. A var mutated in a handler MUST
// persist into the following frames — that is what Criterion 3 proves.

interface Harness {
  step: (dt?: number) => number;
  error: () => string | null;
  exit: () => number | null;
  out: () => string[];
  pressKey: (name: string) => void;
  resize: (w: number, h: number) => void;
}

function make(source: string, opts?: { scriptArgs?: string[] }): Harness {
  const parsed = parse(source, "persistent.qbsk");
  expect(parsed.errors).toHaveLength(0);
  const out: string[] = [];
  const program = new SceneProgram(parsed.ast, {
    print: (line) => out.push(line),
    scriptArgs: opts?.scriptArgs,
  });
  return {
    step: (dt = 1 / 60) => {
      const frame = program.step(dt);
      expect(frame.error).toBeNull();
      return frame.canvas?.width ?? 0;
    },
    error: () => program.error?.message ?? null,
    exit: () => program.exitCode,
    out: () => out,
    pressKey: (name) => program.pressKey(name),
    resize: (w, h) => program.resize(w, h),
  };
}

describe("persistent interpreter (docs/language.md §7.7)", () => {
  it("the top level runs ONCE: a handler counter survives across frames", () => {
    const h = make(`
var n = 0
on tick(dt)
    n += 1
    print("tick:" + str(n))
scene main(width: 10, height: 3)
`);
    h.step();
    h.step();
    h.step();
    expect(h.out()).toEqual(["tick:1", "tick:2", "tick:3"]);
  });

  it("on start runs once, before the first tick", () => {
    const h = make(`
var n = 0
on start
    print("start")
on tick(dt)
    n += 1
    print("tick:" + str(n))
scene main(width: 10, height: 3)
`);
    h.step();
    h.step();
    expect(h.out()).toEqual(["start", "tick:1", "tick:2"]);
  });

  it("tick receives the fixed dt as a float", () => {
    const h = make(`
on tick(dt)
    print(type(dt))
scene main(width: 10, height: 3)
`);
    h.step();
    expect(h.out()).toEqual(["float"]);
  });

  it("an on key mutation PERSISTS into the following frames", () => {
    const h = make(`
var x = 0
on key "arrow-left"
    x = 5
    print("keyed")
scene main(width: 10, height: 3)
`);
    h.step();
    expect(h.out()).toEqual([]);
    h.pressKey("arrow-left");
    h.step();
    expect(h.out()).toEqual(["keyed"]);
    // No new key: the mutation from the previous frame is still live.
    h.step();
    expect(h.out()).toEqual(["keyed"]);
  });

  it("key events queue FIFO and dispatch in order", () => {
    const h = make(`
var log = ""
on key "a"
    log = log + "a"
on key "b"
    log = log + "b"
scene main(width: 10, height: 3)
`);
    h.pressKey("a");
    h.pressKey("b");
    h.pressKey("a");
    h.step();
    h.step();
    // Both queued keys fire in the first step; the second step drains nothing.
    expect(h.out()).toEqual([]);
  });

  it("resize handlers receive the new width and height as ints", () => {
    const h = make(`
on resize(w, h)
    print("resized:" + str(w) + "," + str(h))
scene main(width: 10, height: 3)
`);
    h.resize(40, 20);
    h.step();
    expect(h.out()).toEqual(["resized:40,20"]);
  });

  it("handler locals do not leak into the top-level scope", () => {
    const h = make(`
on tick(dt)
    var local = 42
    print("local:" + str(local))
scene main(width: 10, height: 3)
`);
    h.step();
    h.step();
    expect(h.out()).toEqual(["local:42", "local:42"]);
  });

  it("the scene re-composes from the live environment each frame", () => {
    const h = make(`
var width = 10
on tick(dt)
    width += 1
scene main(width: width, height: 3)
`);
    expect(h.step()).toBe(11);
    expect(h.step()).toBe(12);
    expect(h.step()).toBe(13);
  });

  it("an uncaught mid-frame error aborts the loop with the original span", () => {
    const parsed = parse(
      `
var x = 0
on tick(dt)
    x = missing_name
scene main(width: 10, height: 3)
`,
      "persistent.qbsk",
    );
    expect(parsed.errors).toHaveLength(0);
    const out: string[] = [];
    const program = new SceneProgram(parsed.ast, { print: (l) => out.push(l) });
    expect(program.error).toBeNull();
    const first = program.step(1 / 60);
    expect(first.error).not.toBeNull();
    expect(first.error!.message).toContain("not defined");
    expect(first.error!.span.file).toBe("persistent.qbsk");
    // A later step must not silently continue with half-mutated state.
    const second = program.step(1 / 60);
    expect(second.error).not.toBeNull();
    expect(program.error).not.toBeNull();
  });

  it("an error caught by try/catch does not abort the loop", () => {
    const h = make(`
var n = 0
on tick(dt)
    try
        n = missing_name
    catch e:
        n += 1
    print("n:" + str(n))
scene main(width: 10, height: 3)
`);
    h.step();
    h.step();
    expect(h.out()).toEqual(["n:1", "n:2"]);
  });

  it("exit() stops the loop and reports the exit code", () => {
    const parsed = parse(
      `
on tick(dt)
    exit(3)
scene main(width: 10, height: 3)
`,
      "persistent.qbsk",
    );
    const program = new SceneProgram(parsed.ast);
    const first = program.step(1 / 60);
    expect(first.exitCode).toBe(3);
    expect(program.exitCode).toBe(3);
    const second = program.step(1 / 60);
    expect(second.exitCode).toBe(3);
  });

  it("scriptArgs reach the persistent program", () => {
    const h = make(
      `
print(args()[0])
scene main(width: 10, height: 3)
`,
      { scriptArgs: ["hello"] },
    );
    h.step();
    expect(h.out()).toEqual(["hello"]);
  });

  it("a program with no scene still runs handlers without crashing", () => {
    const h = make(`
var n = 0
on tick(dt)
    n += 1
    print("tick:" + str(n))
`);
    h.step();
    h.step();
    expect(h.out()).toEqual(["tick:1", "tick:2"]);
  });
});

describe("persistent determinism (docs/language.md §7.7, RULE #3)", () => {
  // Frame goldens stay byte-exact by scripting the input sequence: a given
  // (input sequence, frame count) always produces identical bytes.
  const exampleSource = readFileSync(
    new URL("../../examples/keys.qbsk", import.meta.url),
    "utf8",
  );
  const golden = (name: string): string =>
    readFileSync(new URL(`../golden/${name}.out`, import.meta.url), "utf8")
      .replace(/\r\n/g, "\n");

  function drive(source: string, dt: number, keys: string[], frames: number): string[] {
    const parsed = parse(source, "keys.qbsk");
    expect(parsed.errors).toHaveLength(0);
    const program = new SceneProgram(parsed.ast);
    expect(program.error).toBeNull();
    const rows: string[] = [];
    for (let f = 0; f < frames; f += 1) {
      const key = keys[f] ?? "";
      if (key !== "") {
        program.pressKey(key);
      }
      const frame = program.step(dt);
      expect(frame.error).toBeNull();
      if (frame.canvas !== null) {
        rows.push(frame.canvas.renderText().split("\n").join("|"));
      }
    }
    return rows;
  }

  it("keys.qbsk: same (key sequence, frame count) → identical bytes, twice", () => {
    const seq = ["arrow-right", "", "", "arrow-right", "", "arrow-left", "", ""];
    const a = drive(exampleSource, 1 / 20, seq, 8);
    const b = drive(exampleSource, 1 / 20, seq, 8);
    expect(a).toEqual(b);
    expect(a.length).toBe(8);
    // The ball moves (tick) and the player responds to the scripted keys.
    expect(a[0]).not.toBe(a[1]!);
    expect(a[0]!.includes("@")).toBe(true);
  });

  it("keys.qbsk one-shot output matches the static golden byte by byte", () => {
    const r = runQbsk(exampleSource, "examples/keys.qbsk");
    expect(r.error).toBeNull();
    expect(r.out.join("\n")).toBe(golden("keys.qbsk"));
  });
});

// A snippet evaluated against a live program shares that program's environment — which
// is the whole point, and also how its output went missing. `print` is a NATIVE, so it
// is resolved through the env chain like any other name; handing the snippet interpreter
// `liveEnv` meant every lookup of `print` found the PROGRAM's native, writing to the
// program's sink. The snippet's own `out` stayed empty and the caller was told nothing
// was printed.
describe("evalSnippet output belongs to the snippet (docs/studio.md §11.4)", () => {
  const live = (source: string) => {
    const parsed = parse(source, "host.qbsk");
    expect(parsed.errors).toHaveLength(0);
    const hostOut: string[] = [];
    const program = new SceneProgram(parsed.ast, { print: (line) => hostOut.push(line) });
    return { program, hostOut };
  };

  it("a snippet's print is returned to the caller", () => {
    const { program } = live("var x = 7\n");
    const run = program.evalSnippet('print("hello from the snippet")', "e.qbsk");
    expect(run.error).toBeNull();
    expect(run.out).toEqual(["hello from the snippet"]);
  });

  it("it reads live state while printing its own output", () => {
    const { program } = live("var name = \"world\"\n");
    const run = program.evalSnippet('print("hello {name}")', "e.qbsk");
    expect(run.out).toEqual(["hello world"]);
  });

  // The other half of the same bug: the program's sink must not receive the snippet's
  // lines either. A window mirroring program output would otherwise show text the
  // program never printed.
  it("the program's own sink does not receive the snippet's lines", () => {
    const { program, hostOut } = live("var x = 1\n");
    program.evalSnippet('print("snippet only")', "e.qbsk");
    expect(hostOut).toEqual([]);
  });

  it("a snippet that prints inside a function still reports it", () => {
    const { program } = live("func greet(who)\n    print(\"hi {who}\")\n");
    const run = program.evalSnippet('greet("there")', "e.qbsk");
    expect(run.out).toEqual(["hi there"]);
  });
});
