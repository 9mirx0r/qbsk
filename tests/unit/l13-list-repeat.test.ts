// List repetition, and the two asymmetries that turned out not to be (docs/language.md
// §6.7).
//
// The brainstorm called these three "asymmetries the language should close". Checking
// them first turned two into something else:
//
//   `[1,2] * 3` failing   -> NOT an asymmetry, an unkept promise: §6 already listed
//                            "repetition `*` (str/list)". The spec was right and the
//                            interpreter had never caught up.
//   a bare `}` being legal -> NOT a defect: §2.4 documents it deliberately, with the
//                            balancing rule spelled out. Nothing to fix.
//   `gameTime` camelCase   -> left alone on purpose (141 uses), documented instead.

import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const out = (source: string): string[] => {
  const r = runQbsk(source, "l13.qbsk");
  expect(r.error).toBeNull();
  return r.out;
};

const failure = (source: string): string => {
  const r = runQbsk(source, "l13.qbsk");
  expect(r.error).not.toBeNull();
  return r.error!.message;
};

describe("a list repeats like a string does (§6.7)", () => {
  it("list * int", () => {
    expect(out("print(str([1, 2] * 3))")).toEqual(["[1, 2, 1, 2, 1, 2]"]);
  });

  it("int * list — the same operator, either way round", () => {
    expect(out("print(str(3 * [1, 2]))")).toEqual(["[1, 2, 1, 2, 1, 2]"]);
  });

  it("repeating by 0 gives the empty list, not an error", () => {
    expect(out("print(str([1, 2] * 0))")).toEqual(["[]"]);
  });

  it("repeating an empty list is empty", () => {
    expect(out("print(str([] * 5))")).toEqual(["[]"]);
  });

  it("the copy is independent — mutating one element does not touch the others", () => {
    // The elements are shared by value the way QBSK values are; the LIST is new.
    const r = out(
      ["var base = [1, 2]", "var wide = base * 2", "wide[0] = 99", "print(str(base))", "print(str(wide))"].join(
        "\n",
      ),
    );
    expect(r).toEqual(["[1, 2]", "[99, 2, 1, 2]"]);
  });

  it("a negative count is refused, like a string's", () => {
    expect(failure("print(str([1, 2] * -1))")).toMatch(/int >= 0/);
  });

  it("a float count is refused, like a string's", () => {
    expect(failure("print(str([1, 2] * 2.0))")).toMatch(/must be an int/);
  });

  it("a run away repetition reports instead of exhausting memory", () => {
    expect(failure("print(str([1, 2] * 999999999))")).toMatch(/over the limit/);
  });

  it("string repetition is unchanged", () => {
    expect(out('print("ab" * 3)\nprint(3 * "ab")')).toEqual(["ababab", "ababab"]);
  });
});

describe("what was NOT broken (§6.7)", () => {
  it("a bare close brace in a string is literal, as §2.4 documents", () => {
    expect(out('print("a bare close brace: }")')).toEqual(["a bare close brace: }"]);
  });

  it("the {{ }} escape is symmetric", () => {
    expect(out('print("escaped: {{ and }}")')).toEqual(["escaped: { and }"]);
  });
});
