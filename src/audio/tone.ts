// Sound synthesis (docs/audio.md §2).
//
// Pure mathematics: no I/O, no dependencies, no clock of its own. The same
// parameters always produce the byte-identical buffer, which is what lets these
// buffers be golden-tested exactly like the ANSI output is. Nothing in this file
// may touch a device — that is device.ts, the single door (§1.2).

import { mulberry32 } from "../util/random.js";

export const SAMPLE_RATE = 44100;

/** Full-scale value of a signed 16-bit sample. */
const PEAK = 32767;

/** Linear attack and release, in seconds. See ENVELOPE below. */
const ENVELOPE_SECONDS = 0.005;

export const WAVE_NAMES = [
  "sine",
  "square",
  "triangle",
  "sawtooth",
  "noise",
] as const;

export type WaveName = (typeof WAVE_NAMES)[number];

export function isWaveName(name: string): name is WaveName {
  return (WAVE_NAMES as readonly string[]).includes(name);
}

export interface ToneSpec {
  freq: number;
  wave: WaveName;
  duration: number;
  volume: number;
}

/**
 * One tone as composed by a frame (docs/audio.md §5). `id` is the tone's identity —
 * layer name plus declaration position — which is what the device keys its trigger
 * state on, so a re-composed scene continues rather than retriggering.
 */
export interface TonePlanEntry {
  id: string;
  freq: number;
  wave: WaveName;
  duration: number;
  volume: number;
  loop: boolean;
}

// Noise MUST be seeded (docs/audio.md §2): `Math.random()` would make the buffers
// non-reproducible and no golden could pin them. The generator itself lives in
// src/util/random.ts because particles need the same one — QBSK has a single seeded
// PRNG, not one per subsystem.

/** The documented fixed seed. Changing it changes every noise golden. */
export const NOISE_SEED = 0x51b5;

/**
 * Generates one tone as 16-bit signed PCM, mono, 44100 Hz.
 *
 * The envelope is not decoration: a buffer that starts and ends mid-waveform has a
 * step discontinuity at each end, which a speaker reproduces as a click. A 5 ms
 * linear ramp in and out removes it, and being pure arithmetic it keeps the buffer
 * deterministic.
 */
export function synthesize(spec: ToneSpec): Int16Array {
  const { freq, wave, duration } = spec;
  if (!(freq > 0)) {
    throw new Error(`tone frequency must be > 0, got ${freq}`);
  }
  if (!(duration > 0)) {
    throw new Error(`tone duration must be > 0, got ${duration}`);
  }
  const volume = Math.min(1, Math.max(0, spec.volume));
  const count = Math.round(SAMPLE_RATE * duration);
  const out = new Int16Array(count);
  const amplitude = PEAK * volume;

  // Ramp length in samples, never more than half the buffer — a tone shorter than
  // two ramps gets a triangular envelope rather than an overlapping one.
  //
  // FLOOR, not round: 5 ms at 44100 Hz is 220.5 samples. Rounding up to 221 puts
  // the end of the attack one sample beyond 220, so the sample at exactly 5 ms is
  // still 220/221 of full scale instead of full scale. Flooring makes "the attack
  // is complete at 5 ms" literally true.
  const ramp = Math.min(
    Math.floor(SAMPLE_RATE * ENVELOPE_SECONDS),
    Math.floor(count / 2),
  );

  const noise = wave === "noise" ? mulberry32(NOISE_SEED) : null;

  for (let i = 0; i < count; i += 1) {
    const t = i / SAMPLE_RATE;
    const theta = 2 * Math.PI * freq * t;
    let value: number;
    switch (wave) {
      case "sine":
        value = Math.sin(theta);
        break;
      case "square":
        value = Math.sin(theta) >= 0 ? 1 : -1;
        break;
      case "triangle":
        value = (2 / Math.PI) * Math.asin(Math.sin(theta));
        break;
      case "sawtooth": {
        const phase = freq * t;
        value = 2 * (phase - Math.floor(phase)) - 1;
        break;
      }
      case "noise":
        value = noise!() * 2 - 1;
        break;
    }

    // Linear attack, then hold, then linear release. Sample 0 and the last sample
    // are exactly 0 — that is what "click-free" means here.
    let gain = 1;
    if (ramp > 0) {
      if (i < ramp) {
        gain = i / ramp;
      } else if (i >= count - ramp) {
        gain = (count - 1 - i) / ramp;
        if (gain < 0) {
          gain = 0;
        }
      }
    }

    // Round the MAGNITUDE and reapply the sign. Math.round breaks ties toward
    // +Infinity, so a plain round turns a square wave's rails into +16384/-16383 at
    // volume 0.5 — an asymmetric waveform with a DC offset. Rounding symmetrically
    // keeps both rails the same distance from zero.
    const raw = value * amplitude * gain;
    const sample = Math.sign(raw) * Math.round(Math.abs(raw));
    out[i] = sample > PEAK ? PEAK : sample < -32768 ? -32768 : sample;
  }
  return out;
}
