import type { Span } from "../lexer/token.js";

export interface NamedArg {
  name: string;
  value: Expr;
  span: Span;
}

export type Expr =
  | { kind: "BinOp"; op: string; left: Expr; right: Expr; span: Span }
  | { kind: "Unary"; op: string; operand: Expr; span: Span }
  | { kind: "Call"; callee: Expr; args: Expr[]; namedArgs: NamedArg[]; span: Span }
  | { kind: "Member"; object: Expr; name: string; span: Span }
  | {
      kind: "Lit";
      litKind: "int" | "float" | "str" | "bool" | "null";
      value: number | string | boolean | null;
      span: Span;
    }
  | { kind: "Ident"; name: string; span: Span }
  | { kind: "ListLit"; items: Expr[]; span: Span }
  | { kind: "DictLit"; entries: { key: string; value: Expr; span: Span }[]; span: Span }
  | { kind: "Index"; object: Expr; index: Expr; span: Span }
  | { kind: "Tuple"; x: Expr; y: Expr; span: Span }
  | { kind: "InterpolatedStr"; parts: (string | Expr)[]; span: Span }
  // L2 (docs/language.md §6.3): anonymous single-expression function. Evaluates to
  // an ordinary func value whose body is a synthesized `return body` block, so
  // closures, arity checks and call errors need no second code path.
  | { kind: "Lambda"; params: Param[]; body: Expr; span: Span }
  | { kind: "ErrorExpr"; message: string; span: Span };

export interface Block {
  kind: "Block";
  statements: Stmt[];
  span: Span;
}

export type Stmt =
  | VarDecl
  | ConstDecl
  | FuncDecl
  | Assign
  | IfStmt
  | MatchStmt
  | TryStmt
  | ForRange
  | ForList
  | WhileStmt
  | BreakStmt
  | ContinueStmt
  | ReturnStmt
  | ExprStmt
  | UseStmt
  | SceneDecl
  | LayerDecl
  | EventDecl
  | FillStmt
  | PutStmt
  | BoxStmt
  | BorderStmt
  | LineStmt
  | TextStmt
  | SpriteStmt
  | ToneStmt
  | ShadeStmt
  | CanvasDecl
  | ColorStmt
  | ZStmt
  | VisibleStmt
  | ErrorStmt;

export interface VarDecl {
  kind: "VarDecl";
  name: string;
  nameSpan: Span;
  typeAnnot: string | null;
  init: Expr | null;
  exported: boolean;
  span: Span;
}

export interface ConstDecl {
  kind: "ConstDecl";
  name: string;
  nameSpan: Span;
  typeAnnot: string | null;
  init: Expr | null;
  exported: boolean;
  span: Span;
}

export interface Param {
  name: string;
  typeAnnot: string | null;
  /**
   * The expression to use when the argument is not given (15.21), or null when the
   * parameter is required.
   *
   * The EXPRESSION and not a value, deliberately: it is evaluated at every call that
   * omits the argument, so `into = []` is a fresh list each time. Holding a value here
   * would be the declaration-time model, in which every call shares one list.
   */
  defaultValue: Expr | null;
  span: Span;
}

export interface FuncDecl {
  kind: "FuncDecl";
  name: string;
  params: Param[];
  returnAnnot: string | null;
  body: Block;
  exported: boolean;
  span: Span;
}

export interface Assign {
  kind: "Assign";
  target: Expr;
  op: "=" | "+=" | "-=";
  value: Expr;
  span: Span;
}

export interface IfBranch {
  cond: Expr;
  body: Block;
  span: Span;
}

export interface IfStmt {
  kind: "IfStmt";
  branches: IfBranch[];
  elseBody: Block | null;
  span: Span;
}

export interface MatchArm {
  pattern: Expr;
  body: Block;
  span: Span;
}

export interface MatchStmt {
  kind: "MatchStmt";
  subject: Expr;
  arms: MatchArm[];
  elseBody: Block | null;
  span: Span;
}

export interface TryStmt {
  kind: "TryStmt";
  tryBody: Block;
  catchParam: string;
  catchBody: Block;
  span: Span;
}

