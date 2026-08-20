import { readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import type { Span } from "../lexer/token.js";
import type {
  Block,
  ColorStmt,
  Expr,
  FuncDecl,
  LayerDecl,
  Program,
  Stmt,
  VisibleStmt,
  ZStmt,
} from "../parser/ast.js";
import { parse } from "../parser/parser.js";
import { loadQbdata } from "../parser/qbdata.js";
import { createNatives } from "../interp/natives.js";
import { QbskError } from "../interp/error.js";
import { isCanonicalKey, NAMED_KEYS, suggestKey } from "../engine/keys.js";
import { closest } from "../util/suggest.js";

// Static analysis for `qbsk check` (spec language.md §9): walks the AST without
// evaluating it and reports name/scope/arity problems with spans. Type and most value
// errors stay runtime-only — this tool never reports a problem that cannot be observed
// by running the same program (forward references are hoisted, never false positives).

type SymKind = "var" | "const" | "func" | "module";

interface Sym {
  kind: SymKind;
  params: number;
  exports: Set<string> | null;
  moduleName: string | null;
}

const NATIVE_NAMES = new Set(createNatives({ print: () => {} }).names());

/** Why one parsed layer may or may not enter the static-layer cache. */
export interface LayerStaticity {
  layer: LayerDecl;
  name: string;
  static: boolean;
  reason: string;
  /**
   * Top-level names this layer depends on, helper calls followed.
   *
   * E1 asks "is this layer static forever?" and gets one bit. Invalidation caching asks
   * "did anything it reads change?" and needs the names. A layer whose reads are all
   * unchanged composes to the same cells, so its runs can be replayed even though it is
   * not static — which is the state a first-person view or a converted backdrop lives in.
   *
   * Identity is not enough on its own: QBSK mutates lists and dicts in place, and module
   * dicts turn out to be mutable too (tests/unit/module-mutability.test.ts). The names
   * here answer "was it rebound"; a mutation epoch answers "was it edited".
   */
  reads: ReadonlySet<string>;
  /**
   * Whether `reads` is the WHOLE story of why this layer moves.
   *
   * `static` and `reads` together still do not license reuse. A layer drawing
   * `gameTime()` is dynamic with an EMPTY read set, so "none of my reads moved" is true
   * of it on every frame forever. E1 never met that case because it caches only what it
   * proved static; an invalidation cache aims at dynamic layers, which is exactly where
   * the gap is.
   *
   * Computed by asking for a reason with name-reads SUPPRESSED. Whatever survives that
   * is dynamism the read set cannot see — a volatile native, an indirect call, animated
   * sprite frames — and `untracked` names it. Nothing surviving means the reads are
   * sufficient, so a static layer is trivially tracked: it cannot move at all.
   *
   * Checking `reason` instead would be unsound. `reason` reports the FIRST source found,
   * so a layer that reads a var AND calls `gameTime` reports the var and looks safe.
   */
  readTracked: boolean;
  /** The dynamism the reads cannot see, or null when they see all of it. */
  untracked: string | null;
}

/**
 * Natives whose result or observable effect can change between compositions.
 *
 * The static-layer list is intentionally broader than clocks and RNG: suppressing a
 * `print`, save, exit, turn request, or spawned identity on cache hits would also be a
 * semantic change. Unknown and higher-order calls take the conservative path below.
 */
const VOLATILE_LAYER_NATIVES = new Set([
  "gameTime",
  "random",
  "turn",
  "animate",
  "animate_done",
  "animate_reset",
  "clock",
  "host",
  "sight",
  "path",
  "rng",
  "roll_float",
  "roll_int",
  "print",
  "advance",
  "spawn",
  "save_state",
  "load_state",
  "list_saves",
  "exit",
  // Mutate an argument (possibly a const-adjacent list reached through an alias).
  "push",
  "pop",
  "sort",
  "reverse",
  // Higher-order callbacks may read or write live state; resolving their value is not
  // enough to prove the call pure without a second interprocedural parameter analysis.
  "map",
  "filter",
  "reduce",
  // Mutate a canvas value supplied by the caller.
  "fill",
  "box",
  "put",
  "line",
]);

const ARGUMENT_MUTATORS = new Set([
  "push", "pop", "sort", "reverse", "map", "filter", "reduce", "fill", "box", "put", "line",
]);

const STABLE_LAYER_NATIVES = new Set([
  "abs", "args", "atan2", "bool", "canvas", "ceil", "contains", "cos",
  "ends_with", "exp", "find", "float", "floor", "glyph", "has", "int", "log",
  "join", "keys", "len", "lit", "lower", "max", "min", "particle",
  "pi", "project", "raycast", "replace", "round",
  "sin", "slice", "split", "sqrt", "starts_with", "str", "tan", "trim",
  "type", "upper", "values", "without",
]);

function isVolatileLayerNative(name: string): boolean {
  return VOLATILE_LAYER_NATIVES.has(name) || name.startsWith("timeline_");
}

function isStableLayerNative(name: string): boolean {
  return STABLE_LAYER_NATIVES.has(name);
}

function rootIdent(expr: Expr): string | null {
  if (expr.kind === "Ident") return expr.name;
  if (expr.kind === "Index" || expr.kind === "Member") return rootIdent(expr.object);
  return null;
}

function layerNativesCalled(program: Program): Set<string> {
  const called = new Set<string>();
  const funcs = new Map(
    program.body
      .filter((stmt): stmt is FuncDecl => stmt.kind === "FuncDecl")
      .map((stmt) => [stmt.name, stmt] as const),
  );
  const visitedFuncs = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.kind === "Call") {
      const callee = record.callee as Expr;
      if (callee.kind === "Ident" && NATIVE_NAMES.has(callee.name)) called.add(callee.name);
      if (callee.kind === "Ident" && !visitedFuncs.has(callee.name)) {
        const fn = funcs.get(callee.name);
        if (fn !== undefined) {
          visitedFuncs.add(callee.name);
          visit(fn.body);
        }
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== "span") visit(value);
    }
  };
  for (const stmt of program.body) {
    if (stmt.kind === "LayerDecl") visit(stmt.body);
    else if (stmt.kind === "SceneDecl" && stmt.body !== null) {
      for (const nested of stmt.body.statements) {
        if (nested.kind === "LayerDecl") visit(nested.body);
      }
    }
  }
  return called;
}

