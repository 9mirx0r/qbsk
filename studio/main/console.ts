// The engine console (docs/studio.md §14).
//
// A PURE state machine: the input line, the scrollback, the history, and the commands.
// No electron, no DOM, no rendering — so it is unit-testable headless like the rest of
// the host, and so the thing that draws it can be swapped without touching what it does.
//
// It talks to the LIVE program, never to the repository (§14.1). The commands it has are
// second front ends onto capability the MCP already proves works: evaluate against the
// running program, list its variables, inspect one, reload it.
//
// What it produces is `view()` — the exact object served to the console scene through
// `host()` (§14.6). The scene reads; it never writes back.

import type { HostValue } from "../../src/interp/natives.js";

export interface InspectedValue {
  type: string;
  text: string;
}

export interface EvalOutcome {
  /** Anything the snippet printed. */
  out: string[];
  error: string | null;
  /** The value the snippet evaluated to, already rendered, or null for none. */
  value: string | null;
}

/**
 * What the console needs from a live program.
 *
 * An interface and not `StudioFrameHost` directly, so the console can be tested
 * against a stand-in and so a second driver (the terminal, later) can satisfy it.
 */
/** One entity, flattened for display (docs/engine.md §12.2). */
export interface EntityRow {
  id: number;
  components: Record<string, string | number | boolean>;
}

export interface ConsoleTarget {
  varNames(): string[];
  inspect(name: string): InspectedValue | null;
  evalSnippet(source: string): EvalOutcome;
  reload(): void;
  /** Turn number and turns requested but not yet run, or null with no simulation. */
  simState?(): { turn: number; pending: number } | null;
  /** The named variable read as entities, or null when it is not a list of them. */
  entities?(name: string): EntityRow[] | null;
}

/** Breaks a line at the frame width, on a space where there is one. */
function wrap(line: string, width: number): string[] {
  if (line.length <= width) {
    return [line];
  }
  const rows: string[] = [];
  let rest = line;
  while (rest.length > width) {
    // Break at the last space that fits, so a name is not split down the middle.
    // No space to break on means an unbroken token, and a hard cut is the only
    // honest option there.
    const at = rest.lastIndexOf(" ", width);
    const cut = at > width / 2 ? at : width;
    rows.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    rows.push(rest);
  }
  return rows;
}

const HELP = [
  "help              this",
  "vars              names the live program has",
  "get <name>        show one variable",
  "sim               turn number and pending turns",
  "entities <name>   that variable as a table, one entity per row",
  "clear             empty the scrollback",
  "reload            restart the program from source",
  "<anything else>   evaluated as QBSK against the live program",
];

/**
 * Lays entities out as a table.
 *
 * `get goblins` answers with a wrapped blob of JSON, which is correct and useless — the
 * question a person is actually asking is "where is everyone", and that is a column of
 * rows. Columns are sized to their widest cell so numbers line up and an outlier is
 * visible without reading.
 */
function entityTable(rows: EntityRow[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.components)) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  const header = ["id", ...keys];
  const body = rows.map((row) => [
    String(row.id),
    // A component missing from one entity but present on another prints as a dash
    // rather than an empty gap: a hole in a table reads as a bug in the table.
    ...keys.map((key) =>
      row.components[key] === undefined ? "-" : String(row.components[key]),
    ),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i]!.length)),
  );
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padStart(widths[i]!)).join("  ");
  return [line(header), ...body.map(line)];
}

export class EngineConsole {
  /**
   * Scrollback cap.
   *
   * Unbounded history in a session left open all day is a slow leak that surfaces as a
   * stutter, and nothing that far above the window is readable anyway. Dropping the
   * oldest is the same policy the input queue uses (docs/engine.md §8).
   */
  static readonly MAX_LINES = 300;

  /**
   * Usable width, matching examples/console.qbsk's frame.
   *
   * Wrapped here rather than in the scene because the console is the one that KNOWS
   * what it printed. A long `vars` used to run straight through the right border and
   * out of the frame, which looked like a rendering bug and was really an unwrapped
   * string. Wrapping beats truncating: a variable name cut in half is worse than a
   * second line.
   */
  static readonly WIDTH = 74;