export interface ForRange {
  kind: "ForRange";
  name: string;
  from: Expr;
  to: Expr;
  body: Block;
  /** The name this loop carries (§15.22), or null. See `WhileStmt.label`. */
  label: string | null;
  span: Span;
}

export interface ForList {
  kind: "ForList";
  /** The ELEMENT binding — in both forms (docs/language.md §6.2). */
  name: string;
  /**
   * L2 (docs/language.md §6.2): the INDEX binding when `for i, item in list` is
   * written (`i` lands here, `item` in `name`). Null in the single-name form, which
   * is unchanged.
   */
  indexName: string | null;
  iterable: Expr;
  body: Block;
  /** The name this loop carries (§15.22), or null. See `WhileStmt.label`. */
  label: string | null;
  span: Span;
}

export interface WhileStmt {
  kind: "WhileStmt";
  cond: Expr;
  body: Block;
  /**
   * The name this loop carries (§15.22), or null when it has none.
   *
   * A NAME and not a depth. `break 2` was the other candidate: the number is silently
   * wrong the moment a loop is added between the break and its target, and nothing in
   * the program says so.
   */
  label: string | null;
  span: Span;
}

export interface BreakStmt {
  kind: "BreakStmt";
  /**
   * The loop this leaves (§15.22), or null for the innermost one.
   *
   * Anchored to the physical line at parse time: there is no end-of-line token, so
   * `break` with a name one line below looks exactly like `break name` without it.
   */
  label: string | null;
  span: Span;
}

export interface ContinueStmt {
  kind: "ContinueStmt";
  /** The loop this restarts (§15.22), or null for the innermost one. */
  label: string | null;
  span: Span;
}

export interface ReturnStmt {
  kind: "ReturnStmt";
  value: Expr | null;
  span: Span;
}

export interface ExprStmt {
  kind: "ExprStmt";
  expr: Expr;
  span: Span;
}

export interface UseStmt {
  kind: "UseStmt";
  path: string;
  alias: string | null;
  span: Span;
}

export interface SceneDecl {
  kind: "SceneDecl";
  name: string;
  params: NamedArg[];
  body: Block | null;
  span: Span;
}

export interface LayerDecl {
  kind: "LayerDecl";
  name: string;
  z: Expr;
  at: Expr | null;
  body: Block;
  span: Span;
}

export type EventKind = "start" | "tick" | "turn" | "key" | "resize";

export interface EventDecl {
  kind: "EventDecl";
  event: EventKind;
  params: Param[];
  keyName: string | null;
  /**
   * L3 (docs/language.md §6.6): `on ... when expr` — the handler runs only when
   * this is truthy at dispatch time. Null = unguarded, always runs.
   */
  guard: Expr | null;
  body: Block;
  span: Span;
}

export interface FillStmt {
  kind: "FillStmt";
  ch: Expr;
  span: Span;
}

export interface PutStmt {
  kind: "PutStmt";
  text: Expr;
  at: Expr;
  // M16: true = the position is world (absolute), not local
  world: boolean;
  /**
   * Optional depth (docs/engine.md §11.8). When present the glyphs are depth-tested
   * per cell, so a nearer one wins over a further one wherever they collide. Absent
   * means not depth-tested at all — the composition is unchanged, byte for byte.
   */
  depth: Expr | null;
  /**
   * Optional visibility mask (docs/engine.md §11.12). When present, `text` is a list
   * of rows rather than one line, and a row's cell is drawn only where the mask's
   * matching cell is not a space. Absent means the ordinary one-line `put`.
   */
  mask: Expr | null;
  span: Span;
}

export interface BoxStmt {
  kind: "BoxStmt";
  from: Expr;
  to: Expr;
  style: string | null;
  span: Span;
}

export interface BorderStmt {
  kind: "BorderStmt";
  from: Expr;
  to: Expr;
  style: string | null;
  span: Span;
}

export interface LineStmt {
  kind: "LineStmt";
  from: Expr;
  to: Expr;
  /**
   * Optional stroke style (docs/engine.md §11.16). `"stroke"` picks an orientation
   * glyph per cell from the line's own direction; absent keeps the `*` `line` has
   * always drawn, so every existing scene composes byte for byte.
   */
  style: string | null;
  span: Span;
}

