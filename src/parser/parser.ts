import { QbskSyntaxError } from "../interp/error.js";
import { tokenize } from "../lexer/lexer.js";
import { closest } from "../util/suggest.js";
import {
  KEYWORDS,
  makeSpan,
  type Span,
  type Token,
  type TokenType,
} from "../lexer/token.js";
import type {
  Block,
  ConstDecl,
  ErrorStmt,
  Expr,
  EventKind,
  NamedArg,
  Param,
  Program,
  Stmt,
  VarDecl,
} from "./ast.js";

export interface ParseResult {
  ast: Program;
  errors: QbskSyntaxError[];
}

const KEYWORD_TO_LEXEME: Record<string, string> = Object.fromEntries(
  Object.entries(KEYWORDS).map(([lexeme, type]) => [type, lexeme]),
);

/**
 * How a token that carries no text is NAMED in an error (§15.8).
 *
 * Punctuation and layout tokens have `value: null`, so the fallback `String(token.value)`
 * printed the literal word `null` — `unexpected expression: 'null'` names nothing the
 * author wrote, and it appeared for a stray `)` as readily as for an INDENT. Keywords
 * already had a reverse table; this is the same idea for everything else.
 */
const PUNCT_TO_LEXEME: Record<string, string> = {
  LPAREN: "(",
  RPAREN: ")",
  LBRACKET: "[",
  RBRACKET: "]",
  LBRACE: "{",
  RBRACE: "}",
  COMMA: ",",
  COLON: ":",
  DOT: ".",
  DOT_DOT: "..",
  PLUS: "+",
  MINUS: "-",
  STAR: "*",
  SLASH: "/",
  PERCENT: "%",
  EQ: "=",
  EQ_EQ: "==",
  BANG: "!",
  BANG_EQ: "!=",
  LT: "<",
  LTE: "<=",
  GT: ">",
  GTE: ">=",
  PLUS_EQ: "+=",
  MINUS_EQ: "-=",
  AMP: "&",
  PIPE: "|",
  CARET: "^",
  SHL: "<<",
  SHR: ">>",
  INTERP_START: "{",
  INTERP_END: "}",
};

// Binary operator precedence (lowest to highest) — spec §4.
const BINARY_PRECEDENCE: Record<string, number> = {
  DOT_DOT: 1,
  OR: 2,
  AND: 3,
  EQ_EQ: 4,
  BANG_EQ: 4,
  LT: 4,
  GT: 4,
  LTE: 4,
  GTE: 4,
  // L4 (docs/language.md §4): bitwise sits between comparisons and arithmetic —
  // Python's ordering. `x & 3 == 1` is `(x & 3) == 1`, never C's trap.
  PIPE: 5,
  CARET: 6,
  AMP: 7,
  SHL: 8,
  SHR: 8,
  PLUS: 9,
  MINUS: 9,
  STAR: 10,
  SLASH: 10,
  PERCENT: 10,
};

const BINARY_LEXEMES: Record<string, string> = {
  PLUS: "+",
  MINUS: "-",
  STAR: "*",
  SLASH: "/",
  PERCENT: "%",
  EQ_EQ: "==",
  BANG_EQ: "!=",
  LT: "<",
  GT: ">",
  LTE: "<=",
  GTE: ">=",
  AND: "and",
  OR: "or",
  DOT_DOT: "..",
  PIPE: "|",
  CARET: "^",
  AMP: "&",
  SHL: "<<",
  SHR: ">>",
};

const VALUE_STARTS = new Set<TokenType>([
  "STRING",
  "INT",
  "FLOAT",
  "BOOLEAN",
  "NULL",
  "IDENTIFIER",
  "LPAREN",
  "LBRACKET",
  "LBRACE",
  "MINUS",
  "BANG",
  "NOT",
  // L2 (§6.3): a lambda can start a value (`return func(n) n * 2`). Statement-level
  // `func name(...)` is dispatched to parseFuncDecl before any expression path, so
  // this cannot capture a declaration.
  "FUNC",
  // The scene words (see NAMEABLE_DSL_TOKENS). `return at * 2` has to see a value where
  // `at` stands, or a function whose parameter is called `at` returns null from a body
  // that plainly computes something. The DSL's own positions are reached from inside a
  // primitive and never through here.
  //
  // Listed rather than spread from the set, because the set is declared further down and
  // a `const` cannot be read before it. The count is asserted by
  // `tests/unit/contextual-keywords.test.ts`, so the two cannot drift apart in silence.
  "AT",
  "FROM",
  "TO",
  "STYLE",
  "WORLD",
  "START",
  "TICK",
  "KEY",
  "RESIZE",
  "SCENE",
  "LAYER",
  "ON",
  "SPRITE",
  "BOX",
  "BORDER",
  "LINE",
  "TEXT",
  "TONE",
  "SHADE",
  "FILL",
  "PUT",
  "CANVAS",
  "COLOR",
  "ANCHOR",
  "Z",
  "VISIBLE",
]);

const NAMED_ARG_KEY_TYPES = new Set<TokenType>([
  "IDENTIFIER",
  "FROM",
  "TO",
  "STYLE",
  "Z",
  "AT",
  "ANCHOR",
]);

/**
 * The complete set of scene parameters (§14.3, and the §3 grammar).
 *
 * A closed set on purpose: `width`/`height` shape the canvas, `title`/`fps` are
 * metadata the host reads. Adding a fifth is a language change that goes through
 * the spec — not a key the parser quietly tolerates because nobody checked.
 */
const SCENE_PARAM_NAMES: ReadonlySet<string> = new Set([
  "width",
  "height",
  "title",
  "fps",
]);

/**
 * The `box`/`border` style vocabulary (§7.1, §15.1). Closed and static, so an unknown
 * name is a parse-time answer rather than a silent fallback in the engine adapter.
 */
const BORDER_STYLE_NAMES: readonly string[] = ["single", "double", "rounded"];
/**
 * `line`'s closed style set (docs/engine.md §11.16). One entry today; the set exists
 * so the second one is an addition rather than the moment a check gets invented.
 */
const LINE_STYLE_NAMES: readonly string[] = ["stroke"];

const STMT_STARTS = new Set<TokenType>([
  "VAR",
  "CONST",
  "FUNC",
  "IF",
  "WHILE",
  "FOR",
  "MATCH",
  "RETURN",
  "BREAK",
  "CONTINUE",
  "USE",
  "EXPORT",
  "SCENE",
  "LAYER",
  "ON",
  "FILL",
  "PUT",
  "BOX",
  "BORDER",
  "LINE",
  "TEXT",
  "SPRITE",
  "TONE",
  "SHADE",
  "CANVAS",
  "COLOR",
  "ANCHOR",
]);

// an earlier release: keyword classification for the DSL name slots (layer/scene/canvas).
// The DSL vocabulary is globally reserved (spec §2.6), so a name slot that hits a
// keyword reports the CAUSE — "'box' is a scene primitive and cannot be a layer
// name" — not the symptom "expected the layer name".
const SCENE_PRIMITIVE_TOKENS = new Set<TokenType>([
  "SPRITE",
  "BOX",
  "BORDER",
  "LINE",
  "TEXT",
  "TONE",
  "SHADE",
  "FILL",
  "PUT",
  "CANVAS",
]);

/**
 * Scene-DSL words that appear in exactly ONE position, and can therefore also be names.
 *
 * Twenty-six of the fifty-one keywords exist only for the scene DSL, and every one was
 * unusable as a name in a file that never draws — which cost `cinematic.qbsk` six broken
 * comments when a parameter called `at` was renamed by a global find-and-replace.
 *
 * These nine are freed because each is reachable from exactly one place: the first five
 * only after a drawing primitive has been recognised, the last four only immediately
 * after `on`. Both of those sites `expect` or `match` on the token TYPE, so the keyword
 * reading still wins wherever the DSL asks for it, and the name reading is available
 * everywhere else.
 *
 * `COLOR`, `ANCHOR`, `Z` and `VISIBLE` are deliberately NOT here. Each has its own arm in
 * the statement dispatch below, so `color = 1` inside a layer would be genuinely
 * ambiguous — and that ambiguity is where a grammar change earns its regressions.
 */
const CONTEXTUAL_DSL_TOKENS = new Set<TokenType>([
  "AT",
  "FROM",
  "TO",
  "STYLE",
  "WORLD",
  "START",
  "TICK",
  "KEY",
  "RESIZE",
]);

