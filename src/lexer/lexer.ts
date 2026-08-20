import { QbskSyntaxError } from "../interp/error.js";
import {
  KEYWORDS,
  type Span,
  type Token,
  type TokenType,
  type TokenValue,
} from "./token.js";

const TWO_CHAR_OPERATORS: Record<string, TokenType> = {
  "==": "EQ_EQ",
  "!=": "BANG_EQ",
  "<=": "LTE",
  ">=": "GTE",
  "+=": "PLUS_EQ",
  "-=": "MINUS_EQ",
  "..": "DOT_DOT",
  // L4 (docs/language.md §6.4): shifts. Two-char table is consulted before the
  // one-char table, so `<<` never lexes as two `<`s.
  "<<": "SHL",
  ">>": "SHR",
};

const SINGLE_CHAR_OPERATORS: Record<string, TokenType> = {
  "+": "PLUS",
  "-": "MINUS",
  "*": "STAR",
  "/": "SLASH",
  "%": "PERCENT",
  "=": "EQ",
  "(": "LPAREN",
  ")": "RPAREN",
  "[": "LBRACKET",
  "]": "RBRACKET",
  "{": "LBRACE",
  "}": "RBRACE",
  ",": "COMMA",
  ":": "COLON",
  ".": "DOT",
  "!": "BANG",
  "&": "AMP",
  "|": "PIPE",
  "^": "CARET",
  "<": "LT",
  ">": "GT",
};

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/**
 * The tokens that cannot end a statement, so a line ending in one continues (§15.23).
 *
 * `COLON` is deliberately absent and could not be added: it opens a block, so a line
 * ending in `:` is already meaningful and already common.
 *
 * The brackets are absent too, because §15.14 already holds a line open inside them by
 * counting depth — a second rule saying the same thing could only disagree with the
 * first.
 */
const CONTINUES: ReadonlySet<TokenType> = new Set<TokenType>([
  "PLUS",
  "MINUS",
  "STAR",
  "SLASH",
  "PERCENT",
  "EQ_EQ",
  "BANG_EQ",
  "LT",
  "GT",
  "LTE",
  "GTE",
  "EQ",
  "PLUS_EQ",
  "MINUS_EQ",
  "AND",
  "OR",
  "NOT",
  "COMMA",
  "DOT",
  "DOT_DOT",
  "AMP",
  "PIPE",
  "CARET",
  "SHL",
  "SHR",
]);

export class Lexer {
  private readonly file: string;
  private readonly src: string;
  private pos = 0;
  private line = 1;
  private col = 1;
  private readonly tokens: Token[] = [];
  private readonly indents: number[] = [0];
  private atLineStart = true;
  // §15.14 — how many brackets are open. Inside one, a line break carries no meaning, so
  // no INDENT and no DEDENT is emitted and the indent stack is left alone.
  //
  // This belongs to the LEXER and not to the parser, which is where it was first put. A
  // parser that SKIPS the layout tokens skips the INDENT and still receives its DEDENT,
  // and that surplus DEDENT closes whatever block the expression was written in. Not
  // emitting the pair is the only version of the rule that cannot leave the stack askew.
  private brackets = 0;

  constructor(source: string, file = "<stdin>") {
    this.file = file;
    // §15.8 — a UTF-8 BOM is consumed, not reported. Windows editors write one by
    // default, and leaving it in produced `unexpected character '\uFEFF'` at 1:1: an
    // error whose offending character is invisible, on a file that is otherwise valid.
    // Stripping only the leading one keeps offsets right for everything after it.
    const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
    this.src = withoutBom.replace(/\r\n?/g, "\n");
  }

  tokenize(): Token[] {
    while (!this.isAtEnd()) {
      if (this.atLineStart) {
        this.handleLineStart();
        if (this.isAtEnd()) {
          break;
        }
      }
      const ch = this.peek();
      if (ch === "\n") {
        this.advance();
        this.atLineStart = true;
        continue;
      }
      if (ch === " " || ch === "\t") {
        if (ch === "\t") {
          this.errorAt("tabs are not allowed: use 4 spaces to indent");
        }
        this.advance();
        continue;
      }
      if (ch === "/" && this.peekNext() === "/") {
        this.skipLineComment();
        continue;
      }
      if (ch === "/" && this.peekNext() === "*") {
        this.skipBlockComment();
        continue;
      }
      if (ch === '"') {
        this.scanStringOrCanvas();
        continue;
      }
      if (isDigit(ch) || (ch === "." && isDigit(this.peekNext()))) {
        this.scanNumber();
        continue;
      }
      if (isIdentStart(ch)) {
        this.scanIdentifier();
        continue;
      }
      if (this.scanOperator()) {
        continue;
      }
      this.errorAt(`unexpected character '${ch}'`);
    }
    this.flushFinalDedents();
    this.tokens.push({
      type: "EOF",
      value: null,
      span: this.spanAt(0),
    });
    return this.tokens;
  }

