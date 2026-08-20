// The engine console (docs/studio.md §14).
import { describe, expect, it } from "vitest";
import { EngineConsole, type ConsoleTarget } from "../../studio/main/console.js";

/** A stand-in for a live program, so the console is testable without Electron. */
function fakeTarget(): ConsoleTarget & { reloads: number } {
  return {
    reloads: 0,
    varNames: () => ["playerX", "score", "cam"],
    inspect: (name) =>
      name === "score" ? { type: "int", text: "42" } : null,
    evalSnippet: (source) => {
      if (source === "boom") {
        return { out: [], error: "boom is not defined", value: null };
      }
      if (source === "print(1)") {
        return { out: ["1"], error: null, value: null };
      }
      return { out: [], error: null, value: source.toUpperCase() };
    },
    reload() {
      this.reloads += 1;
    },
  };
}

const typeIn = (c: EngineConsole, text: string): void => {
  for (const ch of text) {
    c.key(ch === " " ? "space" : ch);
  }
};

describe("typing", () => {
  it("printable keys build the input line", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "vars");
    expect(c.view()["input"]).toBe("vars");
    expect(c.view()["cursor"]).toBe(4);
  });

  it("space is a character, not a command", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "get score");
    expect(c.view()["input"]).toBe("get score");
  });

  it("backspace deletes before the cursor and nothing at the start", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "ab");
    c.key("backspace");
    expect(c.view()["input"]).toBe("a");
    c.key("backspace");
    c.key("backspace");
    expect(c.view()["input"]).toBe("");
    expect(c.view()["cursor"]).toBe(0);
  });

  it("the arrows move the cursor and insertion follows it", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "ac");
    c.key("arrow-left");
    typeIn(c, "b");
    expect(c.view()["input"]).toBe("abc");
    expect(c.view()["cursor"]).toBe(2);
  });

  it("the cursor cannot leave the line", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "ab");
    c.key("arrow-right");
    expect(c.view()["cursor"]).toBe(2);
    c.key("arrow-left");
    c.key("arrow-left");
    c.key("arrow-left");
    expect(c.view()["cursor"]).toBe(0);
  });

  it("home and end jump to the ends", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "hello");
    c.key("home");
    expect(c.view()["cursor"]).toBe(0);
    c.key("end");
    expect(c.view()["cursor"]).toBe(5);
  });

  it("delete removes forward, backspace backward", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "abc");
    c.key("home");
    c.key("delete");
    expect(c.view()["input"]).toBe("bc");
  });
});

describe("submitting", () => {
  it("enter echoes the command into the scrollback", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "vars");
    c.key("enter");
    const lines = c.view()["lines"] as string[];
    expect(lines.some((l) => l.includes("vars"))).toBe(true);
    expect(c.view()["input"]).toBe("");
    expect(c.view()["cursor"]).toBe(0);
  });

  it("an empty line does nothing rather than echoing a blank prompt", () => {
    const c = new EngineConsole(fakeTarget());
    const before = (c.view()["lines"] as string[]).length;
    c.key("enter");
    expect((c.view()["lines"] as string[]).length).toBe(before);
  });

  it("vars lists what the live program has", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "vars");
    c.key("enter");
    const all = (c.view()["lines"] as string[]).join("\n");
    expect(all).toContain("playerX");
    expect(all).toContain("score");
  });

  it("get reports a variable, and says so when it is not there", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "get score");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("42");

    typeIn(c, "get nope");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("nope");
  });

  it("clear empties the scrollback but keeps the console usable", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "vars");
    c.key("enter");
    typeIn(c, "clear");
    c.key("enter");
    expect((c.view()["lines"] as string[]).length).toBe(0);
    typeIn(c, "x");
    expect(c.view()["input"]).toBe("x");
  });

  it("reload asks the target to reload", () => {
    const target = fakeTarget();
    const c = new EngineConsole(target);
    typeIn(c, "reload");
    c.key("enter");
    expect(target.reloads).toBe(1);
  });

  // The ergonomic rule: anything that is not a command is QBSK. Typing `x + 1` and
  // getting the answer is what makes this a console rather than a menu.
  it("anything unrecognised is evaluated as QBSK", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "hello");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("HELLO");
  });

  it("printed output from an evaluation is shown", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "print(1)");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("1");
  });

  it("an evaluation error is reported, not swallowed", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "boom");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("not defined");
  });

  it("help names the commands it actually has", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "help");
    c.key("enter");
    const all = (c.view()["lines"] as string[]).join("\n");
    for (const cmd of ["vars", "get", "clear", "reload"]) {
      expect(all).toContain(cmd);
    }
  });
});

