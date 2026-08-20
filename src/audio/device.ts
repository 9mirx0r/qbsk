// The single door to the audio hardware (docs/audio.md §3).
//
// This is the ONLY module in the engine that writes a file or spawns a process for
// sound — the same discipline the engine applies to the screen, where only
// render.ts emits bytes. Everything above it (tone.ts) is pure mathematics.
//
// Backend: OS delegation. Synthesize, write a temp WAV, hand it to the platform's
// own player. That keeps the npm dependency count at zero and confines the entire
// hardware hand-off to this one replaceable file (review §7).

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_RATE, synthesize, type TonePlanEntry } from "./tone.js";

const HEADER_BYTES = 44;

/**
 * Serializes samples as a canonical 44-byte-header RIFF/WAVE file: PCM, mono,
 * 16-bit, little-endian.
 *
 * This lives beside the device rather than in tone.ts because a WAV container is
 * part of handing sound to the operating system, not part of generating it.
 */
export function encodeWav(
  samples: Int16Array,
  sampleRate: number = SAMPLE_RATE,
): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(HEADER_BYTES + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate: rate * channels * bytes
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buf.writeInt16LE(samples[i]!, HEADER_BYTES + i * 2);
  }
  return buf;
}

/** What the device remembers about a tone it has already started (§5). */
interface TriggerRecord {
  start: number;
  freq: number;
  wave: string;
  duration: number;
  volume: number;
  loop: boolean;
}

export interface AudioDeviceOptions {
  enabled: boolean;
  /** Injectable for tests: receives the encoded WAV and the entry that produced it. */
  play?: (wav: Buffer, entry: TonePlanEntry) => void;
}

function paramsMatch(rec: TriggerRecord, e: TonePlanEntry): boolean {
  return (
    rec.freq === e.freq &&
    rec.wave === e.wave &&
    rec.duration === e.duration &&
    rec.volume === e.volume &&
    rec.loop === e.loop
  );
}

export class AudioDevice {
  private readonly enabled: boolean;
  private readonly playFn: (wav: Buffer, entry: TonePlanEntry) => void;
  private readonly records = new Map<string, TriggerRecord>();
  private warned = false;
  private tempDir: string | null = null;

  constructor(opts: AudioDeviceOptions) {
    this.enabled = opts.enabled;
    this.playFn = opts.play ?? ((wav) => this.spawnPlayer(wav));
  }

  /**
   * Feeds one frame's composed tones. The trigger rule mirrors the tweens'
   * continue/restart rule (docs/engine.md §11.2), which is why a `tone` declared
   * unconditionally plays once at scene start instead of sixty times a second:
   * re-composition with identical parameters CONTINUES, it does not retrigger.
   */
  frame(plan: TonePlanEntry[], gameTime: number): void {
    if (!this.enabled) {
      return;
    }
    const seen = new Set<string>();
    for (const entry of plan) {
      seen.add(entry.id);
      const rec = this.records.get(entry.id);
      if (rec === undefined || !paramsMatch(rec, entry)) {
        this.trigger(entry, gameTime);
        continue;
      }
      const finished = gameTime >= rec.start + rec.duration;
      if (finished && entry.loop) {
        this.trigger(entry, gameTime);
      }
      // Finished without loop: stay silent, but KEEP the record — dropping it here
      // would make the next frame look like first sight and retrigger forever.
    }
    // A tone absent from this frame forgets its record, so gating one with
    // `visible:` makes it play exactly when it becomes visible again (§5).
    for (const id of [...this.records.keys()]) {
      if (!seen.has(id)) {
        this.records.delete(id);
      }
    }
  }

  private trigger(entry: TonePlanEntry, gameTime: number): void {
    this.records.set(entry.id, {
      start: gameTime,
      freq: entry.freq,
      wave: entry.wave,
      duration: entry.duration,
      volume: entry.volume,
      loop: entry.loop,
    });
    let wav: Buffer;
    try {
      wav = encodeWav(
        synthesize({
          freq: entry.freq,
          wave: entry.wave,
          duration: entry.duration,
          volume: entry.volume,
        }),
      );
    } catch {
      // Synthesis rejected the parameters. The interpreter validates before we get
      // here, so this is belt and braces: silence, never a throw into QBSK (§3).
      this.warnOnce("could not synthesize a tone");
      return;
    }
    this.playFn(wav, entry);
  }

  /**
   * Hands the WAV to the platform player. Always `spawn`, never `execSync`: the
   * frame loop must not block on audio (§3).
   */
  private spawnPlayer(wav: Buffer): void {
    try {
      if (this.tempDir === null) {
        this.tempDir = mkdtempSync(join(tmpdir(), "qbsk-audio-"));
      }
      const file = join(this.tempDir, `t${Date.now()}-${this.records.size}.wav`);
      writeFileSync(file, wav);
      const [cmd, args] = playerCommand(file);
      const child = spawn(cmd, args, { stdio: "ignore", detached: false });
      child.on("error", () => this.warnOnce(`no audio player available (${cmd})`));
    } catch {
      this.warnOnce("audio playback failed");
    }
  }

  /**
   * Warned once, on stderr, never thrown. A machine with no sound player must run
   * the program exactly as one with sound, minus the sound — and must not repeat
   * the complaint sixty times a second.
   */
  private warnOnce(message: string): void {
    if (this.warned) {
      return;
    }
    this.warned = true;
    process.stderr.write(`qbsk: ${message}; continuing without audio\n`);
  }
}

function playerCommand(file: string): [string, string[]] {
  if (process.platform === "win32") {
    return [
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(New-Object Media.SoundPlayer '${file}').PlaySync()`,
      ],
    ];
  }
  if (process.platform === "darwin") {
    return ["afplay", [file]];
  }
  return ["aplay", ["-q", file]];
}