/**
 * All twenty-six scene words, every one of which is a NAME outside statement position
 * (§15.15).
 *
 * §15.13 freed the nine above and argued the other seventeen could not be freed, because
 * `color`, `anchor`, `z` and `visible` each begin a statement and `color = 1` inside a
 * layer would be ambiguous. The argument was sound and the premise was false: not one of
 * the four uses `=`. They use a colon — `z: 3`, `visible: false`, `color fg: "red"` — and
 * `anchor:` is always an error. There was nothing to protect.
 *
 * A scene primitive is a STATEMENT and never an expression, so a scene word standing where
 * a value goes, or in a parameter list, or after `var`, is not ambiguous in any grammar.
 * Only the first token of a statement is, and `startsAName` below settles that with one
 * token of lookahead.
 */
export const NAMEABLE_DSL_TOKENS = new Set<TokenType>([
  ...CONTEXTUAL_DSL_TOKENS,
  "SCENE",
  "LAYER",
  "ON",
  "SPRITE",
  "BOX",
  "BORDER",
  "LINE",
  "TEXT",
  "TONE",
  "SHADE",
  "FILL",
  "PUT",
  "CANVAS",
  "COLOR",
  "ANCHOR",
  "Z",
  "VISIBLE",
]);

/**
 * The same twenty-six, spelled as an author writes them.
 *
 * Exported because the ENFORCEMENT of §15.15 lived in two places and only one of them was
 * widened: the parser accepted `use "x.qbsk" as line` and the interpreter then refused to
 * bind it, testing the alias against all fifty-one keywords. A rule written twice is a rule
 * that will be wrong in one of them.
 */
export const NAMEABLE_DSL_WORDS: ReadonlySet<string> = new Set(
  [...NAMEABLE_DSL_TOKENS].map((t) => KEYWORD_TO_LEXEME[t] ?? "").filter((w) => w !== ""),
);

/**
 * What can follow a scene word at STATEMENT START and make it a name rather than a
 * primitive. One token, and no primitive's syntax continues any of these ways:
 * `z: 3` is the directive and `z = 3` is an assignment.
 */
const NAME_CONTINUATIONS = new Set<TokenType>([
  "EQ",
  "PLUS_EQ",
  "MINUS_EQ",
  "LBRACKET",
  "DOT",
]);

const SCENE_DSL_TOKENS = new Set<TokenType>([
  "COLOR",
  "ANCHOR",
  "AT",
  "FROM",
  "TO",
  "Z",
  "STYLE",
  "VISIBLE",
  "WORLD",
  "SCENE",
  "LAYER",
  "ON",
  "TICK",
  "KEY",
  "RESIZE",
  "START",
]);

function tokenLexeme(token: Token): string {
  if (token.type === "IDENTIFIER" || token.type === "STRING") {
    return String(token.value);
  }
  // §15.8 — the layout tokens carry no text, so `String(token.value)` printed the
  // literal word `null` into user-facing messages (`unexpected expression: 'null'`),
  // which names nothing the author wrote. Describe them instead.
  if (token.type === "INDENT") {
    return "indentation";
  }
  if (token.type === "DEDENT") {
    return "the end of a block";
  }
  if (token.type === "EOF") {
    return "the end of the file";
  }
  return (
    KEYWORD_TO_LEXEME[token.type] ??
    PUNCT_TO_LEXEME[token.type] ??
    // Last resort: name the token type rather than print a bare `null`. Reaching this
    // means a token kind was added without a lexeme — visible, instead of silent.
    (token.value === null ? token.type.toLowerCase() : String(token.value))
  );
}

function spanFrom(file: string, start: Token, end: Token): Span {
  return makeSpan(file, start.span.start, end.span.end);
}

export function parse(source: string, file: string): ParseResult {
  let tokens: Token[];
  try {
    tokens = tokenize(source, file);
  } catch (err) {
    // `parse` RETURNS its errors — every caller reads `.errors` and none expects a
    // throw. Tokenizing was the one place that broke that contract, and it cost a
    // crash: an unknown character typed into the Studio console threw out of here,
    // past evalSnippet, past the IPC handler, and killed the Electron main process.
    // A lexer error is a syntax error like any other and belongs in the same list.
    if (err instanceof QbskSyntaxError) {
      return {
        ast: { kind: "Program", body: [], span: err.span },
        errors: [err],
      };
    }
    throw err;
  }
  const parser = new Parser(tokens, file);
  return parser.parseProgram();
}

class Parser {
  private pos = 0;
  private blockDepth = 0;
  readonly errors: QbskSyntaxError[] = [];

  constructor(
    private readonly tokens: Token[],
    private readonly file: string,
  ) {}

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private previous(): Token {
    return this.tokens[Math.max(this.pos - 1, 0)]!;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.type !== "EOF") {
      this.pos += 1;
    }
    return token;
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private match(...types: TokenType[]): boolean {
    if (types.includes(this.peek().type)) {
      this.advance();
      return true;
    }
    return false;
  }

  // Distinguishes "line (0, 0) to (10, 10)" (DSL) from "line(c, a, b, ch)" (call):
  // after the balanced paren group, if "to" follows it is a DSL primitive.
  private isFromToPrimitive(): boolean {
    let i = 1;
    let depth = 0;
    for (;;) {
      const t = this.peek(i).type;
      if (t === "EOF") {
        return false;
      }
      if (t === "LPAREN") {
        depth += 1;
      } else if (t === "RPAREN") {
        depth -= 1;
        if (depth === 0) {
          return this.peek(i + 1).type === "TO";
        }
      }
      i += 1;
    }
  }

  private errorAt(token: Token, message: string): QbskSyntaxError {
    const err = new QbskSyntaxError(message, token.span);
    this.errors.push(err);
    return err;
  }

  private expect(type: TokenType, message: string): Token {
    if (this.check(type)) {
      return this.advance();
    }
    this.errorAt(this.peek(), message);
    return this.peek();
  }

  // DSL name slots (layer/scene/canvas): when the slot hits a keyword, name the
  // cause (spec §2.6, §7.8) and consume the offending token so the statement can
  // recover into a single, readable error instead of a symptom cascade.
  /** Whether the next token can serve as a name — an identifier, or any scene word. */
  private checkName(): boolean {
    return this.check("IDENTIFIER") || NAMEABLE_DSL_TOKENS.has(this.peek().type);
  }

  /**
   * Whether a scene word opening a statement is a NAME here rather than a primitive.
   *
   * The whole of §15.15's ambiguity, and one token settles it. A primitive continues with
   * its own syntax — a colon, a string, a parenthesised point — and never with an
   * assignment, an index or a field access.
   */
  private startsAName(): boolean {
    return NAME_CONTINUATIONS.has(this.peek(1).type);
  }

  /** The text of a name token, which for a contextual keyword is its own spelling. */
  private nameOf(token: Token): string {
    return token.type === "IDENTIFIER" ? String(token.value) : tokenLexeme(token);
  }

  private expectName(what: string): Token {
    if (this.checkName()) {
      return this.advance();
    }
    const token = this.peek();
    if (token.type !== "INDENT" && token.type !== "DEDENT" && token.type !== "EOF") {
      this.advance();
    }
    this.errorAt(token, this.nameErrorMessage(token, what));
    return token;
  }

  private nameErrorMessage(token: Token, what: string, fallback?: string): string {
    const lexeme = tokenLexeme(token);
    if (SCENE_PRIMITIVE_TOKENS.has(token.type)) {
      return `'${lexeme}' is a scene primitive and cannot be a ${what}`;
    }
    if (SCENE_DSL_TOKENS.has(token.type)) {
      return `'${lexeme}' is a scene DSL keyword and cannot be a ${what}`;
    }
    if (KEYWORD_TO_LEXEME[token.type] !== undefined) {
      return `'${lexeme}' is a reserved keyword and cannot be a ${what}`;
    }
    return fallback ?? `expected the ${what}`;
  }

  private skipUntil(...types: TokenType[]): void {
    while (!this.check("EOF") && !types.includes(this.peek().type)) {
      this.advance();
    }
  }

  // Skips tokens until the start of another statement (or INDENT/DEDENT/EOF).
  private synchronize(): void {
    while (
      !this.check("EOF") &&
      !this.check("DEDENT") &&
      !this.check("INDENT") &&
      !STMT_STARTS.has(this.peek().type)
    ) {
      this.advance();
    }
  }

