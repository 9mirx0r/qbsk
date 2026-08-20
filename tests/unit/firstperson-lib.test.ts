// The billboard library (docs/engine.md §11.21): where an entity lands in a cast view.
//
// Written in QBSK, not as a native. Placing a sprite in a first-person view is `atan2`,
// a subtraction and a comparison against the wall distance the caster already returned —
// all of which the language says. The DDA needed the engine; this does not.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

const EXAMPLES = resolve(import.meta.dirname, "..", "..", "examples");

/** A newline, spelled once, because these snippets are multi-line QBSK programs. */
const NEWLINE = "\n";

/** Runs a snippet with the library imported, and returns what it printed. */
function out(body: string): string[] {
  const r = runQbsk(
    `use "lib/firstperson.qbsk" as fp\nvar eye = {"x": 4.0, "y": 4.0, "angle": 0.0}\n${body}`,
    "t.qbsk",
    undefined,
    { baseDir: EXAMPLES },
  );
  expect(r.error?.message ?? null).toBeNull();
  return r.out;
}

describe("billboard places an entity in a cast view", () => {
  it("puts something straight ahead in the middle column", () => {
    // 80 columns, so dead centre is 40.
    expect(out('print(fp.billboard(eye, 9.0, 4.0, 80, 60.0)[0])')[0]).toBe("40");
  });

  it("puts something to the right at a higher column than something to the left", () => {
    const right = Number(out('print(fp.billboard(eye, 9.0, 5.0, 80, 60.0)[0])')[0]);
    const left = Number(out('print(fp.billboard(eye, 9.0, 3.0, 80, 60.0)[0])')[0]);
    expect(right).toBeGreaterThan(40);
    expect(left).toBeLessThan(40);
  });

  it("reports a PERPENDICULAR distance, so it can be compared with a wall's", () => {
    // The caster returns distance along the camera's forward axis. An entity measured
    // radially would sit further away than a wall it is level with, and would vanish
    // behind that wall at the edges of the view while standing in front of it at the
    // centre. Five ahead and five to the side is 7.07 away and 5.0 deep.
    // Compared as a number: the arithmetic lands on 5.000000000000001, and pinning the
    // decimal expansion of a cosine would be pinning the FPU, not the behaviour.
    expect(Number(out('print(fp.billboard(eye, 9.0, 9.0, 80, 90.0)[1])')[0])).toBeCloseTo(5, 9);
  });

  it("marks something behind the camera as not on screen", () => {
    expect(out('print(fp.billboard(eye, 1.0, 4.0, 80, 60.0)[2])')[0]).toBe("false");
  });

  it("marks something outside the field of view as not on screen", () => {
    // 60 degrees means 30 either side; this one sits at 45.
    expect(out('print(fp.billboard(eye, 9.0, 9.0, 80, 60.0)[2])')[0]).toBe("false");
    // ... and widening the view brings it back, which proves the fov is what decided.
    expect(out('print(fp.billboard(eye, 9.0, 9.0, 80, 100.0)[2])')[0]).toBe("true");
  });

  it("wraps the bearing rather than losing an entity behind the camera's zero", () => {
    // Facing just west of north, with the entity just east of it. The raw difference of
    // the two angles is nearly a full turn; the real bearing is a few degrees. Without
    // wrapping, this entity is off screen while standing in front of the player.
    const r = out(
      'var facing = {"x": 4.0, "y": 4.0, "angle": 0.0 - 3.0}\n' +
      'print(fp.billboard(facing, 4.0 - 5.0, 4.0 + 0.5, 80, 60.0)[2])',
    );
    expect(r[0]).toBe("true");
  });

  it("says an entity is hidden when a wall stands nearer in its column", () => {
    expect(out("print(fp.hidden(3.0, 8.0))")[0]).toBe("false");
    expect(out("print(fp.hidden(8.0, 3.0))")[0]).toBe("true");
  });

  it("scales height the same way the walls do, so they share a horizon", () => {
    // The +0.1 the walls use is in here too, and that is the point of the test: 3.9 away
    // divides by 4.0 exactly. An entity scaled by a curve even slightly different from
    // the walls' stands on a floor receding at another rate and reads as a sticker on
    // the screen rather than as a body in the room.
    expect(out("print(fp.column_height(16.0, 3.9))")[0]).toBe("4");
    expect(out("print(fp.column_height(16.0, 7.9))")[0]).toBe("2");
    // Clamped: something pressed against the eye must not draw off the frame.
    expect(out("print(fp.column_height(16.0, 0.01))")[0]).toBe("16");
  });
});

