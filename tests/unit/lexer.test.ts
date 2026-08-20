import { describe, expect, it } from "vitest";
import { tokenize, Lexer } from "../../src/lexer/lexer.js";
import type { Token } from "../../src/lexer/token.js";

function types(src: string): string[] {
  return tokenize(src, "test.qbsk").map((t) => t.type);
}

function tokens(src: string): Token[] {
  return tokenize(src, "test.qbsk");
}

describe("tokenize: basics", () => {
  it("empty source → only EOF", () => {
    expect(types("")).toEqual(["EOF"]);
  });

  it("identifiers", () => {
    const ts = tokens("foo _bar baz42");
    expect(ts.map((t) => t.type)).toEqual(["IDENTIFIER", "IDENTIFIER", "IDENTIFIER", "EOF"]);
    expect(ts.map((t) => t.value)).toEqual(["foo", "_bar", "baz42", null]);
  });

  it("integers", () => {
    const ts = tokens("0 42 007");
    expect(ts.map((t) => t.type)).toEqual(["INT", "INT", "INT", "EOF"]);
    expect(ts.map((t) => t.value)).toEqual([0, 42, 7, null]);
  });

  it("floats: decimal, leading dot, exponent", () => {
    const ts = tokens("3.5 .5 1e3 2.5e-2");
    expect(ts.map((t) => t.type)).toEqual(["FLOAT", "FLOAT", "FLOAT", "FLOAT", "EOF"]);
    expect(ts.map((t) => t.value)).toEqual([3.5, 0.5, 1000, 0.025, null]);
  });

  it("int and float are distinct types", () => {
    const ts = tokens("42 42.0");
    expect(ts[0]?.type).toBe("INT");
    expect(ts[1]?.type).toBe("FLOAT");
  });

  it("strings with escapes", () => {
    const ts = tokens('"a\\nb\\tc"');
    expect(ts[0]?.type).toBe("STRING");
    expect(ts[0]?.value).toBe("a\nb\tc");
  });

  it("strings with escaped quotes and backslashes", () => {
    const ts = tokens('"\\"hello\\" \\\\ "');
    expect(ts[0]?.value).toBe('"hello" \\ ');
  });

  it("booleans and null", () => {
    const ts = tokens("true false null");
    expect(ts.map((t) => t.type)).toEqual(["BOOLEAN", "BOOLEAN", "NULL", "EOF"]);
    expect(ts.map((t) => t.value)).toEqual([true, false, null, null]);
  });

  it("recognized keywords", () => {
    const kw = types(
      "scene layer sprite box border line text fill put canvas color anchor at from to z style on tick key resize start if elif else while for in return match use export as break continue and or not var const func try catch",
    );
    expect(kw).toEqual([
      "SCENE", "LAYER", "SPRITE", "BOX", "BORDER", "LINE", "TEXT",
      "FILL", "PUT", "CANVAS", "COLOR", "ANCHOR", "AT", "FROM", "TO", "Z",
      "STYLE", "ON", "TICK", "KEY", "RESIZE", "START", "IF", "ELIF", "ELSE",
      "WHILE", "FOR", "IN", "RETURN", "MATCH", "USE", "EXPORT", "AS", "BREAK",
      "CONTINUE",
      "AND", "OR", "NOT", "VAR", "CONST", "FUNC", "TRY", "CATCH", "EOF",
    ]);
  });

  it("sprinkle is no longer a keyword — the name went back to the author (§14.5)", () => {
    expect(types("sprinkle")).toEqual(["IDENTIFIER", "EOF"]);
  });

  it("single-character operators", () => {
    expect(types("+ - * / % = ( ) , : . ! & | < >")).toEqual([
      "PLUS", "MINUS", "STAR", "SLASH", "PERCENT", "EQ", "LPAREN", "RPAREN",
      "COMMA", "COLON", "DOT", "BANG", "AMP", "PIPE", "LT", "GT", "EOF",
    ]);
  });

  it("two-character operators", () => {
    expect(types("== != <= >= += -= ..")).toEqual([
      "EQ_EQ", "BANG_EQ", "LTE", "GTE", "PLUS_EQ", "MINUS_EQ", "DOT_DOT", "EOF",
    ]);
  });

  it("brackets and braces for lists/dicts (L1.5)", () => {
    expect(types("[ ] { } ,")).toEqual([
      "LBRACKET", "RBRACKET", "LBRACE", "RBRACE", "COMMA", "EOF",
    ]);
  });

  it("'..' does not compete with numbers", () => {
    expect(types("0..10")).toEqual(["INT", "DOT_DOT", "INT", "EOF"]);
  });
});