  /**
   * Whether a named argument starts here — AND belongs to the construct being
   * parsed rather than to the next line (docs/language.md §14.1).
   *
   * The line check is the whole point. Without it, this:
   *
   *     sprite "hero.qba" at (0, 0)
   *     z: 9
   *     put "x" at (0, 0)
   *
   * parses as `sprite ... (z: 9)` — the `z:` state directive is swallowed as a
   * sprite property, the ZStmt never exists, and the primitives below keep the
   * old z. It changes what gets DRAWN based on nothing but line adjacency, and
   * nothing reports it. `put` carried a hand-written guard against exactly this
   * (`=== "depth"`) while `sprite`, `tone` and `shade` did not; fixing it here
   * fixes all four at once, and any primitive added later inherits it.
   */
  private isNamedArgStart(): boolean {
    return (
      NAMED_ARG_KEY_TYPES.has(this.peek().type) &&
      this.peek(1).type === "COLON" &&
      this.peek().span.start.line === this.previous().span.end.line
    );
  }

  // Inside [ ] and { } indentation changes carry no block meaning: the lexer emits none
  // while a bracket is open (§15.14), so this now only discards the layout a multi-line
  // literal left behind in sources lexed before that rule — and costs one check when
  // there is none.
  private skipNewlineIndents(): void {
    while (this.check("INDENT") || this.check("DEDENT")) {
      this.advance();
    }
  }

  /**
   * Walks a comma-separated list inside `( )` that may span lines (§14.6).
   *
   * `parseItem` is called once per element, positioned on that element's first
   * token; the loop owns the separators, the line breaks and the trailing comma.
   * Extracted because this shape was open-coded six times — call arguments, list
   * and dict literals, `func` params, lambda params, `on tick`, `on resize`,
   * `scene` params — and four of the copies had forgotten the line handling. A rule
   * duplicated six times is a rule that will be wrong in one of them.
   *
   * Assumes the opening `(` is already consumed; leaves the closing token for the
   * caller to `expect`, so each construct keeps its own message.
   */
  private parseCommaSeparated(parseItem: () => void): void {
    this.skipNewlineIndents();
    while (!this.check("RPAREN") && !this.check("EOF")) {
      this.skipNewlineIndents();
      if (this.check("RPAREN")) {
        break;
      }
      parseItem();
      if (!this.match("COMMA")) {
        break;
      }
      this.skipNewlineIndents();
    }
    this.skipNewlineIndents();
  }

  private parseNamedArg(): NamedArg {
    const keyToken = this.advance();
    const name = tokenLexeme(keyToken);
    this.expect("COLON", "expected ':' after the parameter name");
    const value = this.parseExpression(0);
    return {
      name,
      value,
      span: makeSpan(this.file, keyToken.span.start, this.previous().span.end),
    };
  }

  parseProgram(): ParseResult {
    const start = this.peek().span.start;
    const body: Stmt[] = [];
    while (!this.check("EOF")) {
      if (this.check("DEDENT")) {
        this.advance();
        continue;
      }
      body.push(this.parseStatement());
    }
    const end = this.previous().span.end;
    const ast: Program = {
      kind: "Program",
      body,
      span: makeSpan(this.file, start, end),
    };
    return { ast, errors: this.errors };
  }

  private parseStatement(): Stmt {
    switch (this.peek().type) {
      case "VAR":
        return this.parseVarDecl("VarDecl");
      case "CONST":
        return this.parseVarDecl("ConstDecl");
      case "FUNC":
        return this.parseFuncDecl();
      case "IF":
        return this.parseIf();
      case "WHILE":
        return this.parseWhile();
      case "FOR":
        return this.parseFor();
      case "MATCH":
        return this.parseMatch();
      case "TRY":
        return this.parseTry();
      case "RETURN":
        return this.parseReturn();
      case "BREAK": {
        const token = this.advance();
        const label = this.parseLoopTarget();
        return {
          kind: "BreakStmt",
          label,
          span: spanFrom(this.file, token, this.previous()),
        };
      }
      case "CONTINUE": {
        const token = this.advance();
        const label = this.parseLoopTarget();
        return {
          kind: "ContinueStmt",
          label,
          span: spanFrom(this.file, token, this.previous()),
        };
      }
      case "USE":
        return this.parseUse();
      case "EXPORT":
        return this.parseExport();
      case "SCENE":
        if (this.startsAName()) {
          return this.parseExprStmt();
        }
        return this.parseScene();
      case "LAYER":
        if (this.startsAName()) {
          return this.parseExprStmt();
        }
        return this.parseLayer();
      case "ON":
        if (this.startsAName()) {
          return this.parseExprStmt();
        }
        return this.parseEvent();
      case "FILL":
      case "PUT":
      case "CANVAS":
        // Keywords callable as natives: keyword + "(" = expression, not DSL.
        if (this.peek(1).type === "LPAREN" || this.startsAName()) {
          return this.parseExprStmt();
        }
        return this.parsePrimitive();
      case "BOX":
      case "LINE":
        // Ambiguous twice over: `line (0, 0) to (10, 10)` is DSL, `line(c, a, b, ch)` is a
        // call, and `line = 3` is an assignment to a variable of that name.
        if (this.startsAName() || (this.peek(1).type === "LPAREN" && !this.isFromToPrimitive())) {
          return this.parseExprStmt();
        }
        return this.parsePrimitive();
      case "BORDER":
      case "TEXT":
      case "SPRITE":
      case "TONE":
      case "SHADE":
      case "COLOR":
      case "ANCHOR":
      case "Z":
      case "VISIBLE":
        // §15.15's one token of lookahead, and nothing else. These arms deliberately do
        // NOT gain the `(` check the three above carry: `border (20, 4) to (40, 9)` opens
        // with a parenthesised point, so reading `border (` as a call broke every example
        // that draws one. What a primitive may be followed by is the primitive's business;
        // what makes it a NAME is the same everywhere.
        if (this.startsAName()) {
          return this.parseExprStmt();
        }
        return this.parsePrimitive();
      default:
        return this.parseExprStmt();
    }
  }

  private parseVarDecl(kind: "VarDecl" | "ConstDecl"): VarDecl | ConstDecl | ErrorStmt {
    const startToken = this.advance();
    let nameToken: Token;
    if (this.checkName()) {
      nameToken = this.advance();
    } else {
      nameToken = this.peek();
      // `nameErrorMessage` rather than a bare "expected an identifier": it says WHY a
      // word cannot be a name, and `var color = 1` deserves that as much as a parameter
      // does. This path had its own message and did not.
      this.errorAt(
        nameToken,
        this.nameErrorMessage(
          nameToken,
          `name after '${kind === "VarDecl" ? "var" : "const"}'`,
          `expected an identifier after '${kind === "VarDecl" ? "var" : "const"}'`,
        ),
      );
      this.synchronize();
      return {
        kind: "ErrorStmt",
        message: `expected an identifier after '${kind === "VarDecl" ? "var" : "const"}'`,
        span: spanFrom(this.file, startToken, this.previous()),
      };
    }
    const name = this.nameOf(nameToken);
    let typeAnnot: string | null = null;
    if (this.match("COLON")) {
      if (this.check("IDENTIFIER")) {
        typeAnnot = String(this.advance().value);
      } else {
        this.errorAt(this.peek(), "expected a type identifier after ':'");
        if (!this.check("INDENT") && !this.check("DEDENT") && !this.check("EOF")) {
          this.advance();
        }
      }
    }
    let init: Expr | null = null;
    if (this.match("EQ")) {
      init = this.parseExpression(0);
    }
    const span = spanFrom(this.file, startToken, this.previous());
    const base = { name, nameSpan: nameToken.span, typeAnnot, init, exported: false, span };
    return kind === "VarDecl"
      ? { ...base, kind: "VarDecl" }
      : { ...base, kind: "ConstDecl" };
  }

  /**
   * §15.4 — a duplicate parameter is a PARSE error, not a host crash.
   *
   * `func f(a, a)` used to reach `Env.define`, which throws a bare JS `Error` with no
   * span; inside an `on tick(a, a)` it surfaced as a full Node stack trace, which
   * RULE #4 forbids in one line. The parser has both tokens in hand and the defect is
   * structural — a signature cannot bind the same name twice under any semantics — so
   * it belongs here, where the error can point at the second occurrence.
   */
  private checkDuplicateParams(params: readonly Param[], what: string): void {
    const seen = new Set<string>();
    for (const p of params) {
      if (seen.has(p.name)) {
        this.errorAt(
          this.previous(),
          `the parameter '${p.name}' is declared twice in this ${what}`,
        );
      }
      seen.add(p.name);
    }
  }