export interface TextStmt {
  kind: "TextStmt";
  text: Expr;
  at: Expr;
  world: boolean;
  span: Span;
}

export interface SpriteStmt {
  kind: "SpriteStmt";
  path: Expr;
  at: Expr;
  world: boolean;
  props: NamedArg[];
  span: Span;
}

/**
 * A `tone` primitive (docs/audio.md §4). It composes like any other primitive —
 * inside a layer or at top level, subject to the per-primitive state directives —
 * but writes no cells: it contributes to the frame's audio plan instead.
 */
/**
 * A `shade` primitive (docs/engine.md §11.6): a per-cell colour transform applied
 * over the composed canvas before diffing. Like `tone` it writes no cells of its
 * own — it re-colours the ones the other primitives painted.
 */
export interface ShadeStmt {
  kind: "ShadeStmt";
  name: Expr;
  args: NamedArg[];
  span: Span;
}

export interface ToneStmt {
  kind: "ToneStmt";
  freq: Expr;
  args: NamedArg[];
  span: Span;
}

export interface CanvasDecl {
  kind: "CanvasDecl";
  name: string;
  at: Expr;
  literal: string;
  span: Span;
}

export interface ColorStmt {
  kind: "ColorStmt";
  props: NamedArg[];
  span: Span;
}

export interface ZStmt {
  kind: "ZStmt";
  value: Expr;
  span: Span;
}

export interface VisibleStmt {
  kind: "VisibleStmt";
  value: Expr;
  span: Span;
}

export interface ErrorStmt {
  kind: "ErrorStmt";
  message: string;
  span: Span;
}

export interface Program {
  kind: "Program";
  body: Stmt[];
  span: Span;
}

export function stmtIsSimple(stmt: Stmt): boolean {
  switch (stmt.kind) {
    case "IfStmt":
    case "MatchStmt":
    case "TryStmt":
    case "ForRange":
    case "ForList":
    case "WhileStmt":
    case "FuncDecl":
    case "SceneDecl":
    case "LayerDecl":
    case "EventDecl":
      return false;
    default:
      return true;
  }
}

export function blockIsSimple(body: Block): boolean {
  return body.statements.length === 1 && stmtIsSimple(body.statements[0]!);
}

function litText(lit: Expr & { kind: "Lit" }): string {
  switch (lit.litKind) {
    case "int":
      return String(lit.value);
    case "float": {
      const n = lit.value as number;
      return Number.isInteger(n) ? `${n}.0` : String(n);
    }
    case "str":
      return JSON.stringify(lit.value);
    case "bool":
      return lit.value ? "true" : "false";
    case "null":
      return "null";
  }
}

export function exprText(expr: Expr): string {
  switch (expr.kind) {
    case "BinOp":
      return `(${expr.op} ${exprText(expr.left)} ${exprText(expr.right)})`;
    case "Unary":
      return `(${expr.op} ${exprText(expr.operand)})`;
    case "Call":
      return `(Call ${exprText(expr.callee)}${expr.args
        .map((a) => ` ${exprText(a)}`)
        .join("")}${expr.namedArgs
        .map((n) => ` (Param ${n.name} ${exprText(n.value)})`)
        .join("")})`;
    case "Member":
      return `(Member ${exprText(expr.object)} ${expr.name})`;
    case "Lit":
      return litText(expr);
    case "Ident":
      return expr.name;
    case "ListLit":
      return `[${expr.items.map((e) => exprText(e)).join(", ")}]`;
    case "DictLit":
      return `{${expr.entries
        .map((e) => `${JSON.stringify(e.key)}: ${exprText(e.value)}`)
        .join(", ")}}`;
    case "Index":
      return `${exprText(expr.object)}[${exprText(expr.index)}]`;
    case "Tuple":
      return `(${exprText(expr.x)}, ${exprText(expr.y)})`;
    case "InterpolatedStr":
      return `(Interp ${expr.parts
        .map((p) => (typeof p === "string" ? JSON.stringify(p) : exprText(p)))
        .join(" ")})`;
    case "Lambda":
      return `(Lambda (${expr.params.map((p) => p.name).join(" ")}) ${exprText(expr.body)})`;
    case "ErrorExpr":
      return `(Err ${JSON.stringify(expr.message)})`;
  }
}

