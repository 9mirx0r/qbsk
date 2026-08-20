export interface Position {
  line: number;
  col: number;
  offset: number;
}

export interface Span {
  file: string;
  start: Position;
  end: Position;
}

export const KEYWORDS = {
  scene: "SCENE",
  layer: "LAYER",
  sprite: "SPRITE",
  box: "BOX",
  border: "BORDER",
  line: "LINE",
  text: "TEXT",
  tone: "TONE",
  shade: "SHADE",
  fill: "FILL",
  put: "PUT",
  canvas: "CANVAS",
  color: "COLOR",
  anchor: "ANCHOR",
  at: "AT",
  from: "FROM",
  to: "TO",
  z: "Z",
  style: "STYLE",
  visible: "VISIBLE",
  world: "WORLD",
  on: "ON",
  tick: "TICK",
  key: "KEY",
  resize: "RESIZE",
  start: "START",
  when: "WHEN",
  if: "IF",
  elif: "ELIF",
  else: "ELSE",
  while: "WHILE",
  for: "FOR",
  in: "IN",
  return: "RETURN",
  match: "MATCH",
  use: "USE",
  break: "BREAK",
  continue: "CONTINUE",
  and: "AND",
  or: "OR",
  not: "NOT",
  var: "VAR",
  const: "CONST",
  func: "FUNC",
  export: "EXPORT",
  as: "AS",
  try: "TRY",
  catch: "CATCH",
  true: "BOOLEAN",
  false: "BOOLEAN",
  null: "NULL",
} as const;

export type TokenType =
  | "IDENTIFIER"
  | "INT"
  | "FLOAT"
  | "STRING"
  | "INDENT"
  | "DEDENT"
  | "EOF"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "PERCENT"
  | "EQ_EQ"
  | "BANG_EQ"
  | "LT"
  | "GT"
  | "LTE"
  | "GTE"
  | "EQ"
  | "LPAREN"
  | "RPAREN"
  | "LBRACKET"
  | "RBRACKET"
  | "LBRACE"
  | "RBRACE"
  | "INTERP_START"
  | "INTERP_END"
  | "COMMA"
  | "COLON"
  | "DOT"
  | "DOT_DOT"
  | "BANG"
  | "AMP"
  | "PIPE"
  | "CARET"
  | "SHL"
  | "SHR"
  | "PLUS_EQ"
  | "MINUS_EQ"
  | (typeof KEYWORDS)[keyof typeof KEYWORDS];

export type TokenValue = string | number | boolean | null;

export interface Token {
  type: TokenType;
  value: TokenValue;
  span: Span;
  /**
   * This token opens a physical line that is NOT a continuation (§15.25).
   *
   * QBSK emits no end-of-line token and emits layout only when the indentation changes,
   * so two statements at one level reach the parser with nothing between them. This is
   * that nothing, made visible: no construct reads across a token carrying this.
   *
   * Absent, rather than false, on every other token — the flag is set on roughly one
   * token per line and a property assigned to every token would change the shape of the
   * object the whole lexer allocates.
   */
  startsLine?: boolean;
}

export function makeSpan(
  file: string,
  start: Position,
  end: Position,
): Span {
  return { file, start, end };
}

export function positionOf(offset: number, line: number, col: number): Position {
  return { offset, line, col };
}