  /**
   * Did the previous line end on something that cannot end a statement? (§15.23)
   *
   * Every token in CONTINUES is a syntax error at the end of a line in every QBSK program
   * written so far, which is what makes reading the next line as its continuation safe:
   * widening an error into a working case is not a break (§17.1).
   *
   * Blank and comment lines never reach here — `handleLineStart` returns before this
   * for them — so the operator is still the last token seen and a continuation may be
   * separated from its opening by either.
   */
  private lineIsUnfinished(): boolean {
    const last = this.tokens[this.tokens.length - 1];
    return last !== undefined && CONTINUES.has(last.type);
  }

  private handleLineStart(): void {
    const level = this.measureIndent();
    if (this.atLineEndOrComment()) {
      return;
    }
    if (this.brackets > 0) {
      // A continuation line. Its indentation is decoration: the expression is held open
      // by the bracket, not by the layout.
      this.atLineStart = false;
      return;
    }
    if (this.lineIsUnfinished()) {
      // §15.23 — the previous line ended on an operator, so it was not a statement
      // and this line is the rest of it. Handled exactly like the bracket case, and for
      // the same reason: emitting the INDENT without its DEDENT, or the DEDENT without
      // its INDENT, leaves the indent stack askew and closes a block nobody closed.
      this.atLineStart = false;
      return;
    }
    const top = this.indents[this.indents.length - 1];
    const start = this.spanAt(0);
    if (level > (top ?? 0)) {
      this.indents.push(level);
      this.tokens.push({ type: "INDENT", value: null, span: start });
    } else if (level < (top ?? 0)) {
      while (
        this.indents.length > 1 &&
        (this.indents[this.indents.length - 1] ?? 0) > level
      ) {
        this.indents.pop();
        this.tokens.push({ type: "DEDENT", value: null, span: start });
      }
      if (this.indents[this.indents.length - 1] !== level) {
        this.errorAt(
          `indentation level ${level} does not match any open level`,
        );
      }
    }
    this.atLineStart = false;
  }