describe("tokenize: string interpolation (L2)", () => {
  it("literal parts with INTERP_START/END", () => {
    const ts = tokens('"hello {name}"');
    expect(ts.map((t) => t.type)).toEqual([
      "STRING", "INTERP_START", "IDENTIFIER", "INTERP_END", "STRING", "EOF",
    ]);
    expect(ts.map((t) => t.value)).toEqual(["hello ", null, "name", null, "", null]);
  });

  it("several interpolations in one string", () => {
    const ts = tokens('"a{x}b{y}c"');
    expect(ts.map((t) => t.type)).toEqual([
      "STRING", "INTERP_START", "IDENTIFIER", "INTERP_END",
      "STRING", "INTERP_START", "IDENTIFIER", "INTERP_END", "STRING", "EOF",
    ]);
    expect(ts.map((t) => t.value)).toEqual([
      "a", null, "x", null, "b", null, "y", null, "c", null,
    ]);
  });

  it("escapes inside the literal parts", () => {
    const ts = tokens('"a\\nb{c}d"');
    expect(ts[0]?.value).toBe("a\nb");
    expect(ts[4]?.value).toBe("d");
  });

  it("{{ escapes to a literal { (does not open interpolation)", () => {
    const ts = tokens('"a{{b"');
    expect(ts.map((t) => t.type)).toEqual(["STRING", "EOF"]);
    expect(ts[0]?.value).toBe("a{b");
  });

  it("stray } in the string is literal", () => {
    const ts = tokens('"a}b"');
    expect(ts.map((t) => t.type)).toEqual(["STRING", "EOF"]);
    expect(ts[0]?.value).toBe("a}b");
  });

  it("}} escapes to a literal } (symmetric with {{)", () => {
    const ts = tokens('"a}}b"');
    expect(ts.map((t) => t.type)).toEqual(["STRING", "EOF"]);
    expect(ts[0]?.value).toBe("a}b");
  });

  it("}} at the end of the string escapes to a literal }", () => {
    const ts = tokens('"a}}"');
    expect(ts.map((t) => t.type)).toEqual(["STRING", "EOF"]);
    expect(ts[0]?.value).toBe("a}");
  });

  it("symmetric braces around an interpolation: {{{pct}}}", () => {
    const ts = tokens('"percentage: {{{pct}}}"');
    expect(ts.map((t) => t.type)).toEqual([
      "STRING", "INTERP_START", "IDENTIFIER", "INTERP_END", "STRING", "EOF",
    ]);
    expect(ts.map((t) => t.value)).toEqual(["percentage: {", null, "pct", null, "}", null]);
  });

  it("dict literal inside interpolation (as a subexpression)", () => {
    const ts = tokens('"r: {f({"a": 1})}"');
    expect(ts.map((t) => t.type)).toEqual([
      "STRING", "INTERP_START", "IDENTIFIER", "LPAREN", "LBRACE", "STRING",
      "COLON", "INT", "RBRACE", "RPAREN", "INTERP_END", "STRING", "EOF",
    ]);
  });

  it("nested dicts close the interpolation at the right }", () => {
    const ts = tokens('"r: {f({"a": {"b": 2}})}"');
    expect(ts.map((t) => t.type)).toEqual([
      "STRING", "INTERP_START", "IDENTIFIER", "LPAREN", "LBRACE", "STRING",
      "COLON", "LBRACE", "STRING", "COLON", "INT", "RBRACE", "RBRACE",
      "RPAREN", "INTERP_END", "STRING", "EOF",
    ]);
  });

  it("nested string that interpolates in turn", () => {
    const ts = tokens('"r: {f("x{1}")}"');
    expect(ts.map((t) => t.type)).toEqual([
      "STRING", "INTERP_START", "IDENTIFIER", "LPAREN", "STRING",
      "INTERP_START", "INT", "INTERP_END", "STRING", "RPAREN",
      "INTERP_END", "STRING", "EOF",
    ]);
  });

  it("plain nested string (no interpolation) inside interpolation", () => {
    const ts = tokens('"r: {len("hello")}"');
    expect(ts.map((t) => t.type)).toEqual([
      "STRING", "INTERP_START", "IDENTIFIER", "LPAREN", "STRING",
      "RPAREN", "INTERP_END", "STRING", "EOF",
    ]);
  });

  it("operators inside interpolation", () => {
    const ts = tokens('"total: {a + b * 2}"');
    expect(ts.map((t) => t.type)).toEqual([
      "STRING", "INTERP_START", "IDENTIFIER", "PLUS", "IDENTIFIER", "STAR",
      "INT", "INTERP_END", "STRING", "EOF",
    ]);
  });

  it("canvas block does not interpolate", () => {
    const ts = tokens('"""hello {x}"""');
    expect(ts.map((t) => t.type)).toEqual(["STRING", "EOF"]);
    expect(ts[0]?.value).toBe("hello {x}");
  });

  it("unclosed interpolation → error", () => {
    expect(() => tokens('"hello {x')).toThrow(/unterminated interpolation/);
  });

  it("part spans: correct line and column", () => {
    const ts = tokens('var s = "a{x}b"');
    const ip = ts.find((t) => t.type === "INTERP_START");
    expect(ip?.span.start.col).toBe(11);
    const end = ts.find((t) => t.type === "INTERP_END");
    expect(end?.span.start.col).toBe(13);
  });
});