  private readonly lines: string[] = [];
  private readonly history: string[] = [];
  private input = "";
  private cursor = 0;
  /** Position in history while walking it; equal to history.length means "not walking". */
  private historyAt = 0;
  /**
   * The sound to play on the next frame, or null (docs/audio.md, docs/studio.md §14).
   *
   * There is deliberately NO per-keystroke click. On Windows the audio device spawns
   * a PowerShell player per sound, so a click per character would be five processes a
   * second while typing. The palette is therefore built from INFREQUENT events. A
   * typing click needs a persistent player process first, which is a change to the
   * single door in src/audio/device.ts and not something to smuggle in here.
   */
  private sound: string | null = null;

  constructor(private target: ConsoleTarget | null) {}

  /** Points the console at a different live program, or at none. */
  setTarget(target: ConsoleTarget | null): void {
    this.target = target;
  }

  /** Announces the console opening or closing, so the sound belongs to the console. */
  announce(open: boolean): void {
    this.play(open ? "open" : "close");
    if (open && this.lines.length === 0) {
      this.print("QBSK engine console — type `help`");
      // Said UP FRONT. The author learned it by running three commands that each
      // answered "no program is running". The console knew; it should have said so.
      if (this.target === null) {
        this.print("Nothing is running yet — press Run to start a program.");
      }
    }
  }

  /**
   * Feeds one canonical key name (`src/engine/keys.ts`).
   *
   * A name it does not handle is IGNORED rather than inserted: `page-up` must not end
   * up as the literal text "page-up" in the input line, which is what a naive
   * "anything not special is a character" rule would do.
   */
  key(name: string): void {
    switch (name) {
      case "enter":
        this.submit();
        return;
      case "backspace":
        if (this.cursor > 0) {
          this.input =
            this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor -= 1;
        }
        return;
      case "delete":
        this.input =
          this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        return;
      case "arrow-left":
        this.cursor = Math.max(0, this.cursor - 1);
        return;
      case "arrow-right":
        this.cursor = Math.min(this.input.length, this.cursor + 1);
        return;
      case "home":
        this.cursor = 0;
        return;
      case "end":
        this.cursor = this.input.length;
        return;
      case "arrow-up":
        this.walkHistory(-1);
        return;
      case "arrow-down":
        this.walkHistory(1);
        return;
      case "space":
        this.insert(" ");
        return;
      default:
        // A single character is its own key name (docs/studio.md §14.5), which is
        // exactly the set that should be typed. Everything else is not text.
        if ([...name].length === 1) {
          this.insert(name);
        }
    }
  }

  /** The object served to the console scene through `host()`. */
  view(): Record<string, HostValue> {
    return {
      lines: [...this.lines],
      input: this.input,
      cursor: this.cursor,
      ready: this.target !== null,
      sound: this.sound,
    };
  }

  /**
   * Ends a frame: the pending sound is consumed.
   *
   * A sound must be visible to the scene for EXACTLY one frame. The device forgets a
   * tone that is absent from a frame, so a one-frame appearance plays once and the
   * gap is what lets the next one fire (docs/audio.md §5). Leaving the name set would
   * make two consecutive errors sound like one.
   *
   * Separate from `view()` so the view stays pure — a getter that mutates would make
   * every test that inspects state twice give different answers.
   */
  endFrame(): void {
    this.sound = null;
  }

  /**
   * Asks for a sound on the next frame.
   *
   * Last one wins within a frame: two events in the same 33 ms are one thing as far
   * as the ear is concerned, and stacking them would just spawn two players.
   */
  private play(name: string): void {
    this.sound = name;
  }

  /** Appends a line from outside — how the host reports events the user did not cause. */
  print(line: string): void {
    for (const part of line.split("\n")) {
      for (const row of wrap(part, EngineConsole.WIDTH)) {
        this.lines.push(row);
      }
    }
    while (this.lines.length > EngineConsole.MAX_LINES) {
      this.lines.shift();
    }
  }

