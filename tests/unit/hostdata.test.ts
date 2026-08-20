// The host -> program data path (docs/studio.md §14.6).
import { describe, expect, it } from "vitest";
import { SceneProgram } from "../../src/interp/interpreter.js";
import { parse } from "../../src/parser/parser.js";
import type { HostValue } from "../../src/interp/natives.js";

const program = (src: string, host?: Record<string, HostValue>) => {
  const parsed = parse(src, "t.qbsk");
  expect(parsed.errors).toEqual([]);
  const runtime = { gameTime: 0, host };
  return new SceneProgram(parsed.ast, { runtime });
};

const printed = (src: string, host?: Record<string, HostValue>): string[] => {
  const out: string[] = [];
  const parsed = parse(src, "t.qbsk");
  expect(parsed.errors).toEqual([]);
  const p = new SceneProgram(parsed.ast, {
    runtime: { gameTime: 0, host },
    print: (line) => out.push(line),
  });
  p.step(1 / 60);
  return out;
};

describe("host() hands data IN; a program can never reach out", () => {
  it("reads a string the host put there", () => {
    expect(printed('on tick(dt)\n    print(host("greeting"))', {
      greeting: "hello",
    })).toEqual(["hello"]);
  });

  it("reads a list of strings, which is what scrollback is", () => {
    const out = printed(
      'on tick(dt)\n    var l = host("lines")\n    print(len(l))\n    print(l[1])',
      { lines: ["first", "second", "third"] },
    );
    expect(out).toEqual(["3", "second"]);
  });

  it("a whole number arrives as int, so it can index and position", () => {
    const out = printed(
      'on tick(dt)\n    var c = host("cursor")\n    print(c + 1)',
      { cursor: 7 },
    );
    expect(out).toEqual(["8"]);
  });

  it("a fractional number arrives as float", () => {
    expect(printed('on tick(dt)\n    print(host("ratio"))', { ratio: 0.5 }))
      .toEqual(["0.5"]);
  });

  it("a boolean arrives as bool", () => {
    const out = printed(
      'on tick(dt)\n    if host("open")\n        print("yes")',
      { open: true },
    );
    expect(out).toEqual(["yes"]);
  });

  // A missing key is null rather than an error: a scene must be able to draw before
  // the host has anything to say, exactly as it composes once before the first tick.
  it("an absent key is null, not an error", () => {
    expect(printed('on tick(dt)\n    print(host("nothing") == null)', {}))
      .toEqual(["true"]);
  });

  it("no host data at all is still null, not a crash", () => {
    expect(printed('on tick(dt)\n    print(host("anything") == null)'))
      .toEqual(["true"]);
  });

  it("reports a non-string key with the type it got", () => {
    const p = program('on tick(dt)\n    print(host(7))', {});
    const frame = p.step(1 / 60);
    expect(frame.error).not.toBeNull();
    expect(frame.error!.message).toContain("int");
  });

  it("reports the wrong arity by name", () => {
    const p = program('on tick(dt)\n    print(host())', {});
    const frame = p.step(1 / 60);
    expect(frame.error).not.toBeNull();
    expect(frame.error!.message).toContain("host");
  });
});

describe("the data path does not weaken determinism", () => {
  // docs/language.md §7.7: a frame is a pure function of the live state. host() reads
  // what was set BEFORE the step, so the guarantee survives — same data, same clock,
  // same bytes.
  it("the same host data and clock produce the same frame", () => {
    const src = [
      'on tick(dt)',
      '    var n = 0',
      "scene S(width: 20, height: 3)",
      "layer a z: 1",
      '    fill "."',
      '    put host("label") at (1, 1)',
    ].join("\n");
    const render = (): string => {
      const p = program(src, { label: "READY" });
      p.step(1 / 60);
      return p.step(1 / 60).canvas!.renderText();
    };
    expect(render()).toBe(render());
  });

  it("changing the host data changes the frame — the path actually carries", () => {
    const src = [
      "scene S(width: 20, height: 3)",
      "layer a z: 1",
      '    fill "."',
      '    put host("label") at (1, 1)',
    ].join("\n");
    const frameFor = (label: string): string => {
      const p = program(src, { label });
      return p.step(1 / 60).canvas!.renderText();
    };
    expect(frameFor("ONE")).not.toBe(frameFor("TWO"));
    expect(frameFor("ONE")).toContain("ONE");
  });

  // The host mutates its own object between frames; the program sees the new value
  // on the next step and never mid-frame.
  it("an update between frames is visible on the next frame", () => {
    const src = [
      "scene S(width: 20, height: 3)",
      "layer a z: 1",
      '    fill "."',
      '    put host("label") at (1, 1)',
    ].join("\n");
    const host: Record<string, HostValue> = { label: "AAA" };
    const p = program(src, host);
    expect(p.step(1 / 60).canvas!.renderText()).toContain("AAA");
    host["label"] = "BBB";
    expect(p.step(1 / 60).canvas!.renderText()).toContain("BBB");
  });
});