/**
 * Conservative whole-program classification used by both `qbsk check --layers` and
 * SceneProgram. It shares the analyzer's AST walk discipline: names are resolved by
 * scope, user calls are followed, and uncertainty is dynamic rather than guessed static.
 */
export function analyzeLayerStaticity(program: Program): LayerStaticity[] {
  type TopKind = "var" | "const" | "func" | "module";
  const top = new Map<string, TopKind>();
  const funcs = new Map<string, FuncDecl>();
  const mutatedConsts = new Set<string>();
  const reassignedFunctions = new Set<string>();
  const mutableConsts = new Set<string>();
  /**
   * Whether an argument is a bare vocabulary word rather than a value being read.
   *
   * `wave: sine`, `shade grade` and `fg: bright-yellow` name a thing the engine already
   * knows; they are not variables and nothing can rebind them. ColorStmt has always
   * skipped them for exactly this reason — this is the same rule, named once so the
   * three sites cannot drift, which is how `shade` and `tone` came to disagree with
   * `color` about the same syntax in the first place.
   *
   * Stricter than the rule it replaces: a name that IS a top-level binding is a read,
   * whatever it is spelled like, so shadowing the vocabulary cannot smuggle a value past
   * the check.
   */
  const isBareVocabulary = (expr: Expr, locals: ReadonlySet<string>): boolean => {
    if (expr.kind === "Ident") {
      return !locals.has(expr.name) && !top.has(expr.name);
    }
    // `bright-yellow` parses as a subtraction of two bare names.
    return expr.kind === "BinOp" && expr.op === "-" &&
      isBareVocabulary(expr.left, locals) && isBareVocabulary(expr.right, locals);
  };

  const deterministicRngs = new Set<string>();
  // When set, `exprReason` stops reporting "this layer reads that name" and reports only
  // the sources a read set cannot represent. Running the SAME analysis in two modes is
  // what keeps the two answers from drifting: there is one classifier, asked twice.
  let ignoreNameReads = false;

  for (const stmt of program.body) {
    if (stmt.kind === "VarDecl") top.set(stmt.name, "var");
    else if (stmt.kind === "ConstDecl") {
      top.set(stmt.name, "const");
      if (
        stmt.init !== null &&
        stmt.init.kind !== "Lit" &&
        stmt.init.kind !== "InterpolatedStr" &&
        stmt.init.kind !== "Unary" &&
        stmt.init.kind !== "BinOp"
      ) {
        mutableConsts.add(stmt.name);
      }
    } else if (stmt.kind === "FuncDecl") {
      top.set(stmt.name, "func");
      funcs.set(stmt.name, stmt);
    } else if (stmt.kind === "UseStmt") {
      const target = resolve(stmt.path);
      top.set(stmt.alias ?? basename(target, extname(target)), "module");
    }
  }

  const scanMutations = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(scanMutations);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.kind === "Assign") {
      const target = record.target as Expr;
      const root = rootIdent(target);
      if (root !== null && top.get(root) === "const" && target.kind !== "Ident") {
        mutatedConsts.add(root);
      }
      if (root !== null && top.get(root) === "func") {
        reassignedFunctions.add(root);
      }
    } else if (record.kind === "Call") {
      const call = record as unknown as Extract<Expr, { kind: "Call" }>;
      const calleeName = call.callee.kind === "Ident" ? call.callee.name : null;
      const mayMutateArgs =
        calleeName === null ||
        ARGUMENT_MUTATORS.has(calleeName) ||
        funcs.has(calleeName);
      if (mayMutateArgs) {
        for (const arg of call.args) {
          const root = rootIdent(arg);
          if (root !== null && mutableConsts.has(root)) mutatedConsts.add(root);
        }
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== "span") scanMutations(value);
    }
  };
  scanMutations(program.body);

  // A reference type can cross an alias boundary that a name-only assignment scan
  // cannot recover later (`var alias = state`; a handler mutates `alias[0]`). Any
  // mutable top-level const exposed outside a layer is therefore dynamic. Layer reads
  // themselves are excluded: they are exactly what the cache is trying to prove, and
  // evalSnippet has its separate whole-cache invalidation boundary.
  const scanMutableConstExposure = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(scanMutableConstExposure);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.kind === "LayerDecl") return;
    if (record.kind === "Ident") {
      const name = record.name;
      if (typeof name === "string" && mutableConsts.has(name)) mutatedConsts.add(name);
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== "span") scanMutableConstExposure(value);
    }
  };
  for (const stmt of program.body) {
    if (stmt.kind !== "ConstDecl") scanMutableConstExposure(stmt);
  }

  const activeCalls = new Set<string>();

  const exprReason = (expr: Expr, locals: Set<string>): string | null => {
    switch (expr.kind) {
      case "Lit":
      case "ErrorExpr":
        return null;
      case "Ident": {
        if (locals.has(expr.name)) return null;
        const kind = top.get(expr.name);
        // These three are the reasons `collectReads` DOES capture, and only these: it
        // adds a name when `top.has(name)`. Suppressing exactly them is what makes the
        // second pass mean "everything the read set would miss".
        //
        // Note this is the Ident position only. Calling through a name (`f()` where `f`
        // is a var or a module binding) stays a reason even here, because comparing the
        // binding catches rebinding and says nothing about what the callee then reads.
        if (kind === "var") return ignoreNameReads ? null : `reads var '${expr.name}'`;
        if (kind === "module") {
          return ignoreNameReads ? null : `reads imported binding '${expr.name}'`;
        }
        if (kind === "const" && mutatedConsts.has(expr.name)) {
          return ignoreNameReads ? null : `reads mutated const '${expr.name}'`;
        }
        if (kind === "func" || NATIVE_NAMES.has(expr.name)) {
          return "uses a function as a value";
        }
        return kind === "const" ? null : `reads unresolved name '${expr.name}'`;
      }
      case "BinOp":
        return exprReason(expr.left, locals) ?? exprReason(expr.right, locals);
      case "Unary":
        return exprReason(expr.operand, locals);
      case "ListLit":
        for (const item of expr.items) {
          const reason = exprReason(item, locals);
          if (reason !== null) return reason;
        }
        return null;
      case "DictLit":
        for (const entry of expr.entries) {
          const reason = exprReason(entry.value, locals);
          if (reason !== null) return reason;
        }
        return null;
      case "Tuple":
        return exprReason(expr.x, locals) ?? exprReason(expr.y, locals);
      case "Index":
        return exprReason(expr.object, locals) ?? exprReason(expr.index, locals);
      case "Member":
        return exprReason(expr.object, locals);
      case "InterpolatedStr":
        for (const part of expr.parts) {
          if (typeof part !== "string") {
            const reason = exprReason(part, locals);
            if (reason !== null) return reason;
          }
        }
        return null;
      case "Lambda":
        return "uses a function as a value";
      case "Call": {
        for (const arg of expr.args) {
          const reason = exprReason(arg, locals);
          if (reason !== null) return reason;
        }
        for (const arg of expr.namedArgs) {
          const reason = exprReason(arg.value, locals);
          if (reason !== null) return reason;
        }
        if (expr.callee.kind !== "Ident") {
          const calleeReason = exprReason(expr.callee, locals);
          return calleeReason ?? "calls an indirect function";
        }
        const name = expr.callee.name;
        if (locals.has(name)) return "calls an indirect function";
        const kind = top.get(name);
        if (kind === "var") return `reads var '${name}'`;
        if (kind === "const") return "calls an indirect function";
        if (kind === "module") return `reads imported binding '${name}'`;
        const fn = funcs.get(name);
        if (fn !== undefined && reassignedFunctions.has(name)) {
          return `calls reassigned function '${name}'`;
        }
        if (fn === undefined) {
          if (NATIVE_NAMES.has(name)) {
            if (name === "rng") {
              return expr.args.every((arg) => arg.kind === "Lit") ? null : "calls rng";
            }
            if (name === "roll_int" || name === "roll_float") {
              const generator = expr.args[0];
              return activeCalls.size === 0 &&
                generator?.kind === "Ident" && deterministicRngs.has(generator.name)
                ? null
                : `calls ${name}`;
            }
            if (isVolatileLayerNative(name)) return `calls ${name}`;
            return isStableLayerNative(name) ? null : `calls unclassified native '${name}'`;
          }
          return `calls unresolved function '${name}'`;
        }
        if (activeCalls.has(name)) return `calls recursive function '${name}'`;
        activeCalls.add(name);
        const fnLocals = new Set(fn.params.map((param) => param.name));
        const reason = blockReason(fn.body, fnLocals);
        activeCalls.delete(name);
        return reason;
      }
    }
  };

  const assignmentReason = (stmt: Extract<Stmt, { kind: "Assign" }>, locals: Set<string>): string | null => {
    const valueReason = exprReason(stmt.value, locals);
    if (valueReason !== null) return valueReason;
    const root = rootIdent(stmt.target);
    if (root === null) return "writes through an unresolved target";
    if (locals.has(root)) {
      if (stmt.target.kind === "Index" || stmt.target.kind === "Member") {
        return "mutates a value through a local alias";
      }
      return null;
    }
    const kind = top.get(root);
    if (kind === "var") return `writes var '${root}'`;
    if (kind === "const") return `writes const-adjacent value '${root}'`;
    return `writes unresolved name '${root}'`;
  };

  const stmtReason = (stmt: Stmt, locals: Set<string>): string | null => {
    switch (stmt.kind) {
      case "VarDecl":
      case "ConstDecl": {
        let reason = stmt.init === null ? null : exprReason(stmt.init, locals);
        if (
          stmt.init?.kind === "Call" &&
          stmt.init.callee.kind === "Ident" &&
          stmt.init.callee.name === "rng" &&
          stmt.init.args.every((arg) => arg.kind === "Lit")
        ) {
          if (activeCalls.size === 0) deterministicRngs.add(stmt.name);
          reason = null;
        }
        locals.add(stmt.name);
        return reason;
      }
      case "FuncDecl":
        locals.add(stmt.name);
        return null;
      case "Assign":
        return assignmentReason(stmt, locals);
      case "IfStmt":
        for (const branch of stmt.branches) {
          const reason = exprReason(branch.cond, locals) ?? blockReason(branch.body, new Set(locals));
          if (reason !== null) return reason;
        }
        return stmt.elseBody === null ? null : blockReason(stmt.elseBody, new Set(locals));
      case "MatchStmt": {
        let reason = exprReason(stmt.subject, locals);
        if (reason !== null) return reason;
        for (const arm of stmt.arms) {
          reason = exprReason(arm.pattern, locals) ?? blockReason(arm.body, new Set(locals));
          if (reason !== null) return reason;
        }
        return stmt.elseBody === null ? null : blockReason(stmt.elseBody, new Set(locals));
      }
      case "TryStmt":
        return blockReason(stmt.tryBody, new Set(locals)) ??
          blockReason(stmt.catchBody, new Set([...locals, stmt.catchParam]));
      case "ForRange": {
        const reason = exprReason(stmt.from, locals) ?? exprReason(stmt.to, locals);
        return reason ?? blockReason(stmt.body, new Set([...locals, stmt.name]));
      }
      case "ForList": {
        const reason = exprReason(stmt.iterable, locals);
        const names = new Set(locals);
        names.add(stmt.name);
        if (stmt.indexName !== null) names.add(stmt.indexName);
        return reason ?? blockReason(stmt.body, names);
      }
      case "WhileStmt":
        return exprReason(stmt.cond, locals) ?? blockReason(stmt.body, new Set(locals));
      case "ReturnStmt":
        return stmt.value === null ? null : exprReason(stmt.value, locals);
      case "ExprStmt":
        return exprReason(stmt.expr, locals);
      case "UseStmt":
        return "loads a module";
      case "SceneDecl":
      case "LayerDecl":
      case "EventDecl":
        return "contains a nested declaration";
      case "FillStmt":
        return exprReason(stmt.ch, locals);
      case "PutStmt":
        if (stmt.depth !== null) return "uses depth testing";
        // The mask is an expression like any other, and it is the whole reason a
        // masked layer is usually dynamic. Not reading it here would let a layer
        // drawn through a live mask be cached — the §9.1 silent-wrong-picture bug.
        return exprReason(stmt.text, locals) ??
          exprReason(stmt.at, locals) ??
          (stmt.mask === null ? null : exprReason(stmt.mask, locals));
      case "TextStmt":
        return exprReason(stmt.text, locals) ?? exprReason(stmt.at, locals);
      case "BoxStmt":
      case "BorderStmt":
      case "LineStmt":
        return exprReason(stmt.from, locals) ?? exprReason(stmt.to, locals);
      case "SpriteStmt": {
        if (stmt.props.some((prop) => prop.name === "frames")) return "uses animated sprite frames";
        let reason = exprReason(stmt.path, locals) ?? exprReason(stmt.at, locals);
        if (reason !== null) return reason;
        for (const prop of stmt.props) {
          if (prop.name === "anchor" && prop.value.kind === "Ident") continue;
          reason = exprReason(prop.value, locals);
          if (reason !== null) return reason;
        }
        return null;
      }
      // A tone and a shade were once dynamic UNCONDITIONALLY, which was never a claim
      // about their arguments: it stood in for the fact that evaluating them REGISTERS
      // something, and a reused layer used to lose whatever it registered. §11.20 moved
      // that onto the layer value, so the exclusion has nothing left to protect and
      // these are judged on their inputs like every other statement.
      //
      // A shade spec carries no time — `applyShades` takes `gameTime` at application —
      // so an animated shade with constant arguments is genuinely static, and replaying
      // its spec still animates.
      case "ToneStmt": {
        let reason = exprReason(stmt.freq, locals);
        if (reason !== null) return reason;
        for (const prop of stmt.args) {
          if (isBareVocabulary(prop.value, locals)) continue;
          reason = exprReason(prop.value, locals);
          if (reason !== null) return reason;
        }
        return null;
      }
      case "ShadeStmt": {
        // The shade's name is bare vocabulary (`shade grade`), inert exactly as a bare
        // colour name is in ColorStmt below.
        let reason = isBareVocabulary(stmt.name, locals) ? null : exprReason(stmt.name, locals);
        if (reason !== null) return reason;
        for (const prop of stmt.args) {
          if (isBareVocabulary(prop.value, locals)) continue;
          reason = exprReason(prop.value, locals);
          if (reason !== null) return reason;
        }
        return null;
      }
      case "CanvasDecl":
        return exprReason(stmt.at, locals);
      case "ColorStmt":
        for (const prop of stmt.props) {
          // Bare colour names are inert vocabulary, as in the main analyzer walk.
          if (
            prop.value.kind === "Ident" ||
            (prop.value.kind === "BinOp" &&
              prop.value.op === "-" &&
              prop.value.left.kind === "Ident" &&
              prop.value.right.kind === "Ident")
          ) continue;
          const reason = exprReason(prop.value, locals);
          if (reason !== null) return reason;
        }
        return null;
      case "ZStmt":
      case "VisibleStmt":
        return exprReason(stmt.value, locals);
      case "BreakStmt":
      case "ContinueStmt":
      case "ErrorStmt":
        return null;
    }
  };

  function blockReason(block: Block, locals: Set<string>): string | null {
    for (const stmt of block.statements) {
      const reason = stmtReason(stmt, locals);
      if (reason !== null) return reason;
    }
    return null;
  }

  const layers: LayerDecl[] = [];
  for (const stmt of program.body) {
    if (stmt.kind === "SceneDecl" && stmt.body !== null) {
      for (const nested of stmt.body.statements) {
        if (nested.kind === "LayerDecl") layers.push(nested);
      }
    } else if (stmt.kind === "LayerDecl") {
      layers.push(stmt);
    }
  }

  // Every top-level name reachable from a node, following calls into the functions
  // declared above. Walks the raw AST rather than re-implementing the expression
  // grammar: a node shape this misses would be a name silently dropped, and a dropped
  // name is a layer held stale -- the exact §14 failure this whole cache class risks.
  const collectReads = (node: unknown, into: Set<string>, seen: Set<string>): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) collectReads(item, into, seen);
      return;
    }
    const n = node as { kind?: string; name?: string };
    if ((n.kind === "Ident" || n.kind === "Call") && typeof n.name === "string") {
      if (top.has(n.name)) into.add(n.name);
      const fn = funcs.get(n.name);
      if (fn !== undefined && !seen.has(n.name)) {
        seen.add(n.name);
        collectReads(fn.body, into, seen);
      }
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectReads(value, into, seen);
    }
  };

  return layers.map((layer) => {
    deterministicRngs.clear();
    const reason = exprReason(layer.z, new Set()) ??
      (layer.at === null ? null : exprReason(layer.at, new Set())) ??
      blockReason(layer.body, new Set());
    const reads = new Set<string>();
    collectReads(layer.z, reads, new Set());
    if (layer.at !== null) collectReads(layer.at, reads, new Set());
    collectReads(layer.body, reads, new Set());
    // The same walk again, with name-reads silenced. `deterministicRngs` is rebuilt by
    // the walk itself, so it is cleared first exactly as it was for the first pass.
    deterministicRngs.clear();
    ignoreNameReads = true;
    const untracked = exprReason(layer.z, new Set()) ??
      (layer.at === null ? null : exprReason(layer.at, new Set())) ??
      blockReason(layer.body, new Set());
    ignoreNameReads = false;
    return {
      layer,
      name: layer.name,
      static: reason === null,
      reason: reason ?? "proven stable",
      reads,
      readTracked: untracked === null,
      untracked,
    };
  });
}

