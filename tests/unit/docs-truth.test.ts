// The documentation is tested (docs/language.md §16).
//
// A review of the three skill files found 51 false claims, 23 of them the kind that make
// an agent build the wrong thing: a skill asserting 16 natives when 77 are registered,
// another describing a `src/engine/terminal.ts` that never existed, a third gating on
// 273 tests when the suite held 1306. Every one was found by a person reading carefully,
// which does not scale — and the same class had already been fixed by hand in an earlier release,
// in §14, in §15, and again in the skills.
//
// Fixing an instance of drift is not the work. Making the class fail a test is.
//
// Three kinds of claim are mechanically checkable, and they are exactly the three that
// were repeatedly wrong: a native exists, a path exists, a count is current. Everything
// else — prose, examples, history — is deliberately out of scope (§16.2).

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNatives } from "../../src/interp/natives.js";
import { parse } from "../../src/parser/parser.js";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** Every document that makes claims about the project, in one list. */
const DOCS = [
  "docs/language.md",
  "docs/engine.md",
  "docs/audio.md",
  "docs/studio.md",
  "README.md",
  "skills/qbsk-language.md",
  "skills/qbsk-engine.md",
];

/** The live registry — the only authority on what a native is. */
const registeredNatives = (): Set<string> =>
  new Set(createNatives({ print: () => {} }, {}).names());

// ---------------------------------------------------------------------------
// A native exists (§16.1)
// ---------------------------------------------------------------------------