// ---------------------------------------------------------------------------
// The contract, enforced (library review).
//
// `billboard`'s own comment states the guarantee: "A column of -1 accompanies `false`, so
// a caller that forgets to check still indexes somewhere obviously wrong rather than
// somewhere plausible." A `columns` of 0 broke exactly that -- it answered
// [-1, depth, TRUE], and a negative `columns` answered [-4, depth, true]. The sentinel
// and the flag disagreed, which is worse than either being wrong alone: a caller that
// DOES check `on_screen` is then handed a negative index.
//
// Not fixed here, and deliberately: `wrap_angle`'s loop subtracts 2*pi one turn at a
// time, so an enormous angle is slow -- 1e8 radians measured at 2.4 seconds. It is not a
// hazard. `atan2` bounds one term at pi and an eye angle would have to accumulate to a
// hundred million radians to reach it. Guarding that would be validation theatre.
// ---------------------------------------------------------------------------

describe("billboard keeps the promise its own comment makes", () => {
  const fails = (call: string): string => {
    const r = runQbsk(
      `use "lib/firstperson.qbsk" as fp@var eye = {"x": 4.0, "y": 4.0, "angle": 0.0}@print(str(${call}))`.split("@").join(NEWLINE),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error).not.toBeNull();
    return r.error!.message;
  };

  it("refuses a view with no columns, which used to answer -1 AND on_screen true", () => {
    expect(fails("fp.billboard(eye, 9.0, 4.0, 0, 60.0)")).toContain("at least 1 column");
  });

  it("refuses a negative column count, which answered -4 and true", () => {
    expect(fails("fp.billboard(eye, 9.0, 4.0, 0 - 3, 60.0)")).toContain("at least 1 column");
  });

  it("names the field of view rather than reporting a division by zero", () => {
    // It did report -- QBSK caught the division -- but at firstperson.qbsk:48, pointing
    // at the arithmetic instead of at the argument that made it impossible.
    expect(fails("fp.billboard(eye, 9.0, 4.0, 80, 0.0)")).toContain("field of view");
    expect(fails("fp.billboard(eye, 9.0, 4.0, 80, 360.0)")).toContain("field of view");
  });

  it("still places an entity that is genuinely in view", () => {
    // The guard must admit every call the demo already makes, or it would be trading a
    // wrong answer for the refusal of a right one.
    expect(out("print(fp.billboard(eye, 9.0, 4.0, 80, 60.0)[0])")[0]).toBe("40");
  });
});

describe("column_height refuses a depth that is not a distance", () => {
  const fails = (call: string): string => {
    const r = runQbsk(
      `use "lib/firstperson.qbsk" as fp@print(str(${call}))`.split("@").join(NEWLINE),
      "t.qbsk",
      undefined,
      { baseDir: EXAMPLES },
    );
    expect(r.error).not.toBeNull();
    return r.error!.message;
  };

  it("refuses a negative depth, which answered a negative height", () => {
    // column_height(20.0, -0.5) answered -50. A caller drawing minus fifty rows draws
    // nothing, and finds out somewhere else entirely.
    expect(fails("fp.column_height(20.0, 0.0 - 0.5)")).toContain("depth");
  });

  it("still answers for something pressed against the eye", () => {
    // Depth 0 is legal and is what the clamp in this function exists for.
    expect(out("print(str(fp.column_height(20.0, 0.0)))")[0]).toBe("20");
  });
});