/** Exposed for a regression test: every native reached from layer syntax is classified. */
export function unclassifiedLayerNatives(program: Program): string[] {
  return [...layerNativesCalled(program)]
    .filter((name) => name !== "rng" && !isStableLayerNative(name) && !isVolatileLayerNative(name))
    .sort();
}

export function formatLayerStaticityReport(layers: readonly LayerStaticity[]): string[] {
  return layers.map(
    (layer) => `layer ${layer.name}: ${layer.static ? "static" : "dynamic"} — ${layer.reason}`,
  );
}

class Scope {
  readonly declared = new Set<string>();
  readonly symbols = new Map<string, Sym>();
}

function loadModuleExports(
  target: string,
  useStmt: { path: string; span: Span },
  problems: QbskError[],
): Set<string> {
  let source: string;
  try {
    source = readFileSync(target, "utf8");
  } catch {
    problems.push(
      new QbskError(
        `cannot load module '${useStmt.path}': file not found`,
        useStmt.span,
        "semantic",
      ),
    );
    return new Set();
  }
  // The EXTENSION picks the loader, exactly as it does at run time (docs/language.md
  // §12). Doing it here as well means `qbsk check` validates a data file — its shape
  // included — without running a single line of anything.
  if (extname(target) === ".qbdata") {
    const data = loadQbdata(source, target);
    for (const err of data.errors) {
      problems.push(
        new QbskError(
          `in '${useStmt.path}' line ${err.span.start.line}: ${err.message}`,
          useStmt.span,
          "semantic",
        ),
      );
    }
    return new Set(data.entries.keys());
  }
  const parsed = parse(source, target);
  if (parsed.errors.length > 0) {
    problems.push(
      new QbskError(`syntax error in module '${useStmt.path}'`, useStmt.span, "semantic"),
    );
    return new Set();
  }
  const exports = new Set<string>();
  for (const stmt of parsed.ast.body) {
    if (stmt.kind === "ConstDecl" && stmt.exported) {
      exports.add(stmt.name);
    } else if (stmt.kind === "FuncDecl" && stmt.exported) {
      exports.add(stmt.name);
    }
  }
  return exports;
}