  private insert(text: string): void {
    this.input =
      this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor);
    this.cursor += text.length;
  }

  private walkHistory(delta: number): void {
    if (this.history.length === 0) {
      return;
    }
    const next = this.historyAt + delta;
    // Clamped at the oldest, but allowed to run one PAST the newest — that position
    // is the empty line, so arrowing back down returns you to what you were typing
    // rather than sticking on the last command.
    if (next < 0 || next > this.history.length) {
      return;
    }
    this.historyAt = next;
    this.input = next === this.history.length ? "" : this.history[next]!;
    this.cursor = this.input.length;
  }

  private submit(): void {
    const line = this.input.trim();
    this.input = "";
    this.cursor = 0;
    if (line === "") {
      // An empty line echoes nothing: a column of bare prompts is noise.
      return;
    }
    this.history.push(line);
    this.historyAt = this.history.length;
    this.print(`> ${line}`);
    // Defence in depth (the project rules RULE #4). The root cause of the crash was fixed in
    // the parser, but a console is where garbage gets typed by definition, and it must
    // absorb ALL of it: nothing a person can type may take down the window they are
    // using. Reported, never swallowed — a console that ate errors silently would be
    // worse than one that crashed, because you would not know it had stopped working.
    try {
      this.run(line);
    } catch (err) {
      this.failed = true;
      this.print(err instanceof Error ? err.message : String(err));
    }
    // The sound reports the OUTCOME, not the keystroke: a command that failed should
    // sound different from one that worked, which is the only thing the ear can use.
    this.play(this.failed ? "error" : "submit");
  }

  private failed = false;

  private run(line: string): void {
    this.failed = false;
    const [head, ...rest] = line.split(/\s+/);
    const arg = rest.join(" ");
    if (head === "help") {
      for (const row of HELP) {
        this.print(row);
      }
      return;
    }
    if (head === "clear") {
      this.lines.length = 0;
      return;
    }
    if (this.target === null) {
      this.failed = true;
      this.print("no program is running — press Run first");
      return;
    }
    if (head === "vars") {
      const names = this.target.varNames();
      this.print(names.length === 0 ? "(no variables)" : names.join("  "));
      return;
    }
    if (head === "get") {
      if (arg === "") {
        this.print("get needs a name, e.g. `get playerX`");
        return;
      }
      const found = this.target.inspect(arg);
      if (found === null) {
        this.failed = true;
        this.print(`'${arg}' is not defined in the live program`);
        return;
      }
      if (found.type === "native") {
        // Someone typing `get turn` means the turn NUMBER and receives a function.
        // The console knows which one they meant, so it says so rather than answering
        // literally — the same instinct as the analyzer's key-name suggestions.
        this.print(`${arg} is a built-in function — call it: ${arg}()`);
        return;
      }
      this.print(`${arg} : ${found.type} = ${found.text}`);
      return;
    }
    if (head === "sim") {
      const sim = this.target.simState?.() ?? null;
      this.print(
        sim === null
          ? "this program has no turns — nothing has called advance()"
          : `turn ${sim.turn}` +
            (sim.pending > 0 ? `  (${sim.pending} pending)` : ""),
      );
      return;
    }
    if (head === "entities") {
      if (arg === "") {
        this.print("entities needs a name, e.g. `entities goblins`");
        return;
      }
      const rows = this.target.entities?.(arg) ?? null;
      if (rows === null) {
        this.failed = true;
        this.print(`'${arg}' is not a list of entities`);
        return;
      }
      if (rows.length === 0) {
        this.print(`no entities in '${arg}'`);
        return;
      }
      for (const line of entityTable(rows)) {
        this.print(line);
      }
      return;
    }
    if (head === "reload") {
      this.target.reload();
      this.print("reloaded");
      return;
    }
    // The ergonomic rule: anything unrecognised is QBSK. Typing `playerX + 1` and
    // getting the answer is what makes this a console rather than a menu — and it
    // means the console never has to grow a command for something the language does.
    const res = this.target.evalSnippet(line);
    for (const out of res.out) {
      this.print(out);
    }
    if (res.error !== null) {
      this.failed = true;
      this.print(res.error);
    } else if (res.value !== null) {
      this.print(res.value);
    }
  }
}
