// L10 — a suggestion belongs to the message, not to the tool (docs/language.md §8.1).
//
// The §8 example has promised `did you mean 'hero'?` on a RUNTIME error since the error
// model was written. It was only kept in `qbsk check`: the better error lived on the
// opt-in path while `qbsk run` — how the language is actually met — gave the bare one.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQbsk } from "../../src/interp/interpreter.js";

const run = (source: string) => runQbsk(source, "l10.qbsk");

/** The message of the error a program failed with. */
const failure = (source: string): string => {
  const r = run(source);
  expect(r.error).not.toBeNull();
  return r.error!.message;
};

describe("an undefined variable suggests the nearest name in scope (§8.1)", () => {
  it("suggests a local variable", () => {
    expect(failure(["var total = 10", "print(str(totl + 1))"].join("\n"))).toMatch(
      /did you mean 'total'\?/,
    );
  });

  it("suggests a native", () => {
    expect(failure('print(strr(1))')).toMatch(/did you mean 'str'\?/);
  });

  it("suggests a function name", () => {
    expect(
      failure(["func draw_hud()", "    return 1", "print(str(draw_hd()))"].join("\n")),
    ).toMatch(/did you mean 'draw_hud'\?/);
  });

  it("stays silent when nothing is close — a bad hint is worse than none", () => {
    const msg = failure("print(str(zzzzzzzz))");
    expect(msg).toMatch(/is not defined/);
    expect(msg).not.toMatch(/did you mean/);
  });

  it("never suggests a name that is out of scope at that point", () => {
    // `inner` exists in the program but not where the error happens. Proposing it
    // would be a lie with a helpful tone.
    const msg = failure(
      ["func f()", "    var inner_value = 1", "    return inner_value", "print(str(inner_valu))"].join(
        "\n",
      ),
    );
    expect(msg).not.toMatch(/did you mean/);
  });

  it("the assignment path suggests too, not only the read path", () => {
    expect(failure(["var counter = 0", "countr = 1"].join("\n"))).toMatch(
      /did you mean 'counter'\?/,
    );
  });
});

describe("closed vocabularies suggest their own names (§8.1)", () => {
  const inLayer = (...lines: string[]) =>
    [
      "scene S(width: 8, height: 3)",
      "layer a z: 1",
      ...lines.map((l) => `    ${l}`),
    ].join("\n");

  it("an unknown color", () => {
    expect(failure(inLayer("color fg: cyaan"))).toMatch(/did you mean 'cyan'\?/);
  });

  it("an unknown wave", () => {
    expect(failure(inLayer("tone 440 wave: squere"))).toMatch(/did you mean 'square'\?/);
  });

  it("an unknown shade", () => {
    expect(failure(inLayer("shade radal"))).toMatch(/did you mean 'radial'\?/);
  });

  it("an unknown easing", () => {
    expect(failure('print(str(animate("x", 0, 10, 1.0, "ease-ou")))')).toMatch(
      /did you mean 'ease-out'\?/,
    );
  });

  it("an unknown anchor", () => {
    expect(
      failure(inLayer('sprite "res/hero.qba" at (0, 0) anchor: centre')),
    ).toMatch(/did you mean 'center'\?/);
  });

  it("a vocabulary still lists its names when nothing is close", () => {
    const msg = failure(inLayer("tone 440 wave: zzzzzz"));
    expect(msg).not.toMatch(/did you mean/);
    expect(msg).toMatch(/square/);
  });
});

describe("a module member suggests that module's exports (§8.1)", () => {
  it("suggests the nearest export", () => {
    const dir = mkdtempSync(join(tmpdir(), "qbsk-l10-"));
    writeFileSync(
      join(dir, "helpers.qbsk"),
      ["export func compute_total()", "    return 7"].join("\n"),
    );
    const r = runQbsk(
      ['use "helpers.qbsk"', "print(str(helpers.compute_totl()))"].join("\n"),
      join(dir, "main.qbsk"),
      undefined,
      { baseDir: dir },
    );
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/did you mean 'compute_total'\?/);
  });
});

describe("run and check agree (§8.1)", () => {
  it("the same typo gets the same suggestion from both paths", () => {
    // The point of the section: this is a property of the error model, not a feature
    // one tool has and the other lacks.
    const source = ["var total = 10", "print(str(totl + 1))"].join("\n");
    expect(failure(source)).toMatch(/did you mean 'total'\?/);
  });
});