export function analyzeProgram(program: Program, file: string, baseDir?: string): QbskError[] {
  const problems: QbskError[] = [];
  const rootDir = baseDir ?? dirname(file);
  const scopes: Scope[] = [new Scope()];
  const moduleScope = scopes[0]!;

  // Pre-pass: seed the module scope with all top-level names (hoisted for lookup so
  // forward references resolve). Duplicate var/const/func definitions are reported
  // later by the walk (exactly once, via `declared`); duplicate `use` aliases are
  // legal at runtime (idempotent same-module re-bind), so only a collision between a
  // `use` alias and an existing top-level name is reported here.
  for (const stmt of program.body) {
    switch (stmt.kind) {
      case "VarDecl":
      case "ConstDecl":
        if (!moduleScope.symbols.has(stmt.name)) {
          moduleScope.symbols.set(stmt.name, {
            kind: stmt.kind === "VarDecl" ? "var" : "const",
            params: 0,
            exports: null,
            moduleName: null,
          });
        }
        break;
      case "FuncDecl":
        if (!moduleScope.symbols.has(stmt.name)) {
          moduleScope.symbols.set(stmt.name, {
            kind: "func",
            params: stmt.params.length,
            exports: null,
            moduleName: null,
          });
        }
        break;
      case "UseStmt": {
        const target = resolve(rootDir, stmt.path);
        const stem = basename(target, extname(target));
        const alias = stmt.alias ?? stem;
        if (moduleScope.symbols.has(alias)) {
          problems.push(
            new QbskError(
              `variable '${alias}' is already defined in this scope`,
              stmt.span,
              "semantic",
            ),
          );
        } else {
          moduleScope.symbols.set(alias, {
            kind: "module",
            params: 0,
            exports: loadModuleExports(target, stmt, problems),
            moduleName: stem,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const error = (message: string, span: Span): void => {
    problems.push(new QbskError(message, span, "semantic"));
  };

  const lookup = (name: string): Sym | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const sym = scopes[i]!.symbols.get(name);
      if (sym !== undefined) {
        return sym;
      }
    }
    return undefined;
  };

  const candidateNames = (): string[] => {
    const names = new Set<string>();
    for (const scope of scopes) {
      for (const n of scope.symbols.keys()) names.add(n);
    }
    for (const n of NATIVE_NAMES) names.add(n);
    return [...names];
  };

  const hint = (name: string, candidates: Iterable<string>): string => {
    const best = closest(name, candidates);
    return best === null ? "" : ` — did you mean '${best}'?`;
  };

  const moduleSym = (e: Expr): Sym | undefined => {
    if (e.kind === "Ident") {
      const sym = lookup(e.name);
      return sym !== undefined && sym.kind === "module" ? sym : undefined;
    }
    return undefined;
  };

  const walkExpr = (e: Expr): void => {
    switch (e.kind) {
      case "BinOp":
        walkExpr(e.left);
        walkExpr(e.right);
        return;
      case "Unary":
        walkExpr(e.operand);
        return;
      case "Call": {
        if (e.callee.kind === "Ident") {
          const name = e.callee.name;
          const sym = lookup(name);
          if (sym === undefined && !NATIVE_NAMES.has(name)) {
            error(
              `variable '${name}' is not defined${hint(name, candidateNames())}`,
              e.span,
            );
          } else if (sym !== undefined && sym.kind === "module") {
            error(`'${name}' is not a function`, e.span);
          } else if (sym !== undefined && sym.kind === "func" && sym.params !== e.args.length) {
            error(
              `function '${name}' expects ${sym.params} arguments, got ${e.args.length}`,
              e.span,
            );
          }
        }
        walkExpr(e.callee);
        for (const arg of e.args) walkExpr(arg);
        for (const named of e.namedArgs) walkExpr(named.value);
        return;
      }
      case "Member": {
        const mod = moduleSym(e.object);
        if (mod !== null && mod !== undefined && mod.exports !== null && !mod.exports.has(e.name)) {
          error(
            `module '${mod.moduleName}' has no exported member '${e.name}'${hint(e.name, mod.exports)}`,
            e.span,
          );
        }
        walkExpr(e.object);
        return;
      }
      case "Lit":
        return;
      case "Ident": {
        if (lookup(e.name) === undefined && !NATIVE_NAMES.has(e.name)) {
          error(
            `variable '${e.name}' is not defined${hint(e.name, candidateNames())}`,
            e.span,
          );
        }
        return;
      }
      case "ListLit":
        for (const item of e.items) walkExpr(item);
        return;
      case "DictLit":
        for (const entry of e.entries) walkExpr(entry.value);
        return;
      case "Index":
        walkExpr(e.object);
        walkExpr(e.index);
        return;
      case "Tuple":
        walkExpr(e.x);
        walkExpr(e.y);
        return;
      case "InterpolatedStr":
        for (const part of e.parts) {
          if (typeof part !== "string") walkExpr(part);
        }
        return;
      case "Lambda": {
        // §6.3: the lambda's params live in their own scope; the body is one
        // expression walked inside it, so an unknown name in the body reports and
        // a param never leaks out.
        scopes.push(new Scope());
        for (const p of e.params) {
          scopes[scopes.length - 1]!.symbols.set(p.name, {
            kind: "var",
            params: 0,
            exports: null,
            moduleName: null,
          });
          scopes[scopes.length - 1]!.declared.add(p.name);
        }
        walkExpr(e.body);
        scopes.pop();
        return;
      }
      case "ErrorExpr":
        return;
    }
  };

  const define = (name: string, sym: Sym, span: Span): void => {
    const scope = scopes[scopes.length - 1]!;
    if (scope.declared.has(name)) {
      error(`variable '${name}' is already defined in this scope`, span);
      return;
    }
    scope.declared.add(name);
    if (!scope.symbols.has(name)) {
      scope.symbols.set(name, sym);
    }
  };

  const walkBlock = (b: Block): void => {
    scopes.push(new Scope());
    for (const stmt of b.statements) walkStmt(stmt);
    scopes.pop();
  };

  // DSL positions that accept inert names (colors, anchors: cyan, bright-yellow,
  // center...) — the interpreter's evalDslExpr keeps bare idents and ident-ident
  // hyphens as raw names, so undefined names there are valid, not problems.
  const walkDslValue = (e: Expr): void => {
    if (e.kind === "Ident") return;
    if (
      e.kind === "BinOp" &&
      e.op === "-" &&
      e.left.kind === "Ident" &&
      e.right.kind === "Ident"
    ) {
      return;
    }
    walkExpr(e);
  };

  // an earlier release (spec language.md §7.1b/§7.5): `visible:`/`color:`/`z:` are STATE
  // DIRECTIVES for the primitives that follow them in the same layer — never
  // layer-level guards. A directive written at the END of a layer, or overwritten
  // by a later directive of the same kind before any primitive, reaches nothing:
  // a silent failure (`qbsk run` paints nothing wrong, the directive just does
  // nothing). This scan mirrors evalLayerValue: directives set state, drawing
  // primitives consume it, and leftover state is reported.
  // Since §11.11 a layer draws from nested blocks too, so the directive scan has to
  // see through them or it reports a live `color:` above a loop as dead — and a false
  // report is worse than none, because it teaches the wrong rule.
  //
  // Deliberately CONSERVATIVE: any statement containing a call is assumed to draw,
  // since a drawing function cannot be recognised statically. Missing a genuinely
  // dead directive costs nothing; inventing one sends the author to fix working code.
  const mayDraw = (stmt: Stmt): boolean => {
    switch (stmt.kind) {
      case "PutStmt":
      case "TextStmt":
      case "FillStmt":
      case "BoxStmt":
      case "BorderStmt":
      case "LineStmt":
      case "SpriteStmt":
      case "ToneStmt":
      case "ShadeStmt":
      case "CanvasDecl":
        return true;
      case "WhileStmt":
        return stmt.body.statements.some(mayDraw);
      case "ForRange":
      case "ForList":
        // Same rule as WhileStmt. Missing before L2's turns.qbsk rewrite: a layer
        // drawing from a `for` body reported its live `color:` as dead.
        return stmt.body.statements.some(mayDraw);
      case "IfStmt":
        return (
          stmt.branches.some((b) => b.body.statements.some(mayDraw)) ||
          (stmt.elseBody !== null && stmt.elseBody.statements.some(mayDraw))
        );
      case "MatchStmt":
        return (
          stmt.arms.some((a) => a.body.statements.some(mayDraw)) ||
          (stmt.elseBody !== null && stmt.elseBody.statements.some(mayDraw))
        );
      case "TryStmt":
        return (
          stmt.tryBody.statements.some(mayDraw) ||
          stmt.catchBody.statements.some(mayDraw)
        );
      case "ExprStmt":
        return callsSomething(stmt.expr);
      case "VarDecl":
      case "ConstDecl":
        return stmt.init !== null && callsSomething(stmt.init);
      default:
        return false;
    }
  };

  const callsSomething = (e: Expr): boolean => {
    switch (e.kind) {
      case "Call":
        return true;
      case "BinOp":
        return callsSomething(e.left) || callsSomething(e.right);
      case "Unary":
        return callsSomething(e.operand);
      case "Index":
        return callsSomething(e.object) || callsSomething(e.index);
      default:
        return false;
    }
  };

  const reportDeadDirectives = (body: Block): void => {
    const deadVisibleMsg =
      "this 'visible:' never reaches a primitive — 'visible:' gates every primitive below it in the layer, so one written after its primitives, or overwritten before any, does nothing; place it before the primitives it should gate";
    const deadZMsg =
      "this 'z:' never reaches a primitive — 'z:' orders every primitive below it in the layer, so one written after its primitives, or overwritten before any, does nothing; place it before the primitives it should order";
    const deadColorMsg =
      "this 'color:' never reaches a primitive — 'color:' styles every primitive below it in the layer, so one written after its primitives, or whose keys are overwritten before any primitive, does nothing; place it before the primitives it should style";

    let visible: VisibleStmt | null = null;
    let z: ZStmt | null = null;
    // A color owns the keys it sets; each later color overwriting one of those
    // keys decrements the owner. Only when ALL its keys are overwritten is the
    // color dead — a surviving key still styles the primitives below.
    const colorOwners = new Map<string, { stmt: ColorStmt; remaining: number }>();

    const clearPending = (): void => {
      visible = null;
      z = null;
      colorOwners.clear();
    };

    const reportPending = (): void => {
      if (visible !== null) {
        error(deadVisibleMsg, visible.span);
      }
      if (z !== null) {
        error(deadZMsg, z.span);
      }
      for (const owner of colorOwners.values()) {
        error(deadColorMsg, owner.stmt.span);
      }
      clearPending();
    };

    for (const stmt of body.statements) {
      switch (stmt.kind) {
        case "VisibleStmt":
          if (visible !== null) {
            error(deadVisibleMsg, visible.span);
          }
          visible = stmt;
          break;
        case "ZStmt":
          if (z !== null) {
            error(deadZMsg, z.span);
          }
          z = stmt;
          break;
        case "ColorStmt": {
          const keys = new Set(stmt.props.map((p) => p.name));
          for (const key of keys) {
            const prev = colorOwners.get(key);
            if (prev !== undefined) {
              prev.remaining -= 1;
              if (prev.remaining === 0) {
                error(deadColorMsg, prev.stmt.span);
                for (const [k, o] of colorOwners) {
                  if (o === prev) colorOwners.delete(k);
                }
              }
            }
            colorOwners.set(key, { stmt, remaining: keys.size });
          }
          break;
        }
        case "PutStmt":
        case "TextStmt":
        case "FillStmt":
        case "BoxStmt":
        case "BorderStmt":
        case "LineStmt":
        case "SpriteStmt":
        case "ToneStmt":
        case "ShadeStmt":
        case "CanvasDecl":
          clearPending();
          break;
        default:
          // A nested block can draw too (docs/engine.md §11.11), so a directive
          // above a loop is not dead — it styles everything the loop draws.
          if (mayDraw(stmt)) {
            clearPending();
          }
          break;
      }
    }
    reportPending();
  };

  const walkStmt = (s: Stmt): void => {
    switch (s.kind) {
      case "VarDecl":
        if (s.init) walkExpr(s.init);
        define(s.name, { kind: "var", params: 0, exports: null, moduleName: null }, s.span);
        return;
      case "ConstDecl":
        if (s.init) walkExpr(s.init);
        define(s.name, { kind: "const", params: 0, exports: null, moduleName: null }, s.span);
        return;
      case "FuncDecl": {
        define(s.name, { kind: "func", params: s.params.length, exports: null, moduleName: null }, s.span);
        scopes.push(new Scope());
        for (const p of s.params) {
          scopes[scopes.length - 1]!.symbols.set(p.name, {
            kind: "var",
            params: 0,
            exports: null,
            moduleName: null,
          });
          scopes[scopes.length - 1]!.declared.add(p.name);
        }
        for (const stmt of s.body.statements) walkStmt(stmt);
        scopes.pop();
        return;
      }
      case "Assign": {
        if (s.target.kind === "Ident") {
          const name = s.target.name;
          const sym = lookup(name);
          if (sym === undefined) {
            if (NATIVE_NAMES.has(name)) {
              error(`cannot reassign to '${name}'`, s.span);
            } else {
              error(
                `variable '${name}' is not defined${hint(name, candidateNames())}`,
                s.span,
              );
            }
          } else if (sym.kind === "const" || sym.kind === "module") {
            error(`cannot reassign to constant '${name}'`, s.span);
          }
        } else if (s.target.kind === "Member") {
          const mod = moduleSym(s.target.object);
          if (mod !== undefined) {
            error("modules are immutable: you cannot assign to a module member", s.span);
          } else {
            walkExpr(s.target.object);
          }
        } else if (s.target.kind === "Index") {
          walkExpr(s.target.object);
          walkExpr(s.target.index);
        }
        walkExpr(s.value);
        return;
      }
      case "IfStmt":
        for (const branch of s.branches) {
          walkExpr(branch.cond);
          walkBlock(branch.body);
        }
        if (s.elseBody) walkBlock(s.elseBody);
        return;
      case "MatchStmt":
        walkExpr(s.subject);
        for (const arm of s.arms) {
          walkExpr(arm.pattern);
          walkBlock(arm.body);
        }
        if (s.elseBody) walkBlock(s.elseBody);
        return;
      case "TryStmt":
        walkBlock(s.tryBody);
        scopes.push(new Scope());
        scopes[scopes.length - 1]!.symbols.set(s.catchParam, {
          kind: "var",
          params: 0,
          exports: null,
          moduleName: null,
        });
        scopes[scopes.length - 1]!.declared.add(s.catchParam);
        for (const stmt of s.catchBody.statements) walkStmt(stmt);
        scopes.pop();
        return;
      case "ForRange":
        walkExpr(s.from);
        walkExpr(s.to);
        scopes.push(new Scope());
        define(s.name, { kind: "var", params: 0, exports: null, moduleName: null }, s.span);
        for (const stmt of s.body.statements) walkStmt(stmt);
        scopes.pop();
        return;
      case "ForList":
        walkExpr(s.iterable);
        scopes.push(new Scope());
        if (s.indexName !== null) {
          define(s.indexName, { kind: "var", params: 0, exports: null, moduleName: null }, s.span);
        }
        define(s.name, { kind: "var", params: 0, exports: null, moduleName: null }, s.span);
        for (const stmt of s.body.statements) walkStmt(stmt);
        scopes.pop();
        return;
      case "WhileStmt":
        walkExpr(s.cond);
        walkBlock(s.body);
        return;
      case "BreakStmt":
      case "ContinueStmt":
        return;
      case "ReturnStmt":
        if (s.value) walkExpr(s.value);
        return;
      case "ExprStmt":
        walkExpr(s.expr);
        return;
      case "UseStmt":
        return;
      case "SceneDecl":
        for (const p of s.params) walkExpr(p.value);
        if (s.body) walkBlock(s.body);
        return;
      case "LayerDecl":
        walkExpr(s.z);
        if (s.at) walkExpr(s.at);
        walkBlock(s.body);
        reportDeadDirectives(s.body);
        return;
      case "EventDecl":
        // A key name that no host can ever deliver is a handler that silently never
        // fires — indistinguishable from one that was simply not pressed. That is the
        // silent-ghost failure shape catalogued in docs/language.md §14. The parser
        // accepts any string, so this is the only place it can be caught before the
        // game just doesn't respond.
        if (s.event === "key" && s.keyName !== null && !isCanonicalKey(s.keyName)) {
          const suggestion = suggestKey(s.keyName);
          error(
            `'${s.keyName}' is not a key name, so this handler can never fire` +
              (suggestion !== null
                ? ` — did you mean '${suggestion}'?`
                : `; valid names are '${NAMED_KEYS.slice(0, 5).join("', '")}'... or a single character like 'a'`),
            s.span,
          );
        }
        // The guard (§6.6) is evaluated in the TOP-LEVEL env at dispatch — the
        // handler's params do not exist yet. Walked OUTSIDE the handler scope so
        // `when dt > 0` reports here instead of failing at the first keypress.
        if (s.guard) walkExpr(s.guard);
        scopes.push(new Scope());
        for (const p of s.params) {
          scopes[scopes.length - 1]!.symbols.set(p.name, {
            kind: "var",
            params: 0,
            exports: null,
            moduleName: null,
          });
          scopes[scopes.length - 1]!.declared.add(p.name);
        }
        for (const stmt of s.body.statements) walkStmt(stmt);
        scopes.pop();
        return;
      case "FillStmt":
        walkExpr(s.ch);
        return;
      case "PutStmt":
        walkExpr(s.text);
        walkExpr(s.at);
        // §15.7 — `depth:` is an expression like any other. It was never walked, so an
        // undefined variable in it passed `check` and failed at run time: the checker
        // said the program was fine about a line that could not work.
        if (s.depth) walkExpr(s.depth);
        if (s.mask) walkExpr(s.mask);
        return;
      case "ToneStmt":
        walkExpr(s.freq);
        for (const a of s.args) walkDslValue(a.value);
        return;
      case "ShadeStmt":
        walkDslValue(s.name);
        for (const a of s.args) walkDslValue(a.value);
        return;
      case "BoxStmt":
        walkExpr(s.from);
        walkExpr(s.to);
        return;
      case "BorderStmt":
        walkExpr(s.from);
        walkExpr(s.to);
        return;
      case "LineStmt":
        walkExpr(s.from);
        walkExpr(s.to);
        return;
      case "TextStmt":
        walkExpr(s.text);
        walkExpr(s.at);
        return;
      case "SpriteStmt":
        walkExpr(s.path);
        walkExpr(s.at);
        for (const p of s.props) walkDslValue(p.value);
        return;
      case "CanvasDecl":
        walkExpr(s.at);
        return;
      case "ColorStmt":
        for (const p of s.props) walkDslValue(p.value);
        return;
      case "ZStmt":
      case "VisibleStmt":
        walkExpr(s.value);
        return;
      case "ErrorStmt":
        return;
    }
  };

  for (const stmt of program.body) {
    walkStmt(stmt);
  }

  return problems;
}