export function pathText(expr: Expr): string {
  switch (expr.kind) {
    case "Ident":
      return expr.name;
    case "Member":
      return `${pathText(expr.object)}.${expr.name}`;
    default:
      return exprText(expr);
  }
}

function namedArgText(arg: NamedArg): string {
  return `(Param ${arg.name} ${exprText(arg.value)})`;
}

/**
 * How a primitive's position was WRITTEN (§14.8). `world: (x, y)` is absolute and
 * `at (x, y)` is layer-relative (§7.3) — two different compositions, so printing
 * both as `at` was not an omission but a wrong answer, and it made the world form
 * unobservable to every test that reads the printed AST.
 */
function posText(world: boolean): string {
  return world ? "world:" : "at";
}

function printStmtInline(stmt: Stmt): string {
  return printStmt(stmt, 0).join(" ");
}

function blockText(body: Block): string {
  if (body.statements.length === 0) {
    return "(Block)";
  }
  return `(Block ${body.statements.map(printStmtInline).join(" ")})`;
}

function closeWith(lines: string[], n: number): string[] {
  lines[lines.length - 1] = lines[lines.length - 1] + ")".repeat(n);
  return lines;
}

function printBlockLines(body: Block, depth: number, forceMulti = false): string[] {
  const ind = "  ".repeat(depth);
  if (body.statements.length === 0) {
    return [`${ind}(Block)`];
  }
  if (!forceMulti && body.statements.every(stmtIsSimple)) {
    return [`${ind}${blockText(body)}`];
  }
  const lines: string[] = [`${ind}(Block`];
  for (const stmt of body.statements) {
    lines.push(...printStmt(stmt, depth + 1));
  }
  return closeWith(lines, 1);
}

