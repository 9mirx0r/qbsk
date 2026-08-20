// int and float: the whole story (docs/language.md §5.0).
//
// RULE #4 said the two are "always distinguished" and nothing else, which is not the
// same as knowing what you will get. Every case below was found by RUNNING the language
// during a review, not by reading it — which means an author would have found each one
// the same way, one surprise at a time.
//
// These tests exist so the answers stay answers. A change that makes `4 / 2` return an
// int would be defensible; making it return an int SILENTLY, and leaving §5.0 claiming
// otherwise, is the drift this file prevents.

import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const out = (source: string): string[] => {
  const r = runQbsk(source, "l12.qbsk");
  expect(r.error).toBeNull();
  return r.out;
};

const failure = (source: string): string => {
  const r = runQbsk(source, "l12.qbsk");
  expect(r.error).not.toBeNull();
  return r.error!.message;
};

describe("arithmetic preserves int, except division (§5.0)", () => {
  it("int op int stays int", () => {
    expect(out('print(type(2 + 3))\nprint(type(2 * 3))\nprint(type(5 % 2))\nprint(type(5 - 2))')).toEqual(
      ["int", "int", "int", "int"],
    );
  });

  it("one float makes the result float", () => {
    expect(out("print(type(2 + 3.0))")).toEqual(["float"]);
  });

  it("division ALWAYS returns float, even when it divides evenly", () => {
    // The property that matters: the type does not depend on the values. `a / b` being
    // int on Tuesday and float on Wednesday would make the coordinate DSL accept a
    // program only for some inputs.
    expect(out("print(str(4 / 2))\nprint(type(4 / 2))")).toEqual(["2.0", "float"]);
    expect(out("print(str(5 / 2))\nprint(type(5 / 2))")).toEqual(["2.5", "float"]);
  });

  it("an integer result is an explicit conversion", () => {
    expect(out("print(str(int(7 / 2)))")).toEqual(["3"]);
  });
});

describe("int() truncates toward zero (§5.0)", () => {
  it("positive and negative both truncate, they do not round", () => {
    expect(out("print(str(int(3.9)))\nprint(str(int(-3.9)))")).toEqual(["3", "-3"]);
  });

  it("round() is the one that rounds", () => {
    expect(out("print(str(round(3.9)))\nprint(str(round(-3.9)))")).toEqual(["4", "-4"]);
  });
});

describe("where an int is required, a float is refused (§5.0)", () => {
  it("a native that needs an int says so instead of truncating", () => {
    expect(failure("var c = canvas(4.0, 2)")).toMatch(/expects an int, got 'float'/);
  });

  it("a grid address needs ints — half a cell is not a place", () => {
    expect(
      failure(
        ['scene S(width: 8, height: 3)', "layer a z: 1", '    put "x" at (1.5, 0)'].join(
          "\n",
        ),
      ),
    ).toMatch(/tuple \(x, y\) with ints/);
  });
});

describe("the two documented exceptions (§5.0)", () => {
  it("a float for-range rounds INWARD and yields ints", () => {
    // Inward: every value the loop yields is inside the range as written.
    expect(
      out("for i in 0.5..3.5\n    print(str(i) + \" \" + type(i))"),
    ).toEqual(["1 int", "2 int"]);
  });

  it("integers past 2^53 lose precision, as documented", () => {
    // Not a bug to fix — a host limit to know about. The test pins that the answer is
    // the IEEE-754 one, so a future bigint would have to change this deliberately.
    expect(out("print(str(9007199254740993))")).toEqual(["9007199254740992"]);
  });

  it("but ordinary integers are exact well past 32 bits", () => {
    expect(out("print(str(2147483647 + 1))")).toEqual(["2147483648"]);
  });
});

describe("equality across int and float (§5.0)", () => {
  it("2 == 2.0 — comparison is by numeric value", () => {
    expect(out("print(str(2 == 2.0))")).toEqual(["true"]);
  });

  it("float equality is IEEE-754 equality, with no apology", () => {
    expect(out("print(str(0.1 + 0.2 == 0.3))")).toEqual(["false"]);
  });
});