describe("history", () => {
  it("the up arrow recalls the last command", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "vars");
    c.key("enter");
    c.key("arrow-up");
    expect(c.view()["input"]).toBe("vars");
    expect(c.view()["cursor"]).toBe(4);
  });

  it("walks back through several and forward again", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "one");
    c.key("enter");
    typeIn(c, "two");
    c.key("enter");
    c.key("arrow-up");
    expect(c.view()["input"]).toBe("two");
    c.key("arrow-up");
    expect(c.view()["input"]).toBe("one");
    c.key("arrow-down");
    expect(c.view()["input"]).toBe("two");
  });

  it("past the newest entry the line goes empty rather than sticking", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "one");
    c.key("enter");
    c.key("arrow-up");
    c.key("arrow-down");
    expect(c.view()["input"]).toBe("");
  });

  it("does not walk off the oldest entry", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "one");
    c.key("enter");
    c.key("arrow-up");
    c.key("arrow-up");
    c.key("arrow-up");
    expect(c.view()["input"]).toBe("one");
  });
});

describe("the view is exactly what host() serves", () => {
  it("carries the keys the console scene reads", () => {
    const c = new EngineConsole(fakeTarget());
    const view = c.view();
    // Pinned deliberately: examples/console.qbsk reads exactly these through host(),
    // and a key added here without a reader there is dead weight paid every frame.
    expect(Object.keys(view).sort()).toEqual(
      ["cursor", "input", "lines", "ready", "sound"].sort(),
    );
  });

  // Unbounded scrollback in a long session is a slow leak that ends as a stutter,
  // and nothing above the window is readable anyway.
  it("scrollback is bounded, dropping the oldest", () => {
    const c = new EngineConsole(fakeTarget());
    for (let i = 0; i < 400; i += 1) {
      typeIn(c, `x${i}`);
      c.key("enter");
    }
    const lines = c.view()["lines"] as string[];
    expect(lines.length).toBeLessThanOrEqual(EngineConsole.MAX_LINES);
    expect(lines.join("\n")).toContain("x399");
    expect(lines.join("\n")).not.toContain("x0\n");
  });

  it("says it is not ready when there is no live program", () => {
    const c = new EngineConsole(null);
    expect(c.view()["ready"]).toBe(false);
    typeIn(c, "vars");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("no program");
  });

  it("an unknown key name is ignored rather than inserted", () => {
    const c = new EngineConsole(fakeTarget());
    c.key("page-up");
    c.key("tab");
    expect(c.view()["input"]).toBe("");
  });
});

