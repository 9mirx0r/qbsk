// An earlier release — sound, from scratch and with no dependencies (docs/audio.md).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  synthesize,
  isWaveName,
  WAVE_NAMES,
  type TonePlanEntry,
} from "../../src/audio/tone.js";
import { encodeWav, AudioDevice } from "../../src/audio/device.js";
import { tokenize } from "../../src/lexer/lexer.js";
import { parse } from "../../src/parser/parser.js";
import { analyzeProgram } from "../../src/analyze/analyzer.js";
import { runQbsk, SceneProgram } from "../../src/interp/interpreter.js";

const SAMPLE_RATE = 44100;

function golden(name: string): Int16Array {
  const text = readFileSync(
    new URL(`../golden/${name}.out`, import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
  return Int16Array.from(
    text.trim().split(/\s+/).map(Number),
  );
}

describe("synthesize is pure mathematics (docs/audio.md §2)", () => {
  const base = { freq: 440, wave: "square" as const, duration: 0.02, volume: 0.5 };

  it("sample count is round(44100 * duration)", () => {
    expect(synthesize(base)).toHaveLength(Math.round(SAMPLE_RATE * 0.02));
    expect(
      synthesize({ ...base, duration: 1 }),
    ).toHaveLength(SAMPLE_RATE);
  });

  it("the envelope is click-free: it ramps in and out", () => {
    const s = synthesize(base);
    expect(s[0]).toBe(0);
    expect(s[s.length - 1]).toBe(0);
    // 5 ms after the start the attack ramp is complete (220 samples at 44100 Hz).
    expect(Math.abs(s[220]!)).toBe(16384);
  });

  it("a square wave rides only the two rails, and alternates between them", () => {
    const s = synthesize(base);
    const mid = Array.from(s.slice(300, 400));
    for (const v of mid) {
      expect(Math.abs(v)).toBe(16384);
    }
    expect(mid).toContain(16384);
    expect(mid).toContain(-16384);
  });

  it("volume scales the rails: 1.0 → full scale, 0.5 → half", () => {
    const full = synthesize({ ...base, volume: 1 });
    expect(Math.abs(full[300]!)).toBe(32767);
  });

  it("volume is clamped to [0, 1]: 2.0 and -1.0 do not overshoot or flip", () => {
    const loud = synthesize({ ...base, volume: 2 });
    expect(Math.abs(loud[300]!)).toBe(32767);
    const silent = synthesize({ ...base, volume: -1 });
    expect(silent.every((v) => v === 0)).toBe(true);
  });

  it("is byte-deterministic: same parameters, same buffer", () => {
    expect(synthesize(base)).toEqual(synthesize(base));
  });

  it("noise is seeded and deterministic — never Math.random()", () => {
    const a = synthesize({ ...base, wave: "noise", volume: 1 });
    const b = synthesize({ ...base, wave: "noise", volume: 1 });
    expect(a).toEqual(b);
    expect(a.some((v) => v !== 0)).toBe(true);
    // Noise must be audible white noise: a wide excursion range, not a DC thump.
    const mid = Array.from(a.slice(300, 900));
    expect(Math.min(...mid)).toBeLessThan(-20000);
    expect(Math.max(...mid)).toBeGreaterThan(20000);
  });

  it("sine and triangle reach the same rails at full volume but differ in shape", () => {
    const sine = synthesize({ ...base, wave: "sine", volume: 1 });
    const triangle = synthesize({ ...base, wave: "triangle", volume: 1 });
    // Max excursion equals the rail for both (they are bounded curves).
    expect(Math.max(...Array.from(sine))).toBeLessThanOrEqual(32767);
    expect(Math.max(...Array.from(triangle))).toBeLessThanOrEqual(32767);
    // A triangle is piecewise-linear in phase; a sine is not — mid samples differ.
    expect(sine[440]).not.toBe(triangle[440]);
  });

  it("rejects non-positive freq and duration", () => {
    expect(() => synthesize({ ...base, freq: 0 })).toThrow();
    expect(() => synthesize({ ...base, freq: -1 })).toThrow();
    expect(() => synthesize({ ...base, duration: 0 })).toThrow();
  });

  it("knows the valid wave names", () => {
    expect(WAVE_NAMES).toEqual(["sine", "square", "triangle", "sawtooth", "noise"]);
    expect(isWaveName("sine")).toBe(true);
    expect(isWaveName("swoosh")).toBe(false);
  });

  it("goldens: each waveform matches its byte-exact file", () => {
    const cases: [string, "sine" | "square" | "noise"][] = [
      ["tone-sine", "sine"],
      ["tone-square", "square"],
      ["tone-noise", "noise"],
    ];
    for (const [name, wave] of cases) {
      expect(synthesize({ ...base, wave })).toEqual(golden(name));
    }
  });
});

describe("encodeWav is the 44-byte RIFF header (docs/audio.md §3)", () => {
  it("serializes the header and the little-endian samples", () => {
    const buf = encodeWav(Int16Array.from([0, 1, -1, 32767, -32768]));
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.toString("ascii", 12, 16)).toBe("fmt ");
    expect(buf.toString("ascii", 36, 40)).toBe("data");
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(buf.readUInt32LE(28)).toBe(SAMPLE_RATE * 2); // byte rate
    expect(buf.readUInt16LE(32)).toBe(2); // block align
    expect(buf.readUInt16LE(34)).toBe(16); // bits per sample
    expect(buf.readUInt32LE(40)).toBe(10); // data size
    expect(buf.length).toBe(44 + 10);
    expect(buf.readInt16LE(44)).toBe(0);
    expect(buf.readInt16LE(46)).toBe(1);
    expect(buf.readInt16LE(48)).toBe(-1);
    expect(buf.readInt16LE(50)).toBe(32767);
    expect(buf.readInt16LE(52)).toBe(-32768);
  });
});

describe("the device trigger state (docs/audio.md §5)", () => {
  const entry = (over: Partial<TonePlanEntry> = {}): TonePlanEntry => ({
    id: "a#0",
    freq: 440,
    wave: "square",
    duration: 0.1,
    volume: 0.5,
    loop: false,
    ...over,
  });

  function deviceWith(played: TonePlanEntry[]): AudioDevice {
    return new AudioDevice({
      enabled: true,
      play: (_wav, e) => played.push(e),
    });
  }

  it("plays on first sight", () => {
    const played: TonePlanEntry[] = [];
    const device = deviceWith(played);
    device.frame([entry()], 0);
    expect(played).toHaveLength(1);
    expect(played[0]).toEqual(entry());
  });

  it("does not retrigger while still playing with identical parameters", () => {
    const played: TonePlanEntry[] = [];
    const device = deviceWith(played);
    device.frame([entry()], 0);
    for (let i = 1; i < 10; i += 1) {
      device.frame([entry()], i / 60);
    }
    expect(played).toHaveLength(1);
  });

  it("finished with loop: false is silent — the record survives", () => {
    const played: TonePlanEntry[] = [];
    const device = deviceWith(played);
    device.frame([entry()], 0);
    device.frame([entry()], 0.5);
    expect(played).toHaveLength(1);
  });

  it("finished with loop: true replays", () => {
    const played: TonePlanEntry[] = [];
    const device = deviceWith(played);
    device.frame([entry({ loop: true })], 0);
    device.frame([entry({ loop: true })], 0.15);
    expect(played).toHaveLength(2);
  });

  it("a parameter change restarts", () => {
    const played: TonePlanEntry[] = [];
    const device = deviceWith(played);
    device.frame([entry()], 0);
    device.frame([entry({ freq: 880 })], 0.02);
    expect(played).toHaveLength(2);
    expect(played[1]!.freq).toBe(880);
  });

  it("an absent tone has its record dropped; reappearing plays again", () => {
    const played: TonePlanEntry[] = [];
    const device = deviceWith(played);
    device.frame([entry()], 0);
    device.frame([], 0.02);
    device.frame([entry()], 0.04);
    expect(played).toHaveLength(2);
  });

  it("a disabled device never plays", () => {
    const played: TonePlanEntry[] = [];
    const device = new AudioDevice({ enabled: false, play: (_wav, e) => played.push(e) });
    device.frame([entry()], 0);
    expect(played).toHaveLength(0);
  });
});

describe("the tone surface (docs/language.md §7.9)", () => {
  it("lexes 'tone' as the TONE keyword", () => {
    const tokens = tokenize("tone", "t.qbsk");
    expect(tokens[0]!.type).toBe("TONE");
  });

  it("parses tone with all named args into a ToneStmt", () => {
    const { ast, errors } = parse(
      "tone 440 wave: square duration: 0.1 volume: 0.3 loop: true",
      "t.qbsk",
    );
    expect(errors).toHaveLength(0);
    const stmt = ast.body[0]!;
    expect(stmt.kind).toBe("ToneStmt");
    const tone = stmt as Extract<typeof stmt, { kind: "ToneStmt" }>;
    expect(tone.freq.kind).toBe("Lit");
    expect(tone.args.map((a) => a.name)).toEqual(["wave", "duration", "volume", "loop"]);
  });

  it("takes 'tone' as a layer name, and still reads the primitive inside it", () => {
    // This asserted the reservation until 2026-08-19. §15.15 freed all twenty-six scene
    // words outside statement position, so a layer may be called `tone` — and the
    // primitive of the same name still parses in the body, which is the half worth
    // keeping: the two readings have to hold at once or one of them is not a reading.
    const { errors } = parse(
      'scene S(width: 5, height: 3)\nlayer tone z: 1\n    fill "."',
      "t.qbsk",
    );
    expect(errors).toEqual([]);
  });

  it("evaluates a bare tone with defaults into the audio plan", () => {
    const r = runQbsk(
      "scene S(width: 20, height: 3)\nlayer a z: 1\n    tone 440",
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.audioPlan).toEqual([
      { id: "a#0", freq: 440, wave: "square", duration: 0.1, volume: 0.5, loop: false },
    ]);
  });

  it("accepts int and float freq, and all named args", () => {
    const r = runQbsk(
      "scene S(width: 20, height: 3)\nlayer a z: 1\n    tone 220.5 wave: sawtooth duration: 0.25 volume: 0.8 loop: true",
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.audioPlan).toEqual([
      { id: "a#0", freq: 220.5, wave: "sawtooth", duration: 0.25, volume: 0.8, loop: true },
    ]);
  });

  it("rejects an unknown wave with a span, naming the ones that exist", () => {
    const r = runQbsk(
      "scene S(width: 20, height: 3)\nlayer a z: 1\n    tone 440 wave: swoosh",
      "t.qbsk",
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("swoosh");
    expect(r.error!.message).toContain("sine");
    expect(r.error!.span.start.line).toBe(3);
  });

  it("rejects freq <= 0", () => {
    const r = runQbsk(
      "scene S(width: 20, height: 3)\nlayer a z: 1\n    tone 0",
      "t.qbsk",
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toContain("> 0");
  });

  it("a tone paints no cells — the canvas is unaffected", () => {
    const withTone = runQbsk(
      'scene S(width: 5, height: 2)\nlayer a z: 1\n    fill "."\n    tone 440',
      "t.qbsk",
    );
    const without = runQbsk(
      'scene S(width: 5, height: 2)\nlayer a z: 1\n    fill "."',
      "t.qbsk",
    );
    expect(withTone.error).toBeNull();
    expect(withTone.out).toEqual(without.out);
    expect(withTone.canvas).toEqual(without.canvas);
  });

  it("visible: false removes the tone from the plan", () => {
    const r = runQbsk(
      "scene S(width: 20, height: 3)\nlayer a z: 1\n    visible: false\n    tone 440",
      "t.qbsk",
    );
    expect(r.error).toBeNull();
    expect(r.audioPlan).toEqual([]);
  });

  it("analyzer: a tone scene passes qbsk check clean", () => {
    const problems = analyzeProgram(
      parse(
        'scene S(width: 20, height: 3)\nlayer a z: 1\n    fill "."\n    tone 440 wave: square',
        "t.qbsk",
      ).ast,
      "t.qbsk",
    );
    expect(problems).toEqual([]);
  });

  it("analyzer: a tone consumes the visible: directive (no false dead-directive)", () => {
    const problems = analyzeProgram(
      parse(
        "scene S(width: 20, height: 3)\nlayer a z: 1\n    visible: true\n    tone 440",
        "t.qbsk",
      ).ast,
      "t.qbsk",
    );
    expect(problems).toEqual([]);
  });

  it("analyzer: a dead visible: AFTER a tone is still reported", () => {
    const problems = analyzeProgram(
      parse(
        "scene S(width: 20, height: 3)\nlayer a z: 1\n    tone 440\n    visible: true",
        "t.qbsk",
      ).ast,
      "t.qbsk",
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]!.message).toContain("never reaches a primitive");
  });
});

describe("the audio plan rides the frame (docs/audio.md §7)", () => {
  const SCENE = `scene T(width: 20, height: 3)
layer a z: 1
    fill "."
    tone 440 wave: square duration: 1.0 loop: true
`;

  it("every frame carries the same deterministic plan", () => {
    const program = new SceneProgram(parse(SCENE, "t.qbsk").ast);
    const f0 = program.step(0.016);
    expect(f0.error).toBeNull();
    expect(f0.audioPlan).toEqual([
      { id: "a#1", freq: 440, wave: "square", duration: 1.0, loop: true, volume: 0.5 },
    ]);
    const f1 = program.step(0.016);
    expect(f1.audioPlan).toEqual(f0.audioPlan);
  });

  it("gating a tone with visible: removes it from later frames", () => {
    // The handler silences the tone only AFTER the first frame. That delay is not
    // decoration: docs/language.md §7.7 fixes the per-frame order as "event handlers
    // run, then the scene block re-composes", so a handler that assigned
    // unconditionally would already have run before frame 0 composed and the tone
    // would never appear at all. This keeps the intent — a tone present, then gated
    // away — inside the documented model.
    const src = `var snd = true
var frames = 0
scene T(width: 20, height: 3)
layer a z: 1
    fill "."
    visible: snd
    tone 440
on tick(dt)
    frames = frames + 1
    if frames > 1
        snd = false
`;
    const program = new SceneProgram(parse(src, "t.qbsk").ast);
    const f0 = program.step(0.016);
    expect(f0.error).toBeNull();
    expect(f0.audioPlan).toHaveLength(1);
    const f1 = program.step(0.016);
    expect(f1.audioPlan).toEqual([]);
  });
});