  private measureIndent(): number {
    let count = 0;
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === " ") {
        count++;
        this.advance();
      } else if (ch === "\t") {
        this.errorAt("tabs are not allowed: use 4 spaces to indent");
      } else {
        break;
      }
    }
    return count;
  }

  private atLineEndOrComment(): boolean {
    const ch = this.peek();
    if (ch === "\n" || this.isAtEnd()) {
      return true;
    }
    if (ch === "/" && this.peekNext() === "/") {
      this.skipLineComment();
      return true;
    }
    if (ch === "/" && this.peekNext() === "*") {
      this.skipBlockComment();
      return true;
    }
    return false;
  }

  private skipLineComment(): void {
    while (!this.isAtEnd() && this.peek() !== "\n") {
      this.advance();
    }
  }

  private skipBlockComment(): void {
    const start = this.spanAt(0);
    this.advance();
    this.advance();
    while (!this.isAtEnd()) {
      if (this.peek() === "*" && this.peekNext() === "/") {
        this.advance();
        this.advance();
        return;
      }
      this.advance();
    }
    const end = { ...start.start, col: start.start.col + 2, offset: start.start.offset + 2 };
    this.error("unterminated block comment", { ...start, end });
  }

  private scanStringOrCanvas(): void {
    const start = this.spanAt(0);
    if (this.peek() === '"' && this.peekNext() === '"' && this.peekNextAt(2) === '"') {
      this.scanCanvasLiteral(start);
      return;
    }
    this.scanStringBody(start);
  }

  private scanStringBody(start: Span): void {
    this.advance();
    let partStart = start;
    let value = "";
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === '"') {
        this.advance();
        this.tokens.push({ type: "STRING", value, span: this.spanBetween(partStart) });
        return;
      }
      if (ch === "\n") {
        this.error("unterminated string (use \"\"\" for multi-line text)", this.spanBetween(start));
      }
      if (ch === "\\") {
        value += this.scanEscape(start);
        continue;
      }
      if (ch === "{") {
        if (this.peekNext() === "{") {
          value += "{";
          this.advance();
          this.advance();
          continue;
        }
        this.tokens.push({ type: "STRING", value, span: this.spanBetween(partStart) });
        const ipStart = this.spanAt(0);
        this.advance();
        this.tokens.push({
          type: "INTERP_START",
          value: null,
          span: this.spanBetween(ipStart),
        });
        this.scanInterpExpression(start);
        partStart = this.spanAt(0);
        value = "";
        continue;
      }
      if (ch === "}") {
        value += "}";
        this.advance();
        if (this.peek() === "}") {
          this.advance();
        }
        continue;
      }
      value += ch;
      this.advance();
    }
    this.error("unterminated string", this.spanBetween(start));
  }

  private scanInterpExpression(stringStart: Span): void {
    // Interpolation cannot span lines (it reports below if it tries), so its brackets can
    // never hold a line break open. Saved and restored anyway, so that an unbalanced one
    // inside a `{}` cannot leave the count — and with it the rest of the file's
    // indentation — permanently off.
    const outerBrackets = this.brackets;
    let depth = 0;
    while (!this.isAtEnd()) {
      const ch = this.peek();
      if (ch === '"') {
        this.scanStringBody(this.spanAt(0));
        continue;
      }
      if (ch === "{") {
        depth++;
        const start = this.spanAt(0);
        this.advance();
        this.tokens.push({ type: "LBRACE", value: null, span: this.spanBetween(start) });
        continue;
      }
      if (ch === "}") {
        const start = this.spanAt(0);
        this.advance();
        if (depth === 0) {
          this.tokens.push({ type: "INTERP_END", value: null, span: this.spanBetween(start) });
          this.brackets = outerBrackets;
          return;
        }
        depth--;
        this.tokens.push({ type: "RBRACE", value: null, span: this.spanBetween(start) });
        continue;
      }
      if (ch === "\n") {
        this.error(
          "unterminated string (interpolation cannot span lines)",
          this.spanBetween(stringStart),
        );
      }
      if (ch === "\t") {
        this.errorAt("tabs are not allowed: use 4 spaces to indent");
      }
      if (ch === " ") {
        this.advance();
        continue;
      }
      if (ch === "/" && this.peekNext() === "/") {
        this.skipLineComment();
        continue;
      }
      if (ch === "/" && this.peekNext() === "*") {
        this.skipBlockComment();
        continue;
      }
      if (isDigit(ch) || (ch === "." && isDigit(this.peekNext()))) {
        this.scanNumber();
        continue;
      }
      if (isIdentStart(ch)) {
        this.scanIdentifier();
        continue;
      }
      if (this.scanOperator()) {
        continue;
      }
      this.errorAt(`unexpected character '${ch}' inside interpolation`);
    }
    this.error("unterminated interpolation (missing '}')", this.spanBetween(stringStart));
  }

  private scanEscape(start: Span): string {
    this.advance();
    if (this.isAtEnd()) {
      this.error("incomplete escape at end of file", this.spanBetween(start));
    }
    const ch = this.peek();
    this.advance();
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        this.error(`unknown escape '\\${ch}'`, this.spanBetween(start));
    }
  }

  private scanCanvasLiteral(start: Span): void {
    this.advance();
    this.advance();
    this.advance();
    let raw = "";
    while (!this.isAtEnd()) {
      if (this.peek() === '"' && this.peekNext() === '"' && this.peekNextAt(2) === '"') {
        this.advance();
        this.advance();
        this.advance();
        if (raw.startsWith("\n")) {
          raw = raw.slice(1);
        }
        const lines = raw.split("\n");
        if (lines.length > 1 && (lines[lines.length - 1] ?? "").trim() === "") {
          lines.pop();
        }
        let min = Infinity;
        for (const line of lines) {
          if (line.trim() !== "") {
            const indent = line.match(/^ */)?.[0].length ?? 0;
            if (indent < min) {
              min = indent;
            }
          }
        }
        const value = lines.map((line) => line.slice(min === Infinity ? 0 : min)).join("\n");
        this.tokens.push({ type: "STRING", value, span: this.spanBetween(start) });
        return;
      }
      raw += this.peek();
      this.advance();
    }
    this.error("unterminated canvas block (missing \"\"\")", this.spanBetween(start));
  }

  private scanNumber(): void {
    const start = this.spanAt(0);
    let isFloat = false;
    while (isDigit(this.peek())) {
      this.advance();
    }
    if (this.peek() === "." && isDigit(this.peekNext())) {
      isFloat = true;
      this.advance();
      while (isDigit(this.peek())) {
        this.advance();
      }
    }
    if (this.peek() === "e" || this.peek() === "E") {
      const afterE = this.peekNextAt(1);
      if (
        isDigit(afterE) ||
        ((afterE === "+" || afterE === "-") && isDigit(this.peekNextAt(2)))
      ) {
        isFloat = true;
        this.advance();
        if (this.peek() === "+" || this.peek() === "-") {
          this.advance();
        }
        while (isDigit(this.peek())) {
          this.advance();
        }
      }
    }
    const lexeme = this.src.slice(start.start.offset, this.pos);
    const value = isFloat ? Number.parseFloat(lexeme) : Number.parseInt(lexeme, 10);
    this.tokens.push({
      type: isFloat ? "FLOAT" : "INT",
      value,
      span: this.spanBetween(start),
    });
  }

  private scanIdentifier(): void {
    const start = this.spanAt(0);
    while (isIdentPart(this.peek())) {
      this.advance();
    }
    const lexeme = this.src.slice(start.start.offset, this.pos);
    const keyword = KEYWORDS[lexeme as keyof typeof KEYWORDS];
    if (keyword !== undefined) {
      const value: TokenValue =
        lexeme === "true" ? true : lexeme === "false" ? false : null;
      this.tokens.push({ type: keyword, value, span: this.spanBetween(start) });
      return;
    }
    this.tokens.push({
      type: "IDENTIFIER",
      value: lexeme,
      span: this.spanBetween(start),
    });
  }

  private scanOperator(): boolean {
    const two = this.src.slice(this.pos, this.pos + 2);
    const twoType = TWO_CHAR_OPERATORS[two];
    if (twoType !== undefined) {
      const start = this.spanAt(0);
      this.advance();
      this.advance();
      this.tokens.push({ type: twoType, value: null, span: this.spanBetween(start) });
      return true;
    }
    const ch = this.peek();
    const oneType = SINGLE_CHAR_OPERATORS[ch];
    if (oneType !== undefined) {
      const start = this.spanAt(0);
      this.advance();
      this.tokens.push({ type: oneType, value: null, span: this.spanBetween(start) });
      if (ch === "(" || ch === "[" || ch === "{") {
        this.brackets++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        // Floored rather than allowed negative: a stray `)` is the parser's to report,
        // and a negative count here would turn one bad character into a file whose
        // indentation stopped meaning anything.
        this.brackets = Math.max(0, this.brackets - 1);
      }
      return true;
    }
    return false;
  }

  private flushFinalDedents(): void {
    while (this.indents.length > 1) {
      this.indents.pop();
      this.tokens.push({ type: "DEDENT", value: null, span: this.spanAt(0) });
    }
  }

  private spanAt(len: number): Span {
    const start = this.positionNow();
    return {
      file: this.file,
      start,
      end: { offset: start.offset + len, line: start.line, col: start.col + len },
    };
  }

  private spanBetween(start: Span): Span {
    return { file: this.file, start: start.start, end: this.positionNow() };
  }

  private positionNow() {
    return { offset: this.pos, line: this.line, col: this.col };
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private peekNext(): string {
    return this.src[this.pos + 1] ?? "";
  }

  private peekNextAt(n: number): string {
    return this.src[this.pos + n] ?? "";
  }

  private advance(): string {
    const ch = this.src[this.pos] ?? "";
    this.pos++;
    if (ch === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private isAtEnd(): boolean {
    return this.pos >= this.src.length;
  }

  private errorAt(message: string, len = 1): never {
    throw new QbskSyntaxError(message, this.spanAt(len));
  }

  private error(message: string, span: Span): never {
    throw new QbskSyntaxError(message, span);
  }
}

export function tokenize(source: string, file = "<stdin>"): Token[] {
  return new Lexer(source, file).tokenize();
}