describe("the console's voice (docs/audio.md)", () => {
  it("opening and closing each have their own sound", () => {
    const c = new EngineConsole(fakeTarget());
    c.announce(true);
    expect(c.view()["sound"]).toBe("open");
    c.endFrame();
    c.announce(false);
    expect(c.view()["sound"]).toBe("close");
  });

  // The sound reports the OUTCOME. A failure that sounds like a success teaches
  // nothing, and it is the one signal usable without looking at the screen.
  it("a command that worked and one that failed sound different", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "vars");
    c.key("enter");
    expect(c.view()["sound"]).toBe("submit");
    c.endFrame();

    typeIn(c, "boom");
    c.key("enter");
    expect(c.view()["sound"]).toBe("error");
  });

  it("asking for a variable that is not there is an error sound", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "get nope");
    c.key("enter");
    expect(c.view()["sound"]).toBe("error");
  });

  it("a command with no program is an error sound", () => {
    const c = new EngineConsole(null);
    typeIn(c, "vars");
    c.key("enter");
    expect(c.view()["sound"]).toBe("error");
  });

  // The device forgets a tone absent from a frame, and that gap is what lets the next
  // one fire. Without endFrame two consecutive errors would sound like one.
  it("a sound lasts exactly one frame", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "vars");
    c.key("enter");
    expect(c.view()["sound"]).toBe("submit");
    c.endFrame();
    expect(c.view()["sound"]).toBeNull();
  });

  it("two errors in a row each get their own sound, with a gap between", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "boom");
    c.key("enter");
    expect(c.view()["sound"]).toBe("error");
    c.endFrame();
    expect(c.view()["sound"]).toBeNull();
    typeIn(c, "boom");
    c.key("enter");
    expect(c.view()["sound"]).toBe("error");
  });

  // Deliberate: on Windows the device spawns a player process per sound, so a click
  // per character would be five processes a second while typing.
  it("typing is silent — there is no per-keystroke click", () => {
    const c = new EngineConsole(fakeTarget());
    typeIn(c, "hello");
    c.key("backspace");
    c.key("arrow-left");
    expect(c.view()["sound"]).toBeNull();
  });

  it("an empty line makes no sound, because nothing happened", () => {
    const c = new EngineConsole(fakeTarget());
    c.key("enter");
    expect(c.view()["sound"]).toBeNull();
  });
});

describe("what the window snapshot exposed (docs/studio.md §15)", () => {
  // Every one of these was found by LOOKING at the running app through
  // qbsk_read_window, not by reasoning about it. That is the tool paying for itself.

  it("a long line wraps inside the frame instead of running through the border", () => {
    const c = new EngineConsole(fakeTarget());
    c.print("x".repeat(200));
    const lines = c.view()["lines"] as string[];
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(EngineConsole.WIDTH);
    }
  });

  it("wrapping breaks on a space, so a name is not cut in half", () => {
    const c = new EngineConsole(fakeTarget());
    const names = Array.from({ length: 30 }, (_, i) => `variable${i}`).join("  ");
    c.print(names);
    const lines = c.view()["lines"] as string[];
    // Every original name survives intact somewhere in the output.
    const joined = lines.join(" ");
    for (let i = 0; i < 30; i += 1) {
      expect(joined).toContain(`variable${i}`);
    }
  });

  it("an unbroken token is hard-cut rather than allowed to overflow", () => {
    const c = new EngineConsole(fakeTarget());
    c.print("y".repeat(120));
    for (const l of c.view()["lines"] as string[]) {
      expect(l.length).toBeLessThanOrEqual(EngineConsole.WIDTH);
    }
  });

  it("a line that already fits is left exactly alone", () => {
    const c = new EngineConsole(fakeTarget());
    c.print("short line");
    expect((c.view()["lines"] as string[])[0]).toBe("short line");
  });

  // Discovered after three commands that each answered "no program is running".
  it("says Run is needed when it opens with nothing running", () => {
    const c = new EngineConsole(null);
    c.announce(true);
    const all = (c.view()["lines"] as string[]).join("\n");
    expect(all).toContain("Run");
  });

  it("does not nag when a program is already running", () => {
    const c = new EngineConsole(fakeTarget());
    c.announce(true);
    expect((c.view()["lines"] as string[]).join("\n")).not.toContain("press Run");
  });
});