describe("tokenize: indentation", () => {
  it("a simple block emits INDENT/DEDENT", () => {
    expect(types("var a = 1\n    var b = 2\nvar c = 3")).toEqual([
      "VAR", "IDENTIFIER", "EQ", "INT",
      "INDENT",
      "VAR", "IDENTIFIER", "EQ", "INT",
      "DEDENT",
      "VAR", "IDENTIFIER", "EQ", "INT",
      "EOF",
    ]);
  });

  it("nested indentation of two levels", () => {
    const ts = types("if true\n    if true\n        var x = 1\n    var y = 2");
    expect(ts.filter((t) => t === "INDENT" || t === "DEDENT")).toEqual([
      "INDENT", "INDENT", "DEDENT", "DEDENT",
    ]);
  });

  it("multiple DEDENTs on one line", () => {
    const ts = types("a\n    b\n        c\nx");
    expect(ts.filter((t) => t === "DEDENT").length).toBe(2);
  });

  it("blank lines do not generate tokens", () => {
    expect(types("var a = 1\n\n\nvar b = 2")).toEqual([
      "VAR", "IDENTIFIER", "EQ", "INT",
      "VAR", "IDENTIFIER", "EQ", "INT", "EOF",
    ]);
  });

  it("indent with the standard 4 spaces", () => {
    expect(types("var a = 1\n    var b = 2")).toContain("INDENT");
  });

  it("comment lines do not break blocks", () => {
    const ts = types("var a = 1\n    // comment\n    var b = 2");
    expect(ts).toContain("INDENT");
    expect(ts.filter((t) => t === "COMMENT" || t === "SLASH")).toHaveLength(0);
  });

  it("final DEDENTs are emitted at EOF", () => {
    const ts = types("var a = 1\n    var b = 2");
    expect(ts[ts.length - 2]).toBe("DEDENT");
    expect(ts[ts.length - 1]).toBe("EOF");
  });

  it("error: mismatched indentation level", () => {
    expect(() => types("var a = 1\n    var b = 2\n      var c = 3\n  var d = 4")).toThrow(
      /does not match/,
    );
  });

  it("error: tab inside block", () => {
    expect(() => types("var a = 1\n\tvar b = 2")).toThrow(/tabs are not allowed/);
  });

  it("error: tab at line start", () => {
    expect(() => types("\tvar a = 1")).toThrow(/tabs are not allowed/);
  });
});