export function printStmt(stmt: Stmt, depth: number): string[] {
  const ind = "  ".repeat(depth);
  switch (stmt.kind) {
    case "VarDecl": {
      const annot = stmt.typeAnnot ? ` : ${stmt.typeAnnot}` : "";
      const init = stmt.init ? ` = ${exprText(stmt.init)}` : "";
      const exp = stmt.exported ? "export " : "";
      return [`${ind}(${exp}VarDecl ${stmt.name}${annot}${init})`];
    }
    case "ConstDecl": {
      const annot = stmt.typeAnnot ? ` : ${stmt.typeAnnot}` : "";
      const init = stmt.init ? ` = ${exprText(stmt.init)}` : "";
      const exp = stmt.exported ? "export " : "";
      return [`${ind}(${exp}ConstDecl ${stmt.name}${annot}${init})`];
    }
    case "FuncDecl": {
      const params = stmt.params
        .map(
          (p) =>
            `(Param ${p.name}${p.typeAnnot ? ` ${p.typeAnnot}` : ""}` +
            `${p.defaultValue ? ` = ${exprText(p.defaultValue)}` : ""})`,
        )
        .join(" ");
      const ret = stmt.returnAnnot ? ` -> ${stmt.returnAnnot}` : "";
      const exp = stmt.exported ? "export " : "";
      const lines: string[] = [`${ind}(${exp}FuncDecl ${stmt.name} ${params}${ret}`];
      lines.push(...printBlockLines(stmt.body, depth + 1, true));
      return closeWith(lines, 1);
    }
    case "Assign":
      return [
        `${ind}(Assign ${pathText(stmt.target)} ${stmt.op} ${exprText(stmt.value)})`,
      ];
    case "IfStmt": {
      const inline =
        stmt.branches.length === 1 &&
        stmt.elseBody === null &&
        blockIsSimple(stmt.branches[0]!.body);
      if (inline) {
        const b = stmt.branches[0]!;
        return [
          `${ind}(If (Cond ${exprText(b.cond)}) ${blockText(b.body)})`,
        ];
      }
      const lines: string[] = [`${ind}(If`];
      stmt.branches.forEach((b, i) => {
        if (i === 0) {
          lines.push(`${ind}  (Cond ${exprText(b.cond)})`);
        } else {
          lines.push(`${ind}  (Elif`);
          lines.push(`${ind}    (Cond ${exprText(b.cond)})`);
        }
        lines.push(...printBlockLines(b.body, depth + (i === 0 ? 1 : 2), true));
        if (i > 0) {
          closeWith(lines, 1);
        }
      });
      if (stmt.elseBody) {
        lines.push(`${ind}  (Else`);
        lines.push(...printBlockLines(stmt.elseBody, depth + 2, true));
        closeWith(lines, 1);
      }
      return closeWith(lines, 1);
    }
    case "MatchStmt": {
      const lines: string[] = [`${ind}(Match ${exprText(stmt.subject)}`];
      for (const arm of stmt.arms) {
        lines.push(`${ind}  (Arm ${exprText(arm.pattern)}`);
        lines.push(...printBlockLines(arm.body, depth + 2, true));
        closeWith(lines, 1);
      }
      if (stmt.elseBody) {
        lines.push(`${ind}  (Else`);
        lines.push(...printBlockLines(stmt.elseBody, depth + 2, true));
        closeWith(lines, 1);
      }
      return closeWith(lines, 1);
    }
    case "TryStmt": {
      const lines: string[] = [`${ind}(Try`];
      lines.push(...printBlockLines(stmt.tryBody, depth + 1, true));
      lines.push(`${ind}  (Catch ${stmt.catchParam}`);
      lines.push(...printBlockLines(stmt.catchBody, depth + 2, true));
      return closeWith(lines, 2);
    }
    case "ForRange": {
      const lines: string[] = [
        `${ind}(ForRange ${stmt.name} ${exprText(stmt.from)} ${exprText(stmt.to)}`,
      ];
      lines.push(...printBlockLines(stmt.body, depth + 1, true));
      return closeWith(lines, 1);
    }
    case "ForList": {
      const names = stmt.indexName === null ? stmt.name : `${stmt.indexName} ${stmt.name}`;
      const lines: string[] = [
        `${ind}(ForList ${names} ${exprText(stmt.iterable)}`,
      ];
      lines.push(...printBlockLines(stmt.body, depth + 1, true));
      return closeWith(lines, 1);
    }
    case "WhileStmt": {
      if (blockIsSimple(stmt.body)) {
        return [
          `${ind}(While ${exprText(stmt.cond)} ${blockText(stmt.body)})`,
        ];
      }
      const lines: string[] = [`${ind}(While ${exprText(stmt.cond)}`];
      lines.push(...printBlockLines(stmt.body, depth + 1, true));
      return closeWith(lines, 1);
    }
    case "BreakStmt":
      return [`${ind}(Break${stmt.label === null ? "" : ` ${stmt.label}`})`];
    case "ContinueStmt":
      return [`${ind}(Continue${stmt.label === null ? "" : ` ${stmt.label}`})`];
    case "ReturnStmt":
      return [
        `${ind}(Return${stmt.value ? ` ${exprText(stmt.value)}` : ""})`,
      ];
    case "ExprStmt":
      return [`${ind}(ExprStmt ${exprText(stmt.expr)})`];
    case "UseStmt":
      return [
        `${ind}(Use ${JSON.stringify(stmt.path)}${stmt.alias ? ` as ${stmt.alias}` : ""})`,
      ];
    case "SceneDecl": {
      const params = stmt.params.map(namedArgText).join(" ");
      const head = `${ind}(SceneDecl ${stmt.name} ${params}`;
      if (stmt.body === null) {
        return [`${head})`];
      }
      const lines: string[] = [head];
      lines.push(...printBlockLines(stmt.body, depth + 1, true));
      return closeWith(lines, 1);
    }
    case "LayerDecl": {
      const at = stmt.at === null ? "" : ` (Param at ${exprText(stmt.at)})`;
      const lines: string[] = [
        `${ind}(LayerDecl ${stmt.name} (Param z ${exprText(stmt.z)})${at}`,
      ];
      lines.push(...printBlockLines(stmt.body, depth + 1, true));
      return closeWith(lines, 1);
    }
    case "EventDecl": {
      let head: string;
      switch (stmt.event) {
        case "start":
          head = `${ind}(Event start`;
          break;
        case "tick":
          head = `${ind}(Event tick ${stmt.params
            .map(
              (p) => `(Param ${p.name}${p.typeAnnot ? ` ${p.typeAnnot}` : ""})`,
            )
            .join(" ")}`;
          break;
        case "turn":
          head = `${ind}(Event turn ${stmt.params
            .map((p) => `(Param ${p.name})`)
            .join(" ")}`;
          break;
        case "key":
          head = `${ind}(Event key ${JSON.stringify(stmt.keyName)}`;
          break;
        case "resize":
          head = `${ind}(Event resize ${stmt.params
            .map((p) => `(Param ${p.name})`)
            .join(" ")}`;
          break;
      }
      const lines: string[] = [
        stmt.guard === null ? head : `${head} (When ${exprText(stmt.guard)})`,
      ];
      lines.push(...printBlockLines(stmt.body, depth + 1, true));
      return closeWith(lines, 1);
    }
    case "FillStmt":
      return [`${ind}(Fill ${exprText(stmt.ch)})`];
    case "PutStmt": {
      const depth = stmt.depth === null ? "" : ` depth: ${exprText(stmt.depth)}`;
      const mask = stmt.mask === null ? "" : ` mask: ${exprText(stmt.mask)}`;
      return [
        `${ind}(Put ${exprText(stmt.text)} ${posText(stmt.world)} ${exprText(stmt.at)}${mask}${depth})`,
      ];
    }
    case "BoxStmt": {
      const style = stmt.style ? ` (Param style ${stmt.style})` : "";
      return [
        `${ind}(Box ${exprText(stmt.from)} to ${exprText(stmt.to)}${style})`,
      ];
    }
    case "BorderStmt": {
      const style = stmt.style ? ` (Param style ${stmt.style})` : "";
      return [
        `${ind}(Border ${exprText(stmt.from)} to ${exprText(stmt.to)}${style})`,
      ];
    }
    case "LineStmt": {
      const style = stmt.style === null ? "" : ` style: ${stmt.style}`;
      return [
        `${ind}(Line ${exprText(stmt.from)} to ${exprText(stmt.to)}${style})`,
      ];
    }
    case "TextStmt":
      return [
        `${ind}(Text ${exprText(stmt.text)} ${posText(stmt.world)} ${exprText(stmt.at)})`,
      ];
    case "SpriteStmt": {
      const props = stmt.props.map((p) => ` ${namedArgText(p)}`).join("");
      return [
        `${ind}(Sprite ${exprText(stmt.path)} ${posText(stmt.world)} ${exprText(stmt.at)}${props})`,
      ];
    }
    case "ShadeStmt": {
      const sargs = stmt.args
        .map((p) => ` ${p.name}: ${exprText(p.value)}`)
        .join("");
      return [`${ind}(Shade ${exprText(stmt.name)}${sargs})`];
    }
    case "ToneStmt": {
      const args = stmt.args
        .map((p) => ` ${p.name}: ${exprText(p.value)}`)
        .join("");
      return [`${ind}(Tone ${exprText(stmt.freq)}${args})`];
    }
    case "CanvasDecl":
      return [
        `${ind}(Canvas ${stmt.name} at ${exprText(stmt.at)} ${JSON.stringify(stmt.literal)})`,
      ];
    case "ColorStmt":
      return [`${ind}(Color ${stmt.props.map(namedArgText).join(" ")})`];
    case "ZStmt":
      return [`${ind}(Z ${exprText(stmt.value)})`];
    case "VisibleStmt":
      return [`${ind}(Visible ${exprText(stmt.value)})`];
    case "ErrorStmt":
      return [`${ind}(Error ${JSON.stringify(stmt.message)})`];
  }
}

export function printAst(program: Program): string {
  if (program.body.length === 0) {
    return "(Program)";
  }
  const lines = ["(Program"];
  for (const stmt of program.body) {
    lines.push(...printStmt(stmt, 1));
  }
  return closeWith(lines, 1).join("\n");
}
