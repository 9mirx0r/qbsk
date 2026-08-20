// an earlier release — src/tools/pngDecode.ts, a from-scratch PNG decoder (host-side only; see
// that file's own header for why). Tested against PNGs built here from raw bytes using
// only Node's built-in zlib — never against a file from a PNG-writing library, so a
// passing test proves the decoder itself is correct, not that it round-trips its own
// mistakes.
import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { decodePng } from "../../src/tools/pngDecode.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  // decodePng never checks the CRC (it only uses chunk boundaries), so a placeholder
  // is enough here — this test is exercising the decoder, not a CRC implementation.
  const crc = Buffer.alloc(4);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, crc]);
}

function ihdr(width: number, height: number, colorType: number, bitDepth = 8): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.writeUInt8(bitDepth, 8);
  data.writeUInt8(colorType, 9);
  data.writeUInt8(0, 10); // compression method
  data.writeUInt8(0, 11); // filter method
  data.writeUInt8(0, 12); // interlace method (0 = none)
  return chunk("IHDR", data);
}

// Builds a minimal, valid (to this decoder) PNG: every scanline uses filter type 0
// (None), so `rows` can be handed in as already-final pixel bytes with no filtering
// math to reverse — keeping the expected values in each test trivial to state by hand.
function buildPng(width: number, height: number, colorType: number, rows: number[][]): Buffer {
  const bytesPerRow = rows[0]!.length;
  const raw = Buffer.alloc(height * (1 + bytesPerRow));
  for (let y = 0; y < height; y += 1) {
    const base = y * (1 + bytesPerRow);
    raw[base] = 0; // filter type: None
    for (let x = 0; x < bytesPerRow; x += 1) {
      raw[base + 1 + x] = rows[y]![x]!;
    }
  }
  const idat = chunk("IDAT", deflateSync(raw));
  return Buffer.concat([SIGNATURE, ihdr(width, height, colorType), idat, chunk("IEND", Buffer.alloc(0))]);
}

describe("an earlier release: decodePng", () => {
  it("rejects a buffer that isn't a PNG at all", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/bad signature/);
  });

  it("decodes a 2x2 RGB (color type 2) image with filter type None", () => {
    // Row 0: red, green. Row 1: blue, white.
    const rows = [
      [255, 0, 0, 0, 255, 0],
      [0, 0, 255, 255, 255, 255],
    ];
    const png = buildPng(2, 2, 2, rows);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(decoded.channels).toBe(3);
    expect([...decoded.pixels]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  });

  it("decodes an RGBA (color type 6) image, alpha included", () => {
    const rows = [[10, 20, 30, 128, 40, 50, 60, 255]];
    const png = buildPng(2, 1, 6, rows);
    const decoded = decodePng(png);
    expect(decoded.channels).toBe(4);
    expect([...decoded.pixels]).toEqual([10, 20, 30, 128, 40, 50, 60, 255]);
  });

  it("decodes a grayscale (color type 0) image, expanded to RGB", () => {
    const rows = [[0, 128, 255]];
    const png = buildPng(3, 1, 0, rows);
    const decoded = decodePng(png);
    expect(decoded.channels).toBe(3);
    // Each gray value repeated across R, G, B.
    expect([...decoded.pixels]).toEqual([0, 0, 0, 128, 128, 128, 255, 255, 255]);
  });

  it("decodes an indexed (color type 3, PLTE) image, expanded to RGB", () => {
    const width = 2;
    const height = 1;
    const palette = Buffer.from([255, 0, 0, /* index 0: red */ 0, 255, 0 /* index 1: green */]);
    const raw = Buffer.alloc(height * (1 + width));
    raw[0] = 0; // filter: None
    raw[1] = 0; // pixel 0 -> palette index 0 (red)
    raw[2] = 1; // pixel 1 -> palette index 1 (green)
    const idat = chunk("IDAT", deflateSync(raw));
    const png = Buffer.concat([
      SIGNATURE,
      ihdr(width, height, 3),
      chunk("PLTE", palette),
      idat,
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const decoded = decodePng(png);
    expect(decoded.channels).toBe(3);
    expect([...decoded.pixels]).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it("correctly reverses filter type 1 (Sub) — each byte relative to its left neighbor", () => {
    // True row bytes: [10, 20, 30]. Sub-filtered: byte0 as-is (no left neighbor, so
    // "left" reads as 0), byte1 = 20-10=10, byte2 = 30-20=10.
    const raw = Buffer.from([1, 10, 10, 10]); // filter type 1, then the filtered bytes
    const idat = chunk("IDAT", deflateSync(raw));
    const png = Buffer.concat([SIGNATURE, ihdr(3, 1, 0), idat, chunk("IEND", Buffer.alloc(0))]);
    const decoded = decodePng(png);
    expect([...decoded.pixels]).toEqual([10, 10, 10, 20, 20, 20, 30, 30, 30]);
  });

  it("rejects 16-bit depth and interlaced PNGs with a clear error, not a wrong decode", () => {
    const png16 = Buffer.concat([SIGNATURE, ihdr(1, 1, 2, 16)]);
    expect(() => decodePng(png16)).toThrow(/8-bit/);

    const data = Buffer.alloc(13);
    data.writeUInt32BE(1, 0);
    data.writeUInt32BE(1, 4);
    data.writeUInt8(8, 8);
    data.writeUInt8(2, 9);
    data.writeUInt8(0, 10);
    data.writeUInt8(0, 11);
    data.writeUInt8(1, 12); // interlace = Adam7
    const interlaced = Buffer.concat([SIGNATURE, chunk("IHDR", data)]);
    expect(() => decodePng(interlaced)).toThrow(/interlaced/);
  });
});
