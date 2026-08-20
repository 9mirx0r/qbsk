import { describe, expect, it } from "vitest";
import { QbaError, anchorOffset, loadQba, scaleArt } from "../../src/engine/sprite.js";

const HERO = `# Test figure
META name: hero, width: 3, height: 3
 O
/|\\
/ \\
`;

describe("engine/sprite: loadQba", () => {
  it("parses META, comments and art", () => {
    const s = loadQba(HERO, "hero.qba");
    expect(s.name).toBe("hero");
    expect(s.width).toBe(3);
    expect(s.height).toBe(3);
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]).toEqual([" O ", "/|\\", "/ \\"]);
  });

  it("default name = basename without extension", () => {
    const s = loadQba("META width: 2\nab\ncd\n", "res/my_sprite.qba");
    expect(s.name).toBe("my_sprite");
    expect(s.frames[0]).toEqual(["ab", "cd"]);
  });

  it("META without width: width = longest row; short rows pad with spaces", () => {
    const s = loadQba("ab\nc\n", "x.qba");
    expect(s.width).toBe(2);
    expect(s.frames[0]).toEqual(["ab", "c "]);
  });

  it("row exceeding the declared width → clear QbaError", () => {
    expect(() => loadQba("META width: 2\nabc\n", "x.qba")).toThrowError(
      /row 1.*exceeds the declared width/i,
    );
  });

  it("inner empty lines = space rows; outer empty lines are ignored", () => {
    const s = loadQba("\n\nMETA width: 3\na\n\nb\n", "x.qba");
    expect(s.frames[0]).toEqual(["a  ", "   ", "b  "]);
  });

  it("multi-frame with --- separator", () => {
    const s = loadQba("META width: 2\naa\n---\nbb\n", "x.qba");
    expect(s.frames).toHaveLength(2);
    expect(s.frames[0]).toEqual(["aa"]);
    expect(s.frames[1]).toEqual(["bb"]);
  });

  it("file without art → QbaError", () => {
    expect(() => loadQba("# only comment\n", "x.qba")).toThrowError(/contains no art/i);
    expect(() => loadQba("", "x.qba")).toThrowError(/contains no art/i);
  });

  it("QbaError is an error class", () => {
    expect(new QbaError("x")).toBeInstanceOf(Error);
    expect(new QbaError("x")).toBeInstanceOf(QbaError);
  });
});

describe("engine/sprite: anchorOffset", () => {
  const at = (a: string): [number, number] => anchorOffset(3, 3, a);

  it("9 reference points", () => {
    // The name and the assertions now agree. This test used to be called "9 reference
    // points" while checking 10: `middle-center` was an undocumented alias of `center`
    // that only the lookup table knew about (§15.9).
    expect(at("top-left")).toEqual([0, 0]);
    expect(at("top-center")).toEqual([1, 0]);
    expect(at("top-right")).toEqual([2, 0]);
    expect(at("middle-left")).toEqual([0, 1]);
    expect(at("center")).toEqual([1, 1]);
    expect(at("middle-right")).toEqual([2, 1]);
    expect(at("bottom-left")).toEqual([0, 2]);
    expect(at("bottom-center")).toEqual([1, 2]);
    expect(at("bottom-right")).toEqual([2, 2]);
  });

  it("fractional offset (fx, fy) in 0..1", () => {
    expect(anchorOffset(4, 2, [0, 0])).toEqual([0, 0]);
    expect(anchorOffset(4, 2, [1, 1])).toEqual([3, 1]);
    expect(anchorOffset(4, 2, [0.5, 0.5])).toEqual([2, 1]);
  });

  it("null or unknown name → top-left (no offset)", () => {
    expect(anchorOffset(3, 3, null)).toEqual([0, 0]);
    expect(anchorOffset(3, 3, "weird")).toEqual([0, 0]);
  });
});

describe("engine/sprite: scaleArt", () => {
  it("scale by character repetition", () => {
    expect(scaleArt(["ab", "cd"], 2, 1)).toEqual(["aabb", "ccdd"]);
    expect(scaleArt(["ab"], 1, 3)).toEqual(["ab", "ab", "ab"]);
    expect(scaleArt(["x"], 2, 2)).toEqual(["xx", "xx"]);
  });

  it("factor 1 (or absent) does not change the art", () => {
    expect(scaleArt(["ab"], 1, 1)).toEqual(["ab"]);
  });
});