describe("tokenize: comments", () => {
  it("line comment is skipped", () => {
    expect(types("var a = 1 // this is a comment")).toEqual([
      "VAR", "IDENTIFIER", "EQ", "INT", "EOF",
    ]);
  });

  it("block comment is skipped", () => {
    expect(types("/* hello */ var a = 1")).toEqual([
      "VAR", "IDENTIFIER", "EQ", "INT", "EOF",
    ]);
  });

  it("multi-line block comment keeps lines", () => {
    const ts = tokens("var a = 1 /*\nline 2\nline 3*/\nvar b = 2");
    expect(ts[4]?.type).toBe("VAR");
    expect(ts[5]?.value).toBe("b");
  });

  it("error: unterminated block comment", () => {
    expect(() => types("/* never closes")).toThrow(/unterminated/);
  });
});

describe("tokenize: canvas blocks (Skill A)", () => {
  it("multi-line literal as a single raw STRING", () => {
    const ts = tokens('canvas art at (1, 1):\n    """\n     O\n    /|\\\n    """');
    const str = ts.find((t) => t.type === "STRING");
    expect(str?.value).toBe(" O\n/|\\");
  });

  it("content does not generate inner INDENT/DEDENT", () => {
    const ts = types('var s = """\nline\n   with indentation\n"""');
    expect(ts.filter((t) => t === "INDENT" || t === "DEDENT")).toEqual([]);
    expect(ts.filter((t) => t === "STRING")).toHaveLength(1);
  });

  it("canvas block allows single quotes inside", () => {
    const ts = tokens('var s = """\n"hello"\n"""');
    expect(ts.find((t) => t.type === "STRING")?.value).toBe('"hello"');
  });

  it("error: unclosed canvas block", () => {
    expect(() => types('var s = """\nhello')).toThrow(/unterminated/);
  });
});

describe("tokenize: spans and errors", () => {
  it("span with correct line/column/offset", () => {
    const ts = tokens("var\n  x = 1");
    expect(ts[0]?.span.start).toEqual({ line: 1, col: 1, offset: 0 });
    expect(ts[0]?.span.end).toEqual({ line: 1, col: 4, offset: 3 });
    expect(ts[1]?.span.start.line).toBe(2);
    expect(ts[2]?.span.start.col).toBe(3);
  });

  it("error with span: unexpected character", () => {
    try {
      tokens("var a = @");
      expect.unreachable();
    } catch (err) {
      const e = err as { span: { start: { line: number; col: number } } };
      expect(e.span.start.line).toBe(1);
      expect(e.span.start.col).toBe(9);
    }
  });

  it("error: unterminated string", () => {
    expect(() => types('var s = "hello')).toThrow(/unterminated string/);
  });

  it("error: string with newline without triple quotes", () => {
    expect(() => types('var s = "hello\nworld"')).toThrow(/multi-line/);
  });

  it("error: unknown escape", () => {
    expect(() => types('var s = "\\q"')).toThrow(/unknown escape/);
  });

  it("normalizes Windows CRLF", () => {
    expect(types("var a = 1\r\n    var b = 2\r\nvar c = 3")).toContain("INDENT");
  });

  it("EOF token always at the end", () => {
    expect(tokens("var a = 1")[tokens("var a = 1").length - 1]?.type).toBe("EOF");
  });

  it("file name appears in spans", () => {
    const ts = tokenize("x", "my/file.qbsk");
    expect(ts[0]?.span.file).toBe("my/file.qbsk");
  });
});

describe("Lexer class", () => {
  it("instantiable and reusable", () => {
    const lx = new Lexer("var a = 1", "test.qbsk");
    expect(lx.tokenize().length).toBeGreaterThan(0);
    const lx2 = new Lexer("b", "test.qbsk");
    expect(lx2.tokenize()[0]?.type).toBe("IDENTIFIER");
  });
});
