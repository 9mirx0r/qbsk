// A loop can be named, and broken from the inside out (docs/language.md §15.22).
//
// `break` left the innermost loop and no further, so leaving two took a flag and a second
// `break`. The flag is the part that costs: it is live after the loop, and it says nothing
// about which loop it was for.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";
import { readFileSync } from "node:fs";
import { formatQbskError } from "../../src/interp/error.js";

const NL = "\n";

function out(...lines: string[]): string[] {
  const printed: string[] = [];
  const source = lines.join(NL);
  const r = runQbsk(source, "t.qbsk", { print: (s: string) => printed.push(s) });
  if (r.error !== null) {
    throw new Error(formatQbskError(source, r.error));
  }
  return printed;
}

function fails(...lines: string[]): string {
  const source = lines.join(NL);
  const r = runQbsk(source, "t.qbsk", { print: () => {} });
  expect(r.error, "the program was supposed to fail").not.toBeNull();
  return formatQbskError(source, r.error!);
}

describe("break leaves the loop it names", () => {
  it("leaves two loops at once in a for-in-list", () => {
    expect(
      out(
        "var grid = [[1, 2], [3, 4], [5, 6]]",
        "for row in grid as scan",
        "    for cell in row",
        "        print(str(cell))",
        "        if cell == 3",
        "            break scan",
        "print(\"done\")",
      ),
    ).toEqual(["1", "2", "3", "done"]);
  });

  it("leaves two loops at once in a range loop", () => {
    expect(
      out(
        "for i in 0..3 as outer",
        "    for j in 0..3",
        "        print(str(i) + str(j))",
        "        if j == 1 and i == 1",
        "            break outer",
        "print(\"done\")",
      ),
    ).toEqual(["00", "01", "02", "10", "11", "done"]);
  });

  it("leaves two loops at once in a while loop", () => {
    expect(
      out(
        "var i = 0",
        "while i < 5 as outer",
        "    var j = 0",
        "    while j < 5",
        "        print(str(i) + str(j))",
        "        if i + j == 2",
        "            break outer",
        "        j += 1",
        "    i += 1",
        "print(\"done\")",
      ),
    ).toEqual(["00", "01", "02", "done"]);
  });

  it("leaves three loops at once", () => {
    expect(
      out(
        "for a in 0..2 as top",
        "    for b in 0..2",
        "        for c in 0..2",
        "            print(str(a) + str(b) + str(c))",
        "            break top",
        "print(\"done\")",
      ),
    ).toEqual(["000", "done"]);
  });

  it("names the loop it is standing in", () => {
    // Naming the innermost loop is the same as an unlabelled break, and must stay so.
    expect(
      out(
        "for i in 0..3 as only",
        "    print(str(i))",
        "    if i == 1",
        "        break only",
        "print(\"done\")",
      ),
    ).toEqual(["0", "1", "done"]);
  });
});

describe("continue takes a name on the same terms", () => {
  it("starts the next iteration of the named loop", () => {
    expect(
      out(
        "for i in 0..3 as outer",
        "    for j in 0..3",
        "        if j == 1",
        "            continue outer",
        "        print(str(i) + str(j))",
        "print(\"done\")",
      ),
    ).toEqual(["00", "10", "20", "done"]);
  });
});

describe("an unlabelled break is unchanged", () => {
  it("still leaves only the innermost loop", () => {
    expect(
      out(
        "for i in 0..2 as outer",
        "    for j in 0..3",
        "        if j == 1",
        "            break",
        "        print(str(i) + str(j))",
        "print(\"done\")",
      ),
    ).toEqual(["00", "10", "done"]);
  });

  it("still reports outside a loop", () => {
    expect(fails("break")).toContain("'break' outside a loop");
  });
});

describe("the mistakes are reported, not guessed at", () => {
  it("reports a name no enclosing loop carries", () => {
    const e = fails(
      "for i in 0..3 as scan",
      "    for j in 0..3",
      "        break scna",
    );
    expect(e).toContain("no enclosing loop is named 'scna'");
  });

  it("refuses to let a labelled break leave a function", () => {
    // Allowed, it would land in whatever loop the CALLER was running -- a program that
    // does something different depending on who called it.
    const e = fails(
      "func find(n)",
      "    for i in 0..3",
      "        break outer",
      "    return n",
      "for k in 0..2 as outer",
      "    print(str(find(k)))",
    );
    expect(e).toContain("cannot leave the function 'find'");
  });

  it("refuses to let a labelled continue leave a function", () => {
    const e = fails(
      "func find(n)",
      "    for i in 0..3",
      "        continue outer",
      "    return n",
      "for k in 0..2 as outer",
      "    print(str(find(k)))",
    );
    expect(e).toContain("cannot leave the function 'find'");
  });

  it("does not read a name from the next line", () => {
    // There is no end-of-line token, so `break` followed by a name one line down looks
    // exactly like `break name` unless the label is anchored to the physical line.
    expect(
      out(
        "var stop = 0",
        "for i in 0..3 as outer",
        "    break",
        "stop = 1",
        "print(str(stop))",
      ),
    ).toEqual(["1"]);
  });
});

describe("a loop name is an ordinary name (§15.15)", () => {
  it("accepts a scene word as a loop name", () => {
    expect(
      out(
        "for i in 0..2 as line",
        "    print(str(i))",
        "    break line",
      ),
    ).toEqual(["0"]);
  });

  it("does not reserve the name outside the loop", () => {
    expect(
      out("for i in 0..2 as scan", "    break scan", "var scan = 7", "print(str(scan))"),
    ).toEqual(["7"]);
  });
});

describe("the example runs and shows the feature (RULE #5)", () => {
  it("examples/named_loops.qbsk prints what it claims", () => {
    const source = readFileSync(
      new URL("../../examples/named_loops.qbsk", import.meta.url),
      "utf8",
    );
    const printed: string[] = [];
    const r = runQbsk(source, "named_loops.qbsk", {
      print: (s: string) => printed.push(s),
    });
    expect(r.error === null ? "" : formatQbskError(source, r.error)).toBe("");
    expect(printed).toEqual([
      "found at 1,1",
      // Only row 1 has no wall, so `continue check` really did skip the other two.
      "rows with no wall: [1]",
      // The unlabelled break still leaves one loop: 2 per row, 3 rows.
      "counted 6",
      "reached 000",
    ]);
  });
});
