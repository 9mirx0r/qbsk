// A from-scratch PNG decoder, host-side only. Written for the sprite-sheet slicing tool:
// a reference sheet needs cutting into individual sprites before QBSK's own generator can
// be compared against it.
//
// WHY HOST-SIDE, NOT QBSK: the same reasoning an earlier release used for a seeded PRNG. A PNG's
// pixel data is DEFLATE-compressed — a bit-level format (variable-length Huffman codes
// read bit by bit) — and QBSK has no bitwise operators (checked, same as every other
// time this project has made that claim: the lexer has no XOR/shift tokens). DEFLATE
// decompression is not creative content this project controls, unlike a sprite's shape
// or a name's phonemes — it's a fixed external file format, so reusing Node's built-in
// `zlib` (shipped with the runtime, not a new npm dependency, not someone else's art)
// is the same category of choice as using `node:fs` for file I/O. Everything AFTER
// decompression — reading chunks, un-filtering scanlines, expanding color types — is
// this project's own code, not copied from any PNG library.
//
// What IS QBSK's own, and lives in examples/lib/spritesheet.qbsk instead: cropping a
// decoded sheet into individual cells. That's pure index arithmetic, no bitwise
// operators needed, genuinely expressible — so it isn't here.
import { inflateSync } from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  /** 3 = RGB, 4 = RGBA. Grayscale and indexed inputs are expanded to one of these. */
  channels: 3 | 4;
  /** width*height*channels bytes, row-major, top-to-bottom. */
  pixels: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG filter type 4 (Paeth predictor) — picks whichever of the three neighbors (left,
// above, above-left) is the closest match to a simple linear gradient of the other two.
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes a PNG buffer into flat RGB/RGBA pixel bytes. Supports what real-world
 * AI-generated sprite sheets actually use: 8-bit depth, non-interlaced, grayscale /
 * RGB / indexed (PLTE) / grayscale+alpha / RGBA. 16-bit depth and Adam7 interlacing
 * are explicitly NOT supported — they're rare for this kind of asset and a clear error
 * beats a silently wrong decode.
 */
export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("not a PNG file (bad signature)");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Buffer | null = null;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      const interlace = data.readUInt8(12);
      if (interlace !== 0) {
        throw new Error("interlaced PNGs are not supported (Adam7)");
      }
      if (bitDepth !== 8) {
        throw new Error(`only 8-bit PNGs are supported, got bit depth ${bitDepth}`);
      }
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "IDAT") {
      idatChunks.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 8 + length + 4; // length field + type + data + CRC
  }
  if (width === 0 || height === 0) {
    throw new Error("missing or empty IHDR chunk");
  }
  const sourceChannels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = sourceChannels[colorType];
  if (channels === undefined) {
    throw new Error(`unsupported PNG color type ${colorType}`);
  }
  if (colorType === 3 && palette === null) {
    throw new Error("indexed-color PNG is missing its PLTE chunk");
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const unfiltered = Buffer.alloc(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[rawOffset]!;
    rawOffset += 1;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[rawOffset + x]!;
      const a = x >= channels ? unfiltered[rowStart + x - channels]! : 0;
      const b = y > 0 ? unfiltered[prevRowStart + x]! : 0;
      const c = y > 0 && x >= channels ? unfiltered[prevRowStart + x - channels]! : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = (rawByte + a) & 0xff;
          break;
        case 2:
          value = (rawByte + b) & 0xff;
          break;
        case 3:
          value = (rawByte + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4:
          value = (rawByte + paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filterType} at row ${y}`);
      }
      unfiltered[rowStart + x] = value;
    }
    rawOffset += stride;
  }

  // Expand grayscale / indexed sources to plain RGB(A) so every caller sees one shape.
  if (colorType === 3 && palette) {
    const rgb = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i += 1) {
      const idx = unfiltered[i]!;
      rgb[i * 3] = palette[idx * 3] ?? 0;
      rgb[i * 3 + 1] = palette[idx * 3 + 1] ?? 0;
      rgb[i * 3 + 2] = palette[idx * 3 + 2] ?? 0;
    }
    return { width, height, channels: 3, pixels: rgb };
  }
  if (colorType === 0 || colorType === 4) {
    const outChannels = colorType === 4 ? 4 : 3;
    const rgb = Buffer.alloc(width * height * outChannels);
    for (let i = 0; i < width * height; i += 1) {
      const g = unfiltered[i * channels]!;
      rgb[i * outChannels] = g;
      rgb[i * outChannels + 1] = g;
      rgb[i * outChannels + 2] = g;
      if (colorType === 4) rgb[i * outChannels + 3] = unfiltered[i * channels + 1]!;
    }
    return { width, height, channels: outChannels as 3 | 4, pixels: rgb };
  }
  return { width, height, channels: channels as 3 | 4, pixels: unfiltered };
}