describe("every native the docs mention is registered (§16.1)", () => {
  it("no document invents a native", () => {
    const natives = registeredNatives();
    // A call shape in prose: `name(` inside backticks. Deliberately narrow — it is the
    // form a reader would copy, and the form `animate` was wrongly denied in.
    const CALL = /`([a-z_][a-z0-9_]*)\(/g;
    // Call-shaped words in a doc that are NOT QBSK natives. Three groups, kept apart so
    // a future reader can tell why each is here:
    const NOT_NATIVES = new Set([
      // QBSK keywords and DSL primitives — parsed, never resolved through the env.
      "func", "if", "while", "for", "return", "match", "use", "scene", "layer",
      "sprite", "box", "border", "line", "text", "tone", "shade", "color", "anchor",
      "on", "key", "tick", "resize", "start", "turn", "when", "catch", "try",
      // Host-side TypeScript the docs legitimately name while describing internals.
      "require", "import", "console", "process", "readFileSync", "writeFileSync",
      "setTimeout", "parseInt", "isNaN", "expect", "describe", "it", "test",
      "main", "fn", "closest", "error", "native", "parse", "sgr", "swap", "reset",
      "clear", "step", "resume", "translate", "synthesize", "sign",
      "eq", "setCell", "rect", "blit", "beginFrame", "endFrame", "cursor",
      "setFrameRate", "move", "scale", "hide", "showCursor",
      // Placeholder names in signatures and prose.
      "qbsk", "node", "npm", "name", "value", "expr", "stmt", "span", "f", "g",
      // CLI commands, which read as calls when a doc writes `fmt(fmt(x))`.
      "fmt", "run", "check", "lex", "profile", "repl",
    ]);

    // A section explicitly marked as a DESIGN specifies what does not exist yet — that
    // is its job, and forbidding it would forbid designing in the open. Everything from
    // such a heading to the next `## ` is exempt.
    const stripDesignSections = (text: string): string =>
      text
        .split(/^## /m)
        .filter((section) => !/^[^\n]*DESIGN, not yet built/.test(section))
        .join("\n## ");

    const invented: string[] = [];
    for (const doc of DOCS) {
      const text = stripDesignSections(read(doc));
      for (const m of text.matchAll(CALL)) {
        const fn = m[1]!;
        if (natives.has(fn) || NOT_NATIVES.has(fn)) {
          continue;
        }
        // A name defined in the same document (a doc's own example function) is fine.
        if (new RegExp(`func ${fn}\\b`).test(text)) {
          continue;
        }
        invented.push(`${doc}: ${fn}()`);
      }
    }
    expect([...new Set(invented)]).toEqual([]);
  });

  it("the registry is the authority, and it is reachable from a test", () => {
    // If this breaks, every check above silently stops meaning anything.
    const natives = registeredNatives();
    expect(natives.size).toBeGreaterThan(60);
    expect(natives.has("print")).toBe(true);
    expect(natives.has("animate")).toBe(true);
    expect(natives.has("sin")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A path exists (§16.1)
// ---------------------------------------------------------------------------

describe("every path the docs cite exists (§16.1)", () => {
  it("no document points at a file that is not there", () => {
    // Backticked paths under a known top-level directory. `docs/canvas-dsl.md`,
    // `docs/sprites.md` and `src/engine/terminal.ts` were all cited for months.
    // ⚠️ THE SECOND ALTERNATIVE IS THE ONE THAT WAS MISSING. This matched only paths
    // UNDER a top-level directory, so a bare root-level file — `ROADMAP.md` — was
    // invisible, and four documents cited one that does not ship. A guard against dangling
    // citations that cannot see the commonest shape of citation is half a guard.
    const PATH =
      /`((?:src|tests|examples|bench|docs|studio|skills)\/[A-Za-z0-9_./-]+\.[a-z]+|[A-Z][A-Za-z0-9_-]*\.md)`/g;
    // A line SAYING a path does not exist is not citing it — that is the correction
    // that stopped agents looking for `terminal.ts`. Scoping to present-tense claims is
    // §16.2: a document recording what a claim used to be, or marking what was never
    // built, is not asserting that it is there. The window is the surrounding sentence,
    // since the denial often lands on the next line after a wrap.
    const DENIES =
      /does not exist|never existed|was cited|used to cite|no such file|citing `|planned, absent|NOT built|not yet built|\*\*no `/i;

    const missing: string[] = [];
    for (const doc of DOCS) {
      const lines = read(doc).split("\n");
      for (const [i, line] of lines.entries()) {
        const sentence = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join(" ");
        if (DENIES.test(sentence)) {
          continue;
        }
        for (const m of line.matchAll(PATH)) {
          const p = m[1]!;
          if (!existsSync(join(ROOT, p))) {
            missing.push(`${doc}:${i + 1}: ${p}`);
          }
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A count is current (§16.1, §16.3)
// ---------------------------------------------------------------------------

/** Count `it(` cases the way the suite does: files under tests/unit. */
function suiteSize(): { files: number; tests: number } {
  const dir = join(ROOT, "tests", "unit");
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
  let tests = 0;
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    tests += (src.match(/(^|\s)it\(/g) ?? []).length;
  }
  return { files: files.length, tests };
}

function exampleCount(): number {
  const dir = join(ROOT, "examples");
  return readdirSync(dir).filter(
    (f) => f.endsWith(".qbsk") && statSync(join(dir, f)).isFile(),
  ).length;
}

describe("every count the docs state is current (§16.3)", () => {
  it("the README's test count matches reality", () => {
    // It read "1048 tests green across 42 files" while the suite held 1351 across 60 —
    // 28% wrong, for months, in the first document anyone reads.
    const readme = read("README.md");
    const m = readme.match(/(\d[\d,]*)\s+tests green across\s+(\d+)\s+files/);
    expect(m, "README must state its test count in the checked form").not.toBeNull();

    const { files, tests } = suiteSize();
    expect(Number(m![1]!.replace(/,/g, ""))).toBe(tests);
    expect(Number(m![2]!)).toBe(files);
  });

  it("the README's example count matches reality", () => {
    const readme = read("README.md");
    const m = readme.match(/(\d+)\s+runnable programs/);
    expect(m, "README must state its example count in the checked form").not.toBeNull();
    expect(Number(m![1]!)).toBe(exampleCount());
  });

  it("the skills' test baselines match reality", () => {
    // Each skill states a baseline an agent is told to hold. A stale one taught an
    // agent it could delete a thousand tests and still pass.
    const { files, tests } = suiteSize();
    for (const skill of DOCS.filter((d) => d.startsWith("skills/"))) {
      const text = read(skill);
      const m = text.match(/(\d+)\s+(?:test )?files?\s*(?:\/|,)\s*(\d[\d,]*)\s+tests/);
      expect(m, `${skill} must state a test baseline`).not.toBeNull();
      expect(Number(m![1]!), `${skill}: file count`).toBe(files);
      expect(Number(m![2]!.replace(/,/g, "")), `${skill}: test count`).toBe(tests);
    }
  });


  // The case that used to live here checked this note, a development file that does not
  // ship. What it was guarding -- that the suite baseline is stated where a reader will
  // trust it -- is guarded by "the README's test count matches reality" above.

  it("every native count the docs state matches the registry", () => {
    // The count lived in five documents and NONE of them was checked. Adding `raycast`
    // in an earlier release left two of them saying 80 while the registry held 81, and the language
    // skill and the README sat at 77 through six additions. `no document invents a
    // native` above checks the NAMES; nothing checked how many there were.
    //
    // Historical sentences are exempt by construction: they are phrased as a past review
    // finding ("a skill asserting 16 natives when 77 were registered") and do not match
    // the live forms below.
    const live = registeredNatives().size;
    const forms: [string, RegExp][] = [
      ["docs/language.md", /\*\*The (\d+) natives\*\*/],
      ["docs/language.md", /one native in camelCase\*\*, among (\d+)/],
      ["docs/language.md", /sole camelCase native\*\* among (\d+)/],
      ["skills/qbsk-language.md", /\*\*(\d+) natives are registered\.\*\*/],
      ["skills/qbsk-language.md", /16 natives \(there are (\d+)\)/],
      ["README.md", /the 51 keywords, the (\d+) natives/],
    ];
    for (const [doc, form] of forms) {
      const m = read(doc).match(form);
      expect(m, `${doc} must state the native count as ${form}`).not.toBeNull();
      expect(Number(m![1]!), `${doc} ${form}`).toBe(live);
    }
  });

  it("the golden count the language skill states matches the directory", () => {
    // It said 19 while `tests/golden/` held 26, and nothing checked it. Goldens change
    // rarely and always deliberately, so this is an exact count rather than a bound.
    const text = read("skills/qbsk-language.md");
    const m = text.match(/(\d+)\s+byte-for-byte outputs/);
    expect(m, "the language skill must state the golden count").not.toBeNull();
    const goldens = readdirSync(join(ROOT, "tests", "golden")).filter((f) =>
      f.endsWith(".out"),
    ).length;
    expect(Number(m![1]!)).toBe(goldens);
  });

  it("the source sizes the token protocol quotes are the right order of magnitude", () => {
    // this note and the review skill both tell an agent not to read the whole repo, and
    // both quote how big it is. Those figures said 15,495 lines across 52 files while
    // `src/` held 17,645 across 57 — 14% low and drifting further with every commit.
    //
    // A BOUND, not an equality: a line count that had to be exact would fail on every
    // commit that touches src/, and the claim being made is "this is too big to read",
    // which 15% either way does not change. What it catches is the failure that
    // actually happened to this file — a figure left behind while the repo doubled.
    const files = readdirSync(join(ROOT, "src"), { recursive: true }) as string[];
    const ts = files.filter((f) => f.endsWith(".ts"));
    const lines = ts.reduce(
      (n, f) => n + readFileSync(join(ROOT, "src", f), "utf8").split("\n").length,
      0,
    );
    for (const doc of ["skills/qbsk-language.md"]) {
      const m = read(doc).match(/`src\/` is \*\*([\d,]+) lines across (\d+) files\*\*/);
      expect(m, `${doc} must state the size of src/`).not.toBeNull();
      const statedLines = Number(m![1]!.replace(/,/g, ""));
      expect(Math.abs(statedLines - lines) / lines, `${doc}: line count`).toBeLessThan(0.15);
      expect(Number(m![2]!), `${doc}: file count`).toBe(ts.length);
    }
  });

  it("the counting agrees with the file it is counting", () => {
    // Guards the guard: if `it(` counting drifts from what the files hold, every count
    // check above is measuring the wrong thing. Checked against this file, whose case
    // count is visible right here rather than requiring a nested test run.
    const self = readFileSync(
      join(ROOT, "tests", "unit", "docs-truth.test.ts"),
      "utf8",
    );
    const cases = (self.match(/(^|\s)it\(/g) ?? []).length;
    expect(cases).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// A path cited in SOURCE exists too (§16.1)
//
// The check above covers the markdown documents. It did not cover comments, and a
// comment is where the most load-bearing citation in the interpreter lived: the `Thunk`
// docstring — the justification for memoising compiled code on the syntax tree — pointed
// at a `compiled-expr` test file for "that property written down", and the very commit
// that wrote the sentence renamed that file to `compiled-tree`. (Spelled without its
// directory here on purpose: written in full, this comment would trip its own check.)
//
// That is review anti-pattern 3 in the one comment a future agent reads before touching
// the hottest code in the project: it would go looking for the proof and find nothing.
// ---------------------------------------------------------------------------

describe("every path a source comment cites exists (§16.1)", () => {
  /** Every .ts/.cts file under a directory, recursively, skipping node_modules. */
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        continue;
      }
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(...sources(rel));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".cts")) {
        out.push(rel);
      }
    }
    return out;
  }

  it("no comment points at a test or example that is not there", () => {
    // Only the two shapes that are unambiguously paths and unambiguously checkable.
    // `src/foo.ts` is deliberately NOT included: comments name modules by bare filename
    // far more often than by path, and guessing would make this fail on prose.
    const cited = /(tests\/(?:unit|golden)\/[\w.-]+|examples\/(?:lib\/)?[\w.-]+\.qbsk)/g;
    const missing: string[] = [];
    for (const file of [...sources("src"), ...sources("studio"), ...sources("tests")]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const line of text.split("\n")) {
        // Comment lines only. A path inside a string literal is code doing its job —
        // the tests that read goldens name them for real.
        const comment = /^\s*(?:\/\/|\*|\/\*)/.test(line);
        if (!comment) {
          continue;
        }
        for (const m of line.matchAll(cited)) {
          const path = m[1]!;
          if (!existsSync(join(ROOT, path))) {
            missing.push(`${file}: ${path}`);
          }
        }
      }
    }
    expect(missing, "cited in a comment, absent from the repo").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The ROADMAP teaches syntax that parses (§16.1)
// ---------------------------------------------------------------------------

describe("the README does not teach syntax the language rejects (§16.1)", () => {
  it("every qbsk block in README.md parses", () => {
    // ROADMAP.md is aspirational by nature — it was written before the language
    // existed — so its examples drifted furthest: a layer-level `anchor:` (a parse
    // error since §14.2), `hero.animate(...)` method calls, `2s` duration literals,
    // and a `timeline intro` block form §14.7 removed from the grammar. It is also
    // the first document a newcomer reads.
    //
    // Scoped to ROADMAP.md and tour.md on purpose: the SPEC deliberately shows
    // illegal syntax while cataloguing mistakes (§14 is entirely that), so this
    // check must not spread to the rest of docs/ — see §16.2.
    const text = readFileSync(join(ROOT, "README.md"), "utf8");
    const blocks = [...text.matchAll(/```qbsk\r?\n([\s\S]*?)```/g)];
    expect(blocks.length).toBeGreaterThan(0);

    const broken: string[] = [];
    for (const [i, m] of blocks.entries()) {
      const source = m[1]!;
      const line = text.slice(0, m.index).split("\n").length;
      const parsed = parse(source, `ROADMAP.md:${line}`);
      if (parsed.errors.length > 0) {
        broken.push(`block ${i + 1} (line ~${line}): ${parsed.errors[0]!.message}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("every qbsk block in the tour parses", () => {
    // A tutorial that teaches syntax the compiler rejects costs a newcomer their
    // first hour, which is the one hour they were going to give it.
    const text = readFileSync(join(ROOT, "docs", "tour.md"), "utf8");
    const blocks = [...text.matchAll(/```qbsk\r?\n([\s\S]*?)```/g)];
    expect(blocks.length).toBeGreaterThan(5);

    const broken: string[] = [];
    for (const [i, m] of blocks.entries()) {
      const source = m[1]!;
      const line = text.slice(0, m.index).split("\n").length;
      const parsed = parse(source, `tour.md:${line}`);
      if (parsed.errors.length > 0) {
        broken.push(`block ${i + 1} (line ~${line}): ${parsed.errors[0]!.message}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