describe("a console can never take down the app (the project rules RULE #4)", () => {
  // Typing a stray character crashed the whole Electron main process: the lexer threw,
  // parse() let it through, evalSnippet did not catch it, and it escaped the IPC
  // handler. A console is exactly where garbage gets typed; it must absorb all of it.
  const hostile = [
    "?",
    "¿qué?",
    "€ ¤ §",
    "\\",
    "'unterminated",
    '"also unterminated',
    "0x",
    "1.2.3",
    "]]]",
    "\u0000",
  ];

  it("survives every character a keyboard can produce", () => {
    const c = new EngineConsole({
      varNames: () => [],
      inspect: () => null,
      // The REAL evalSnippet path is what threw, so the stand-in throws too.
      evalSnippet: () => {
        throw new Error("lexer exploded");
      },
      reload: () => {},
    });
    for (const junk of hostile) {
      typeIn(c, junk);
      expect(() => c.key("enter")).not.toThrow();
    }
    // And it reported rather than silently swallowing.
    expect((c.view()["lines"] as string[]).join("\n")).toContain("lexer");
  });

  it("a thrown command still sounds like an error", () => {
    const c = new EngineConsole({
      varNames: () => {
        throw new Error("boom");
      },
      inspect: () => null,
      evalSnippet: () => ({ out: [], error: null, value: null }),
      reload: () => {},
    });
    typeIn(c, "vars");
    expect(() => c.key("enter")).not.toThrow();
    expect(c.view()["sound"]).toBe("error");
  });

  it("stays usable after a crash — the next command still works", () => {
    let angry = true;
    const c = new EngineConsole({
      varNames: () => ["ok"],
      inspect: () => null,
      evalSnippet: () => {
        if (angry) {
          angry = false;
          throw new Error("once");
        }
        return { out: [], error: null, value: "fine" };
      },
      reload: () => {},
    });
    typeIn(c, "boom");
    c.key("enter");
    typeIn(c, "again");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("fine");
  });
});

describe("debugging a simulation (docs/engine.md §12, an earlier release criterion 4)", () => {
  const simTarget = () => ({
    ...fakeTarget(),
    simState: () => ({ turn: 7, pending: 0 }),
    entities: (name: string) =>
      name === "goblins"
        ? [
            { id: 1, components: { x: 40, y: 5, hp: 3 } },
            { id: 2, components: { x: 46, y: 11, hp: 3 } },
          ]
        : null,
  });

  it("sim reports the turn number, which `get turn` cannot", () => {
    const c = new EngineConsole(simTarget());
    typeIn(c, "sim");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("7");
  });

  // A person typing `get turn` means the counter and receives a function. The console
  // knows which one they meant; it should say so rather than answer literally.
  it("get on a built-in says to call it instead of printing the function", () => {
    const c = new EngineConsole({
      ...simTarget(),
      inspect: () => ({ type: "native", text: "<native turn>" }),
    });
    typeIn(c, "get turn");
    c.key("enter");
    const all = (c.view()["lines"] as string[]).join("\n");
    expect(all).toContain("turn()");
  });

  // `get goblins` gives a wrapped blob. A table is what you actually want when the
  // question is "where is everyone".
  it("entities prints one per line with its components aligned", () => {
    const c = new EngineConsole(simTarget());
    typeIn(c, "entities goblins");
    c.key("enter");
    const lines = (c.view()["lines"] as string[]);
    const table = lines.slice(lines.indexOf("> entities goblins") + 1);
    expect(table[0]).toContain("id");
    expect(table[0]).toContain("hp");
    expect(table[1]).toContain("40");
    expect(table[2]).toContain("46");
    // One row per entity, not one wrapped blob.
    expect(table[1]!.includes("46")).toBe(false);
  });

  it("entities on something that is not a list of entities says so", () => {
    const c = new EngineConsole(simTarget());
    typeIn(c, "entities log");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("log");
  });

  it("entities with no name asks for one", () => {
    const c = new EngineConsole(simTarget());
    typeIn(c, "entities");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("entities");
  });

  it("an empty entity list says so rather than printing a bare header", () => {
    const c = new EngineConsole({ ...simTarget(), entities: () => [] });
    typeIn(c, "entities goblins");
    c.key("enter");
    expect((c.view()["lines"] as string[]).join("\n")).toContain("no entities");
  });

  it("help mentions the simulation commands", () => {
    const c = new EngineConsole(simTarget());
    typeIn(c, "help");
    c.key("enter");
    const all = (c.view()["lines"] as string[]).join("\n");
    expect(all).toContain("sim");
    expect(all).toContain("entities");
  });
});
