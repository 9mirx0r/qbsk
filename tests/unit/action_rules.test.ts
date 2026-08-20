// an earlier release — the Action + Rules engine (the roadmap),
// reopening the CDDA/Qud review's D2 item (the roadmap §4.3) as a
// pure QBSK-language library (examples/lib/action_rules.qbsk), not a native. These tests
// exercise the library in isolation, the same way it's used from real QBSK code — via
// `use` + runQbsk — never by reaching into src/ for its internals.
import { describe, expect, it } from "vitest";
import { runQbsk } from "../../src/interp/interpreter.js";

// examples/lib/action_rules.qbsk is a real file on disk; baseDir makes `use
// "action_rules.qbsk"` resolve against it exactly as examples/worldgen_test.qbsk's own
// `use "lib/action_rules.qbsk"` does.
function run(source: string) {
  return runQbsk(source, "examples/lib/_test.qbsk", undefined, {
    baseDir: "examples/lib",
  });
}

function out(source: string): string[] {
  const r = run(source);
  expect(r.error).toBeNull();
  return r.out;
}

describe("an earlier release: action_rules.qbsk", () => {
  it("a single accepting rule commits the action", () => {
    expect(
      out(`
use "action_rules.qbsk" as rules

func alwaysAccept(action, state, pending)
    return {"accept": true}

var result = rules.process([{"type": "greet"}], [alwaysAccept], {})
print(len(result["committed"]))
print(len(result["rejected"]))
`),
    ).toEqual(["1", "0"]);
  });

  it("a single rejecting rule drops the action", () => {
    expect(
      out(`
use "action_rules.qbsk" as rules

func alwaysReject(action, state, pending)
    return {"accept": false}

var result = rules.process([{"type": "greet"}], [alwaysReject], {})
print(len(result["committed"]))
print(len(result["rejected"]))
`),
    ).toEqual(["0", "1"]);
  });

  it("any single rule vetoing among several rules rejects the action", () => {
    expect(
      out(`
use "action_rules.qbsk" as rules

func alwaysAccept(action, state, pending)
    return {"accept": true}

func gateOnFlag(action, state, pending)
    return {"accept": action["ok"]}

var actions = [{"type": "a", "ok": true}, {"type": "b", "ok": false}]
var result = rules.process(actions, [alwaysAccept, gateOnFlag], {})
print(len(result["committed"]))
print(len(result["rejected"]))
`),
    ).toEqual(["1", "1"]);
  });

  it("an accepted action's rule can enqueue a follow-on that gets processed too", () => {
    expect(
      out(`
use "action_rules.qbsk" as rules

func chain(action, state, pending)
    if action["type"] == "trigger"
        push(pending, {"type": "followup"})
    return {"accept": true}

var result = rules.process([{"type": "trigger"}], [chain], {})
print(len(result["committed"]))
print(result["committed"][0]["type"])
print(result["committed"][1]["type"])
`),
    ).toEqual(["2", "trigger", "followup"]);
  });

  it("rules mutate the shared world state directly, in commit order", () => {
    expect(
      out(`
use "action_rules.qbsk" as rules

func record(action, state, pending)
    push(state["log"], action["type"])
    return {"accept": true}

var w = {"log": []}
rules.process([{"type": "a"}, {"type": "b"}], [record], w)
print(join(w["log"], ","))
`),
    ).toEqual(["a,b"]);
  });

  it("a rule indifferent to an action's type stays neutral (accept), not a veto", () => {
    // The contract (action_rules.qbsk's own header) says a rule with no opinion on an
    // action must default to accept — otherwise composing independent rules for
    // independent action types (examples/worldgen_test.qbsk's real usage) would be
    // impossible, since ANY rule seeing an action it doesn't understand would veto it.
    expect(
      out(`
use "action_rules.qbsk" as rules

func ownsTypeA(action, state, pending)
    if action["type"] != "a"
        return {"accept": true}
    return {"accept": false}

var result = rules.process([{"type": "b"}], [ownsTypeA], {})
print(len(result["committed"]))
`),
    ).toEqual(["1"]);
  });
});

// ---------------------------------------------------------------------------
// The contract, enforced (library review).
//
// The header states it: a rule "returns {"accept": bool} — false from ANY rule drops the
// action for good". Nothing checked the type, and `not verdict["accept"]` fell back to
// truthiness — so a rule that returned the STRING "no" COMMITTED the action. The rule
// said no and the engine did it.
//
// That is the worst shape a defect takes in this library, because the whole point of the
// veto is that one rule can stop an action and every other rule's opinion cannot
// override it. A type slip inverted it silently, and the action went through looking
// exactly like one every rule had approved.
// ---------------------------------------------------------------------------

describe("a verdict has to be the bool the contract says it is", () => {
  const NL = "\n";
  const fails = (rule: string, call: string): string => {
    const r = run(['use "action_rules.qbsk" as ar', rule, call].join(NL));
    expect(r.error).not.toBeNull();
    return r.error!.message;
  };

  it("refuses a rule that answers a string, which used to COMMIT the action", () => {
    const rule = ['func says_no(action, state, pending)', '    return {"accept": "no"}'].join(NL);
    expect(fails(rule, 'print(str(ar.process([{"kind": "a"}], [says_no], {})))'))
      .toContain("accept");
  });

  it("refuses a rule that answers a number, which decided by truthiness", () => {
    // {"accept": 1} committed and {"accept": 0} rejected — plausible enough that nobody
    // would look, and wrong for any value that is neither.
    const rule = ['func numeric(action, state, pending)', '    return {"accept": 1}'].join(NL);
    expect(fails(rule, 'print(str(ar.process([{"kind": "a"}], [numeric], {})))'))
      .toContain("accept");
  });

  it("names the rule's position, so one bad rule out of nine is findable", () => {
    const rule = [
      'func ok(action, state, pending)',
      '    return {"accept": true}',
      'func bad(action, state, pending)',
      '    return {"accept": "no"}',
    ].join(NL);
    expect(fails(rule, 'print(str(ar.process([{"kind": "a"}], [ok, ok, bad], {})))'))
      .toContain("2");
  });

  it("still accepts and still vetoes when the verdicts are bools", () => {
    // The guard must not touch the behaviour the library exists for.
    const r = run(
      [
        'use "action_rules.qbsk" as ar',
        'func ok(action, state, pending)',
        '    return {"accept": true}',
        'func veto(action, state, pending)',
        '    return {"accept": false}',
        'var a = ar.process([{"kind": "x"}], [ok], {})',
        'var b = ar.process([{"kind": "x"}], [ok, veto], {})',
        'print(str(len(a["committed"])) + "," + str(len(b["committed"])) + "," + str(len(b["rejected"])))',
      ].join(NL),
    );
    expect(r.error).toBeNull();
    expect(r.out).toEqual(["1,0,1"]);
  });
});