  /**
   * The parameters of a function or a lambda, defaults included (§15.21).
   *
   * ONE function for both. They were two near-identical blocks, and the first version of
   * this change added defaults to the declaration alone — which would have left
   * `func(a, b = 2) a + b` reporting `expected ')' after the lambda parameters` with the
   * caret on the `=`. Two spellings of the same list is how anti-pattern 6 gets in.
   *
   * `allowAnnot` is the one real difference: a declaration takes `a : int`, a lambda does
   * not. Left as it was rather than widened here, because widening it is its own decision.
   */
  private parseParamList(allowAnnot: boolean): Param[] {
    const params: Param[] = [];
    // The first optional parameter seen, which every later one must also be.
    let optional: string | null = null;
    this.parseCommaSeparated(() => {
      const paramToken = this.expectName("parameter name");
      const name = this.nameOf(paramToken);
      let typeAnnot: string | null = null;
      if (allowAnnot && this.match("COLON")) {
        const annotToken = this.expect("IDENTIFIER", "expected the parameter type");
        typeAnnot = String(annotToken.value);
      }
      let defaultValue: Expr | null = null;
      if (this.match("EQ")) {
        defaultValue = this.parseExpression(0);
        optional = name;
      } else if (optional !== null) {
        // Refused at the DECLARATION, because the call is where it stops being fixable:
        // `f(2)` after `func f(a = 1, b)` has no honest reading, and the language would
        // have to guess which parameter the 2 was for.
        this.errorAt(
          paramToken,
          `parameter '${name}' is required but follows '${optional}', which has a default`,
        );
      }
      params.push({
        name,
        typeAnnot,
        defaultValue,
        span: spanFrom(this.file, paramToken, this.previous()),
      });
    });
    return params;
  }

  private parseFuncDecl(): Stmt {
    const startToken = this.advance();
    const nameToken = this.expectName("function name");
    const name = this.nameOf(nameToken);
    this.expect("LPAREN", "expected '(' after the function name");
    // §14.6 — indentation inside ( ) carries no block meaning, and a parameter
    // list broken across lines used to die on `expected the parameter name` and cascade
    // into five more errors. `parseCommaSeparated` inside `parseParamList` keeps that
    // fixed for the declaration and the lambda at once.
    const params = this.parseParamList(true);
    this.expect("RPAREN", "expected ')' in the function signature");
    this.checkDuplicateParams(params, "function");
    let returnAnnot: string | null = null;
    if (this.match("COLON")) {
      const annotToken = this.expect(
        "IDENTIFIER",
        "expected the return type",
      );
      returnAnnot = String(annotToken.value);
    }
    const body = this.parseBlockOrInline();
    return {
      kind: "FuncDecl",
      name,
      params,
      returnAnnot,
      body,
      exported: false,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  private parseBlockOrInline(): Block {
    this.blockDepth += 1;
    let block: Block;
    if (this.match("COLON")) {
      if (this.check("INDENT")) {
        this.advance();
        block = this.parseIndentedBlockBody();
      } else {
        const stmt = this.parseStatement();
        block = {
          kind: "Block",
          statements: [stmt],
          span: stmt.span,
        };
      }
    } else if (this.match("INDENT")) {
      block = this.parseIndentedBlockBody();
    } else {
      const token = this.peek();
      this.errorAt(token, "expected ':' or an indented block");
      block = {
        kind: "Block",
        statements: [],
        span: makeSpan(this.file, token.span.start, token.span.end),
      };
    }
    this.blockDepth -= 1;
    return block;
  }

  private parseIndentedBlockBody(): Block {
    this.blockDepth += 1;
    const start = this.previous().span.start;
    const statements: Stmt[] = [];
    while (!this.check("EOF") && !this.check("DEDENT")) {
      statements.push(this.parseStatement());
    }
    const endToken = this.match("DEDENT") ? this.previous() : this.peek();
    this.blockDepth -= 1;
    return {
      kind: "Block",
      statements,
      span: makeSpan(this.file, start, endToken.span.end),
    };
  }

  private parseIf(): Stmt {
    const startToken = this.advance();
    const branches: {
      cond: Expr;
      body: Block;
      span: Span;
    }[] = [];
    let cond = this.parseExpression(0);
    let body = this.parseBlockOrInline();
    branches.push({
      cond,
      body,
      span: makeSpan(this.file, cond.span.start, body.span.end),
    });
    while (this.match("ELIF")) {
      cond = this.parseExpression(0);
      body = this.parseBlockOrInline();
      branches.push({
        cond,
        body,
        span: makeSpan(this.file, cond.span.start, body.span.end),
      });
    }
    let elseBody: Block | null = null;
    if (this.match("ELSE")) {
      elseBody = this.parseBlockOrInline();
    }
    return {
      kind: "IfStmt",
      branches,
      elseBody,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  /**
   * The name a loop carries, when `as name` follows its header (§15.22).
   *
   * Introduced with `as` because `as` is ALREADY a keyword (`use "x.qbsk" as x`), so
   * naming a loop added nothing to the 51 (§17.1) and could not break a program
   * that keeps a variable called `label` or `outer`.
   */
  private parseLoopLabel(): string | null {
    if (!this.match("AS")) {
      return null;
    }
    return this.nameOf(this.expectName("the loop name after 'as'"));
  }

  /**
   * The loop a `break` or `continue` names, or null for the innermost one.
   *
   * Anchored to the physical line: a bare `break` followed by
   *
   *     break
   *     stop = 1
   *
   * offers the parser exactly the same tokens as `break stop`.
   *
   * This compared line NUMBERS when §15.22 was written, which was §15.25's rule
   * stated a second way -- and a rule stated twice is a rule that will be stated
   * differently in one of the two places.
   */
  private parseLoopTarget(): string | null {
    if (!this.stillThisLine() || !this.checkName()) {
      return null;
    }
    return this.nameOf(this.advance());
  }

  private parseWhile(): Stmt {
    const startToken = this.advance();
    const cond = this.parseExpression(0);
    const label = this.parseLoopLabel();
    const body = this.parseBlockOrInline();
    return {
      kind: "WhileStmt",
      cond,
      body,
      label,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  private parseFor(): Stmt {
    const startToken = this.advance();
    if (!this.checkName()) {
      const token = this.peek();
      this.errorAt(
        token,
        this.nameErrorMessage(token, "name after 'for'", "expected an identifier after 'for'"),
      );
      this.synchronize();
      return {
        kind: "ErrorStmt",
        message: "expected an identifier after 'for'",
        span: spanFrom(this.file, startToken, this.previous()),
      };
    }
    // `nameOf` and not `String(...value)`: a scene word carries no `value`, so a loop
    // over `for at in list` bound the literal string "null" and then reported that `at`
    // was not defined. The guard above already accepted the token — the two halves
    // disagreed. §15.13 shipped with this hole for the nine words it freed and no test
    // looked, which is why §15.15's tests walk all five name positions and not three.
    const name = this.nameOf(this.advance());
    // L2 (docs/language.md §6.2): `for i, item in list` — the first name is the
    // index, the second the element. Applies to LIST iteration only.
    let secondName: string | null = null;
    if (this.match("COMMA")) {
      const itemToken = this.expectName("element name after ',' (for index, item in list)");
      secondName = this.nameOf(itemToken);
    }
    this.expect("IN", "expected 'in' in the for loop");
    const iterable = this.parseExpression(0);
    const label = this.parseLoopLabel();
    const body = this.parseBlockOrInline();
    if (iterable.kind === "BinOp" && iterable.op === "..") {
      if (secondName !== null) {
        // A range's element IS its index: the second name could only duplicate the
        // first, so this is refused rather than silently binding two equal numbers.
        this.errorAt(
          startToken,
          "'for i, item in ...' works on a list, not a range — a range's element is already its index",
        );
        return {
          kind: "ErrorStmt",
          message: "indexed for on a range",
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      return {
        kind: "ForRange",
        name,
        from: iterable.left,
        to: iterable.right,
        body,
        label,
        span: spanFrom(this.file, startToken, this.previous()),
      };
    }
    return {
      kind: "ForList",
      // Single-name form: `name` is the element, no index. Comma form: the FIRST
      // name is the index, the SECOND the element.
      name: secondName ?? name,
      indexName: secondName === null ? null : name,
      iterable,
      body,
      label,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  private parseTry(): Stmt {
    const startToken = this.advance();
    const tryBody = this.parseBlockOrInline();
    if (!this.match("CATCH")) {
      const token = this.peek();
      this.errorAt(token, "expected 'catch' after the try block");
      this.synchronize();
      return {
        kind: "ErrorStmt",
        message: "expected 'catch' after the try block",
        span: spanFrom(this.file, startToken, this.previous()),
      };
    }
    let catchParam: string;
    if (this.checkName()) {
      catchParam = this.nameOf(this.advance());
    } else {
      const token = this.peek();
      this.errorAt(token, "expected an identifier as the catch variable");
      this.synchronize();
      return {
        kind: "ErrorStmt",
        message: "expected an identifier as the catch variable",
        span: spanFrom(this.file, startToken, this.previous()),
      };
    }
    const catchBody = this.parseBlockOrInline();
    return {
      kind: "TryStmt",
      tryBody,
      catchParam,
      catchBody,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  private parseMatch(): Stmt {
    const startToken = this.advance();
    const subject = this.parseExpression(0);
    this.match("COLON");
    if (!this.check("INDENT")) {
      const token = this.peek();
      this.errorAt(token, "match requires an indented block of arms");
      this.synchronize();
      return {
        kind: "ErrorStmt",
        message: "match requires an indented block of arms",
        span: spanFrom(this.file, startToken, this.previous()),
      };
    }
    this.advance();
    const arms: {
      pattern: Expr;
      body: Block;
      span: Span;
    }[] = [];
    let elseBody: Block | null = null;
    while (!this.check("EOF") && !this.check("DEDENT")) {
      if (this.match("ELSE")) {
        elseBody = this.parseBlockOrInline();
        continue;
      }
      const pattern = this.parseExpression(0);
      if (!this.match("COLON")) {
        this.errorAt(
          this.peek(),
          "expected ':' after the arm pattern",
        );
        this.synchronize();
        continue;
      }
      const body = this.parseBlockOrInline();
      arms.push({
        pattern,
        body,
        span: makeSpan(this.file, pattern.span.start, body.span.end),
      });
    }
    this.match("DEDENT");
    return {
      kind: "MatchStmt",
      subject,
      arms,
      elseBody,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  /**
   * Is the next token part of THIS statement? (§15.25)
   *
   * False when it opens a physical line of its own. Every construct that takes an
   * OPTIONAL trailing expression asks this first, because QBSK emits no end-of-line
   * token: without it `return` swallows the line below, a parenthesis-free call fuses
   * with the next statement, and an expression runs on into a line that starts with an
   * operator. Three shapes, one question.
   *
   * The lexer does not set the mark on a line that CONTINUES one above it -- inside an
   * open bracket (§15.14) or after a line ending on an operator (§15.23) -- so
   * asking this never refuses a continuation.
   */
  private stillThisLine(): boolean {
    return this.peek().startsLine !== true;
  }

  private parseReturn(): Stmt {
    const startToken = this.advance();
    let value: Expr | null = null;
    // §15.25 -- `return` on its own line returns null. It used to read the next line
    // as its value, so a bare return ran the statement below it AND returned that
    // statement's result.
    if (this.stillThisLine() && VALUE_STARTS.has(this.peek().type)) {
      value = this.parseExpression(0);
    }
    return {
      kind: "ReturnStmt",
      value,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  private parseUse(): Stmt {
    const startToken = this.advance();
    const pathToken = this.expect(
      "STRING",
      'expected the module path, e.g. "res/otro.qbsk"',
    );
    let alias: string | null = null;
    if (this.match("AS")) {
      // §15.15 counts the `use` alias among the positions a scene word may occupy, and
      // §2.6 names it outright. This site still demanded an IDENTIFIER, so
      // `use "x.qbsk" as line` reported while `var line = 1` compiled — the FOURTH hole of
      // that kind, after `parseFor` binding the literal string "null" and member names
      // after a dot. Found by enumerating every `expect("IDENTIFIER"` in this file rather
      // than by tripping over it, which is what should have happened after the first: the
      // only two that remain are type annotations and style names, and both are closed
      // vocabularies rather than name positions.
      const aliasToken = this.expectName("module name after 'as'");
      // `nameOf` and not `String(...value)`: a scene word carries no `value`, so widening
      // the slot above without this would have bound the literal string "null" as the
      // alias -- exactly the defect `parseFor` had, in the very next position to be freed.
      alias = this.nameOf(aliasToken);
    }
    return {
      kind: "UseStmt",
      path: String(pathToken.value),
      alias,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  private parseExport(): Stmt {
    const exportToken = this.advance();
    if (this.blockDepth > 0) {
      this.errorAt(
        exportToken,
        "'export' is only allowed at the top level of a file",
      );
    }
    if (this.check("VAR")) {
      const decl = this.parseVarDecl("VarDecl");
      if (decl.kind === "VarDecl") {
        return this.rejectExportVar(exportToken);
      }
      return decl;
    }
    if (this.check("CONST")) {
      const decl = this.parseVarDecl("ConstDecl");
      return decl.kind === "ConstDecl" ? { ...decl, exported: true } : decl;
    }
    if (this.check("FUNC")) {
      const decl = this.parseFuncDecl();
      return decl.kind === "FuncDecl" ? { ...decl, exported: true } : decl;
    }
    return this.rejectExportVar(exportToken);
  }

  private rejectExportVar(exportToken: Token): ErrorStmt {
    this.errorAt(
      exportToken,
      "'export' applies only to top-level 'const' and 'func': exported bindings are immutable (use 'const' instead of 'var')",
    );
    return {
      kind: "ErrorStmt",
      message:
        "'export' applies only to top-level 'const' and 'func': exported bindings are immutable (use 'const' instead of 'var')",
      span: spanFrom(this.file, exportToken, this.previous()),
    };
  }

  private parseScene(): Stmt {
    const startToken = this.advance();
    const nameToken = this.expectName("scene name");
    const name = this.nameOf(nameToken);
    this.expect("LPAREN", "expected '(' after the scene name");
    const params: NamedArg[] = [];
    this.parseCommaSeparated(() => {
      if (this.check("IDENTIFIER")) {
        const keyToken = this.advance();
        const key = String(keyToken.value);
        if (this.match("COLON")) {
          const value = this.parseExpression(0);
          // §14.3 — the four keys of the §3 grammar are the whole set. Any key used
          // to be accepted in silence and then read by nobody, including in
          // examples/hello.qbsk, the first example in the repository: the author
          // wrote configuration, the language nodded, and nothing happened.
          if (!SCENE_PARAM_NAMES.has(key)) {
            const near = closest(key, SCENE_PARAM_NAMES);
            this.errorAt(
              keyToken,
              `unknown scene parameter '${key}'` +
                (near !== null
                  ? ` — did you mean '${near}'?`
                  : ` (width, height, title, fps)`),
            );
          } else if (params.some((p) => p.name === key)) {
            this.errorAt(keyToken, `duplicate scene parameter '${key}'`);
          }
          params.push({
            name: key,
            value,
            span: spanFrom(this.file, keyToken, this.previous()),
          });
        } else {
          this.errorAt(
            this.peek(),
            "expected ':' after the parameter name",
          );
          this.skipUntil("COMMA", "RPAREN");
        }
      } else {
        this.errorAt(
          this.peek(),
          "expected a parameter name (width, height, title, fps)",
        );
        this.skipUntil("COMMA", "RPAREN");
      }
    });
    this.expect("RPAREN", "expected ')' in scene");
    const hasWidth = params.some((p) => p.name === "width");
    const hasHeight = params.some((p) => p.name === "height");
    if (!hasWidth || !hasHeight) {
      this.errorAt(nameToken, "scene requires 'width' and 'height'");
    }
    let body: Block | null = null;
    if (this.check("INDENT")) {
      this.advance();
      body = this.parseIndentedBlockBody();
    } else if (this.check("COLON")) {
      body = this.parseBlockOrInline();
    }
    return {
      kind: "SceneDecl",
      name,
      params,
      body,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  private parseLayer(): Stmt {
    const startToken = this.advance();
    const nameToken = this.expectName("layer name");
    const name = this.nameOf(nameToken);
    let z: Expr;
    if (this.match("Z")) {
      this.expect("COLON", "expected ':' after z");
      z = this.parseExpression(0);
    } else {
      const token = this.peek();
      this.errorAt(token, "layer requires 'z:'");
      this.synchronize();
      z = {
        kind: "ErrorExpr",
        message: "layer requires 'z:'",
        span: token.span,
      };
    }
    // M16: optional layer offset: layer name z: N at (x, y)
    let at: Expr | null = null;
    if (this.match("AT")) {
      at = this.parseExpression(0);
    }
    const body = this.parseBlockOrInline();
    return {
      kind: "LayerDecl",
      name,
      z,
      at,
      body,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  // M16: local positions (`at (x, y)`) or absolute positions (`world: (x, y)`).
  private parseAtOrWorld(kw: string): { at: Expr; world: boolean } {
    if (this.match("WORLD")) {
      this.expect("COLON", "expected ':' after world");
      return { at: this.parseExpression(0), world: true };
    }
    this.expect("AT", `expected 'at' or 'world:' in ${kw}`);
    return { at: this.parseExpression(0), world: false };
  }

  private parseEvent(): Stmt {
    const startToken = this.advance();
    let event: EventKind;
    let keyName: string | null = null;
    const params: Param[] = [];
    if (this.match("START")) {
      event = "start";
    } else if (this.match("TICK")) {
      event = "tick";
      this.expect("LPAREN", "expected '(' after tick");
      this.parseCommaSeparated(() => {
        const paramToken = this.expectName("parameter name");
        let typeAnnot: string | null = null;
        if (this.match("COLON")) {
          const annotToken = this.expect(
            "IDENTIFIER",
            "expected the parameter type (seconds)",
          );
          typeAnnot = String(annotToken.value);
        }
        params.push({
          name: this.nameOf(paramToken),
          typeAnnot,
          // §15.21 — an event handler takes no defaults. The engine supplies
          // every argument or none, so an optional one could never be omitted, and
          // accepting the syntax would be a value the language reads and can never
          // use (I2).
          defaultValue: null,
          span: spanFrom(this.file, paramToken, this.previous()),
        });
      });
      this.expect("RPAREN", "expected ')' in tick");
    } else if (this.match("KEY")) {
      event = "key";
      const keyToken = this.expect(
        "STRING",
        'expected the key name, e.g. "arrow-left"',
      );
      keyName = String(keyToken.value);
    } else if (
      // `turn` is matched as an ORDINARY IDENTIFIER, not promoted to a keyword
      // (docs/engine.md §12.3). Making it reserved would break every program that
      // already keeps a variable called `turn` — including this project's own
      // benchmark — for no gain: `on` is the keyword, and what follows it is
      // unambiguous by position.
      this.check("IDENTIFIER") &&
      String(this.peek().value) === "turn"
    ) {
      this.advance();
      event = "turn";
      // The parameter is optional: a handler that does not care which turn it is
      // should not have to name it.
      if (this.match("LPAREN")) {
        this.parseCommaSeparated(() => {
          const paramToken = this.expectName("parameter name");
          params.push({
            name: this.nameOf(paramToken),
            typeAnnot: null,
            defaultValue: null,
            span: paramToken.span,
          });
        });
        this.expect("RPAREN", "expected ')' after the turn parameter");
      }
    } else if (this.match("RESIZE")) {
      event = "resize";
      this.expect("LPAREN", "expected '(' after resize");
      this.parseCommaSeparated(() => {
        const paramToken = this.expectName("parameter name");
        params.push({
          name: this.nameOf(paramToken),
          typeAnnot: null,
          defaultValue: null,
          span: paramToken.span,
        });
      });
      this.expect("RPAREN", "expected ')' in resize");
    } else {
      const token = this.peek();
      this.errorAt(
        token,
        "expected start, tick, turn, key or resize after 'on'",
      );
      this.synchronize();
      return {
        kind: "ErrorStmt",
        message: "expected start, tick, turn, key or resize after 'on'",
        span: spanFrom(this.file, startToken, this.previous()),
      };
    }
    // One check for every event shape — tick, turn and resize all funnel here.
    this.checkDuplicateParams(params, "handler");
    // L3 (docs/language.md §6.6): optional guard between the event header and the
    // block. Evaluated at dispatch time, before any eligible handler runs.
    let guard: Expr | null = null;
    if (this.match("WHEN")) {
      guard = this.parseExpression(0);
    }
    const body = this.parseBlockOrInline();
    return {
      kind: "EventDecl",
      event,
      params,
      keyName,
      guard,
      body,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  private parsePrimitive(): Stmt {
    switch (this.peek().type) {
      case "FILL": {
        const startToken = this.advance();
        const ch = this.parseExpression(0);
        return {
          kind: "FillStmt",
          ch,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "PUT": {
        const startToken = this.advance();
        const text = this.parseExpression(0);
        const { at, world } = this.parseAtOrWorld("put");
        // `depth:` and `mask:` (§11.12) are put's named args, and the set is closed
        // here. The same-line rule in isNamedArgStart (§14.1) is what keeps an inline
        // `z:` on the NEXT line from being read as one — this used to need a
        // hand-written `=== "depth"` guard here, which protected `put` and left
        // `sprite`, `tone` and `shade` exposed.
        let depth: Expr | null = null;
        let mask: Expr | null = null;
        while (this.isNamedArgStart()) {
          const arg = this.parseNamedArg();
          if (arg.name === "depth") {
            depth = arg.value;
          } else if (arg.name === "mask") {
            mask = arg.value;
          } else {
            this.errorAt(
              this.previous(),
              `'${arg.name}:' is not a property of 'put' — put takes 'mask:' and 'depth:'`,
            );
          }
        }
        return {
          kind: "PutStmt",
          text,
          at,
          world,
          depth,
          mask,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "BOX":
      case "BORDER": {
        const startToken = this.advance();
        const from = this.parseExpression(0);
        this.expect("TO", "expected 'to' after the starting position");
        const to = this.parseExpression(0);
        let style: string | null = null;
        if (this.match("STYLE")) {
          this.expect("COLON", "expected ':' after style");
          const styleToken = this.expect(
            "IDENTIFIER",
            "expected the style name",
          );
          style = String(styleToken.value);
          // §15.1 — a closed set, checked here. The engine adapter used to resolve an
          // unknown name through `?? "single"`, so a typo drew a box that looked
          // deliberate: the shape was wrong and nothing said why. The vocabulary is
          // static, so this is a parse-time answer, like the anchor rule (§14.2).
          if (!BORDER_STYLE_NAMES.includes(style)) {
            const near = closest(style, BORDER_STYLE_NAMES);
            this.errorAt(
              styleToken,
              `'${style}' is not a border style` +
                (near !== null
                  ? ` — did you mean '${near}'?`
                  : ` (${BORDER_STYLE_NAMES.join(", ")})`),
            );
          }
        }
        const kind = startToken.type === "BOX" ? "BoxStmt" : "BorderStmt";
        return {
          kind,
          from,
          to,
          style,
          span: spanFrom(this.file, startToken, this.previous()),
        } as Stmt;
      }
      case "LINE": {
        const startToken = this.advance();
        const from = this.parseExpression(0);
        this.expect("TO", "expected 'to' after the starting position");
        const to = this.parseExpression(0);
        // §11.16 — absent means unchanged: `line` keeps drawing the `*` it always drew,
        // so every existing scene composes byte for byte. The set is closed here, as
        // `border`'s is, because an unknown style that fell through to a default would
        // draw something that looked deliberate (§15.1).
        let style: string | null = null;
        if (this.match("STYLE")) {
          this.expect("COLON", "expected ':' after style");
          const styleToken = this.expect("IDENTIFIER", "expected the style name");
          style = String(styleToken.value);
          if (!LINE_STYLE_NAMES.includes(style)) {
            const near = closest(style, LINE_STYLE_NAMES);
            this.errorAt(
              styleToken,
              `'${style}' is not a line style` +
                (near !== null
                  ? ` — did you mean '${near}'?`
                  : ` (${LINE_STYLE_NAMES.join(", ")})`),
            );
          }
        }
        return {
          kind: "LineStmt",
          from,
          to,
          style,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "TEXT": {
        const startToken = this.advance();
        const text = this.parseExpression(0);
        const { at, world } = this.parseAtOrWorld("text");
        return {
          kind: "TextStmt",
          text,
          at,
          world,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "SPRITE": {
        const startToken = this.advance();
        const path = this.parseExpression(0);
        const { at, world } = this.parseAtOrWorld("sprite");
        const props: NamedArg[] = [];
        while (this.isNamedArgStart()) {
          props.push(this.parseNamedArg());
        }
        return {
          kind: "SpriteStmt",
          path,
          at,
          world,
          props,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "SHADE": {
        // shade <name> [x:] [y:] [radius:] [tint:] [strength:] [speed:]
        // The name is validated in the interpreter so an unknown one reports with a
        // span naming the ones that exist — the same shape as an unknown wave.
        const startToken = this.advance();
        const name = this.parseExpression(0);
        const args: NamedArg[] = [];
        while (this.isNamedArgStart()) {
          args.push(this.parseNamedArg());
        }
        return {
          kind: "ShadeStmt",
          name,
          args,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "TONE": {
        // tone <freq> [wave:] [duration:] [volume:] [loop:]  (docs/audio.md §4)
        // Named args are collected verbatim and validated in the interpreter, so an
        // unknown wave reports at runtime with a span rather than being rejected
        // here by name — the same shape as an unknown easing.
        const startToken = this.advance();
        const freq = this.parseExpression(0);
        const args: NamedArg[] = [];
        while (this.isNamedArgStart()) {
          args.push(this.parseNamedArg());
        }
        return {
          kind: "ToneStmt",
          freq,
          args,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "CANVAS": {
        const startToken = this.advance();
        const nameToken = this.expectName("canvas name");
        const name = this.nameOf(nameToken);
        this.expect("AT", "expected 'at' in canvas");
        const at = this.parseExpression(0);
        this.expect(
          "COLON",
          "expected ':' after the canvas position",
        );
        const hadIndent = this.match("INDENT");
        const literalToken = this.expect(
          "STRING",
          'expected the multi-line literal """ ... """',
        );
        if (hadIndent) {
          this.match("DEDENT");
        }
        return {
          kind: "CanvasDecl",
          name,
          at,
          literal: String(literalToken.value),
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "COLOR": {
        const startToken = this.advance();
        const props: NamedArg[] = [];
        while (this.isNamedArgStart()) {
          props.push(this.parseNamedArg());
        }
        if (props.length === 0) {
          this.errorAt(this.peek(), "color requires at least one key: value pair");
        }
        return {
          kind: "ColorStmt",
          props,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "ANCHOR": {
        // §14.2 — `anchor:` is a property of the primitive it positions, never a
        // state directive. A bare one inside a layer used to become its own AST
        // node, which the interpreter turned into a primitive value and the engine
        // adapter then dropped in its `default` branch: three layers deep,
        // composing to nothing, with no diagnostic anywhere. It read like `z:` and
        // did less than a comment.
        //
        // Rejected HERE and not in `qbsk check` on purpose. The analyzer's own
        // doctrine is that it never reports what cannot be observed by running the
        // program — and this ghost is invisible at runtime by definition, so the
        // analyzer would have left `qbsk run` mis-composing in silence. A dead `z:`
        // is contextually useless but structurally legal; a bare `anchor:` is never
        // valid in any context, and structural impossibility belongs in the parser.
        const startToken = this.advance();
        this.errorAt(
          startToken,
          "'anchor:' is not a layer directive — put it on the primitive it positions",
        );
        // Consume the directive's own text so recovery resumes at the next line
        // instead of re-reporting `: center` as garbage (§8: many errors, one pass).
        if (this.match("COLON")) {
          this.parseExpression(0);
        }
        return {
          kind: "ErrorStmt",
          message:
            "'anchor:' is not a layer directive — put it on the primitive it positions",
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "Z": {
        // State directive (M15): z: expr → z of the following primitives.
        const startToken = this.advance();
        this.expect("COLON", "expected ':' after z");
        const value = this.parseExpression(0);
        return {
          kind: "ZStmt",
          value,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      case "VISIBLE": {
        // State directive (M15): visible: bool → hides/shows the following primitives.
        const startToken = this.advance();
        this.expect("COLON", "expected ':' after visible");
        const value = this.parseExpression(0);
        return {
          kind: "VisibleStmt",
          value,
          span: spanFrom(this.file, startToken, this.previous()),
        };
      }
      default: {
        // RULE #4: a Node exception must never reach the QBSK user, and "this branch
        // is unreachable" is not an exemption. It is reachable by the one change
        // pattern this switch actually sees: an earlier release added `case "TONE"` here AND to
        // the dispatch that feeds it, and had those landed in the other order this
        // would have fired and shown a stack trace. Reported like every other parser
        // error instead — span, fragment, and recovery.
        const token = this.peek();
        const message = `'${tokenLexeme(token)}' is not a scene primitive here`;
        this.errorAt(token, message);
        this.advance();
        return {
          kind: "ErrorStmt",
          message,
          span: token.span,
        };
      }
    }
  }

  private parseExprStmt(): Stmt {
    const startToken = this.peek();
    let expr = this.parseExpression(0);
    if (this.match("EQ", "PLUS_EQ", "MINUS_EQ")) {
      const opToken = this.previous();
      const op = opToken.type === "EQ" ? "=" : opToken.type === "PLUS_EQ" ? "+=" : "-=";
      if (expr.kind !== "Ident" && expr.kind !== "Member" && expr.kind !== "Index") {
        this.errorAt(opToken, "cannot assign to this expression");
      }
      const value = this.parseExpression(0);
      return {
        kind: "Assign",
        target: expr,
        op,
        value,
        span: spanFrom(this.file, startToken, this.previous()),
      };
    }
    if (
      (expr.kind === "Ident" || expr.kind === "Member") &&
      // §15.25 -- the argument has to be beside the name. Without this, a bare
      // `greet` on one line took the whole statement below it as its argument.
      this.stillThisLine() &&
      VALUE_STARTS.has(this.peek().type)
    ) {
      const arg = this.parseExpression(0);
      expr = {
        kind: "Call",
        callee: expr,
        args: [arg],
        namedArgs: [],
        span: makeSpan(this.file, startToken.span.start, this.previous().span.end),
      };
    }
    return {
      kind: "ExprStmt",
      expr,
      span: spanFrom(this.file, startToken, this.previous()),
    };
  }

  private parseExpression(minPrec: number): Expr {
    let left = this.parseUnary();
    while (true) {
      const token = this.peek();
      const prec = BINARY_PRECEDENCE[token.type];
      if (prec === undefined || prec < minPrec) {
        break;
      }
      // §15.25 -- an operator that OPENS a line belongs to that line. `var a = 1`
      // followed by `-a` used to read as `var a = 1 - a` and then report that `a` was
      // not defined, about a variable declared on the line above the caret.
      if (!this.stillThisLine()) {
        break;
      }
      this.advance();
      const right = this.parseExpression(prec + 1);
      left = {
        kind: "BinOp",
        op: BINARY_LEXEMES[token.type]!,
        left,
        right,
        span: makeSpan(this.file, left.span.start, this.previous().span.end),
      };
    }
    return left;
  }

  private parseUnary(): Expr {
    const token = this.peek();
    if (token.type === "MINUS" || token.type === "BANG" || token.type === "NOT") {
      this.advance();
      const operand = this.parseUnary();
      const op = token.type === "MINUS" ? "-" : token.type === "BANG" ? "!" : "not";
      if (
        op === "-" &&
        operand.kind === "Lit" &&
        (operand.litKind === "int" || operand.litKind === "float")
      ) {
        const lit = operand as Expr & { kind: "Lit"; value: number };
        return {
          ...operand,
          value: -lit.value,
          span: spanFrom(this.file, token, this.previous()),
        };
      }
      return {
        kind: "Unary",
        op,
        operand,
        span: spanFrom(this.file, token, this.previous()),
      };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      if (this.match("LPAREN")) {
        const args: Expr[] = [];
        const namedArgs: NamedArg[] = [];
        // The original of the shape §14.6 carried to every other parenthesised list.
        this.parseCommaSeparated(() => {
          if (this.isNamedArgStart()) {
            namedArgs.push(this.parseNamedArg());
          } else {
            args.push(this.parseExpression(0));
          }
        });
        this.expect("RPAREN", "expected ')' in a call");
        expr = {
          kind: "Call",
          callee: expr,
          args,
          namedArgs,
          span: makeSpan(this.file, expr.span.start, this.previous().span.end),
        };
      } else if (this.match("DOT")) {
        // §15.15 counts a member name among the positions where a scene word is a name,
        // and this site was still asking for an IDENTIFIER — so `log.visible(x)` reported
        // while `var visible = 1` compiled. The second hole of the same kind found the
        // same way: the rule was widened and not every position it claims was walked.
        // A member name has no ambiguity at all — nothing follows a `.` but a name.
        const nameToken = this.expectName("member name after '.'");
        expr = {
          kind: "Member",
          object: expr,
          name: this.nameOf(nameToken),
          span: makeSpan(this.file, expr.span.start, nameToken.span.end),
        };
      } else if (this.match("LBRACKET")) {
        const index = this.parseExpression(0);
        this.skipNewlineIndents();
        const close = this.expect("RBRACKET", "expected ']' after the index");
        expr = {
          kind: "Index",
          object: expr,
          index,
          span: makeSpan(this.file, expr.span.start, close.span.end),
        };
      } else {
        break;
      }
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    // DSL keywords usable as native functions in expression position
    // (keyword + "("): canvas(w, h), fill(c, ch), box(...), put(...), line(...).
    if (
      (token.type === "CANVAS" ||
        token.type === "FILL" ||
        token.type === "PUT" ||
        token.type === "BOX" ||
        token.type === "LINE") &&
      this.peek(1).type === "LPAREN"
    ) {
      this.advance();
      return { kind: "Ident", name: tokenLexeme(token), span: token.span };
    }
    // A scene word standing where a value goes is a NAME (§15.15). The DSL's own uses are
    // reached by `expect`/`match` on the token type from inside a primitive or after `on`,
    // and never through here, so the two readings do not compete.
    if (NAMEABLE_DSL_TOKENS.has(token.type)) {
      this.advance();
      return { kind: "Ident", name: tokenLexeme(token), span: token.span };
    }
    switch (token.type) {
      case "FUNC": {
        // L2 (docs/language.md §6.3): `func(params) expr` — a lambda. Only the
        // anonymous form is an expression; `func name(...)` remains a statement.
        this.advance();
        this.expect("LPAREN", "expected '(' after 'func' in a lambda");
        const params = this.parseParamList(false);
        this.expect("RPAREN", "expected ')' after the lambda parameters");
        this.checkDuplicateParams(params, "lambda");
        if (this.check("COLON") || this.check("INDENT")) {
          // A block body is a function wanting a name — say so, with the fix.
          this.errorAt(
            this.peek(),
            "a lambda holds one expression — a body with statements needs a named 'func'",
          );
          return {
            kind: "ErrorExpr",
            message: "lambda with a block body",
            span: spanFrom(this.file, token, this.peek()),
          };
        }
        const body = this.parseExpression(0);
        return {
          kind: "Lambda",
          params,
          body,
          span: makeSpan(this.file, token.span.start, body.span.end),
        };
      }
      case "INT":
        this.advance();
        return { kind: "Lit", litKind: "int", value: token.value, span: token.span };
      case "FLOAT":
        this.advance();
        return { kind: "Lit", litKind: "float", value: token.value, span: token.span };
      case "STRING": {
        const token = this.peek();
        this.advance();
        if (!this.check("INTERP_START")) {
          return { kind: "Lit", litKind: "str", value: token.value, span: token.span };
        }
        const parts: (string | Expr)[] = [String(token.value)];
        while (this.match("INTERP_START")) {
          const inner = this.parseExpression(0);
          this.expect("INTERP_END", "expected '}' to close the interpolation");
          const part = this.expect("STRING", "expected more text after the interpolation");
          parts.push(inner, String(part.value));
        }
        return {
          kind: "InterpolatedStr",
          parts,
          span: makeSpan(this.file, token.span.start, this.previous().span.end),
        };
      }
      case "BOOLEAN":
        this.advance();
        return { kind: "Lit", litKind: "bool", value: token.value, span: token.span };
      case "NULL":
        this.advance();
        return { kind: "Lit", litKind: "null", value: null, span: token.span };
      case "LBRACKET": {
        this.advance();
        const items: Expr[] = [];
        this.skipNewlineIndents();
        while (!this.check("RBRACKET") && !this.check("EOF")) {
          this.skipNewlineIndents();
          if (this.check("RBRACKET")) {
            break;
          }
          items.push(this.parseExpression(0));
          if (!this.match("COMMA")) {
            break;
          }
          this.skipNewlineIndents();
          if (this.check("RBRACKET")) {
            break;
          }
        }
        this.skipNewlineIndents();
        const close = this.expect("RBRACKET", "expected ']' to close the list");
        return {
          kind: "ListLit",
          items,
          span: makeSpan(this.file, token.span.start, close.span.end),
        };
      }
      case "LBRACE": {
        this.advance();
        const entries: { key: string; value: Expr; span: Span }[] = [];
        this.skipNewlineIndents();
        while (!this.check("RBRACE") && !this.check("EOF")) {
          this.skipNewlineIndents();
          if (this.check("RBRACE")) {
            break;
          }
          const keyToken = this.peek();
          if (
            keyToken.type !== "STRING" &&
            keyToken.type !== "IDENTIFIER"
          ) {
            this.errorAt(
              keyToken,
              "dict keys must be strings or identifiers",
            );
            this.skipUntil("COMMA", "RBRACE");
            this.match("COMMA");
            continue;
          }
          this.advance();
          const key = String(keyToken.value);
          this.expect("COLON", "expected ':' after the dict key");
          const value = this.parseExpression(0);
          entries.push({
            key,
            value,
            span: makeSpan(this.file, keyToken.span.start, this.previous().span.end),
          });
          if (!this.match("COMMA")) {
            break;
          }
          this.skipNewlineIndents();
          if (this.check("RBRACE")) {
            break;
          }
        }
        this.skipNewlineIndents();
        const close = this.expect("RBRACE", "expected '}' to close the dict");
        return {
          kind: "DictLit",
          entries,
          span: makeSpan(this.file, token.span.start, close.span.end),
        };
      }
      case "IDENTIFIER":
        this.advance();
        return { kind: "Ident", name: String(token.value), span: token.span };
      case "LPAREN": {
        this.advance();
        const x = this.parseExpression(0);
        if (!this.match("COMMA")) {
          // No comma: this is GROUPING, not a broken tuple.
          //
          // `(` used to always start a tuple, which made `(a + b) * 4` a syntax error —
          // parentheses could not override precedence anywhere in the language. Nothing
          // caught it because no example had ever needed to group arithmetic; the first
          // real game logic written in QBSK hit it in its first ten lines.
          //
          // A tuple is still exactly what it was: the comma is what makes one, which is
          // how every language that has both resolves the ambiguity.
          if (this.check("RPAREN")) {
            this.advance();
            return x;
          }
          const msg = "expected ')' to close the group, or ',' for a tuple: (x, y)";
          this.errorAt(this.peek(), msg);
          this.skipUntil("RPAREN");
          this.match("RPAREN");
          return {
            kind: "ErrorExpr",
            message: msg,
            span: spanFrom(this.file, token, this.previous()),
          };
        }
        const y = this.parseExpression(0);
        this.expect("RPAREN", "expected ')' in the tuple");
        return {
          kind: "Tuple",
          x,
          y,
          span: spanFrom(this.file, token, this.previous()),
        };
      }
      case "INTERP_END":
        this.advance();
        return {
          kind: "ErrorExpr",
          message: "empty interpolation expression",
          span: token.span,
        };
      default: {
        this.advance();
        // §15.25 — an operator that opens a line is almost always someone who meant
        // to continue the line above it, and the fix is one character on the OTHER line.
        // Saying only "unexpected expression: '+'" is true and leaves them staring at a
        // line that looks perfectly reasonable.
        const hint =
          token.startsLine === true && BINARY_PRECEDENCE[token.type] !== undefined
            ? ` — an operator at the start of a line does not continue the line above` +
              `; put it at the END of that line instead`
            : "";
        const msg = `unexpected expression: '${tokenLexeme(token)}'${hint}`;
        this.errorAt(token, msg);
        return { kind: "ErrorExpr", message: msg, span: token.span };
      }
    }
  }
}
