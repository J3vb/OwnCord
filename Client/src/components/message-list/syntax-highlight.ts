/**
 * A small, dependency-free syntax highlighter for fenced code blocks.
 *
 * The client ships no highlighting library (checked against package.json) and
 * a message list is the wrong place to pull one in, so this is a deliberately
 * shallow tokenizer: comments, strings, numbers and keywords — the four things
 * that make code scannable — and nothing that pretends to be a parser.
 *
 * Pure and DOM-free; the renderer turns tokens into spans.
 */

export type TokenClass = "keyword" | "string" | "comment" | "number";

export interface CodeToken {
  readonly text: string;
  /** null renders as plain text. */
  readonly cls: TokenClass | null;
}

interface Pattern {
  /** Sticky: matched only at the current index. */
  readonly re: RegExp;
  readonly cls: TokenClass;
}

interface LangSpec {
  readonly patterns: readonly Pattern[];
  readonly keywords: ReadonlySet<string>;
  readonly ident?: RegExp;
}

const kw = (words: string): ReadonlySet<string> => new Set(words.split(" "));

// -- Shared token patterns ----------------------------------------------------

const SLASH_LINE_COMMENT: Pattern = { re: /\/\/[^\n]*/y, cls: "comment" };
const C_BLOCK_COMMENT: Pattern = { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: "comment" };
const HASH_COMMENT: Pattern = { re: /#[^\n]*/y, cls: "comment" };
const DQ_STRING: Pattern = { re: /"(?:\\.|[^"\\\n])*"?/y, cls: "string" };
const SQ_STRING: Pattern = { re: /'(?:\\.|[^'\\\n])*'?/y, cls: "string" };
const BACKTICK_STRING: Pattern = { re: /`(?:\\.|[^`\\])*`?/y, cls: "string" };
const NUMBER: Pattern = {
  re: /(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z_]*/y,
  cls: "number",
};

const JS_LIKE: readonly Pattern[] = [
  SLASH_LINE_COMMENT,
  C_BLOCK_COMMENT,
  DQ_STRING,
  SQ_STRING,
  BACKTICK_STRING,
  NUMBER,
];

const LANGS: Readonly<Record<string, LangSpec>> = {
  javascript: {
    patterns: JS_LIKE,
    keywords: kw(
      "const let var function return if else for while do break continue class extends new this " +
        "typeof instanceof in of null undefined true false async await import export from default " +
        "try catch finally throw switch case yield static get set delete void super",
    ),
  },
  typescript: {
    patterns: JS_LIKE,
    keywords: kw(
      "const let var function return if else for while do break continue class extends new this " +
        "typeof instanceof in of null undefined true false async await import export from default " +
        "try catch finally throw switch case yield static get set delete void super " +
        "interface type enum implements public private protected readonly as satisfies keyof " +
        "namespace declare abstract infer never unknown any string number boolean",
    ),
  },
  go: {
    patterns: [SLASH_LINE_COMMENT, C_BLOCK_COMMENT, DQ_STRING, BACKTICK_STRING, SQ_STRING, NUMBER],
    keywords: kw(
      "func package import var const type struct interface map chan go defer select switch case " +
        "if else for range return break continue fallthrough default goto nil true false iota " +
        "make new len cap append copy delete panic recover string int int8 int16 int32 int64 uint " +
        "uint8 uint16 uint32 uint64 float32 float64 bool byte rune error any",
    ),
  },
  python: {
    patterns: [
      HASH_COMMENT,
      { re: /(?:"""[\s\S]*?"""|'''[\s\S]*?''')/y, cls: "string" },
      { re: /[rbfu]{0,2}"(?:\\.|[^"\\\n])*"?/y, cls: "string" },
      { re: /[rbfu]{0,2}'(?:\\.|[^'\\\n])*'?/y, cls: "string" },
      NUMBER,
    ],
    keywords: kw(
      "def class return if elif else for while import from as pass break continue try except " +
        "finally raise with lambda None True False and or not in is global nonlocal yield async " +
        "await del assert self print len range str int float bool list dict set tuple",
    ),
  },
  rust: {
    patterns: [
      SLASH_LINE_COMMENT,
      C_BLOCK_COMMENT,
      { re: /r#*"[\s\S]*?"#*/y, cls: "string" },
      DQ_STRING,
      { re: /'(?:\\.|[^'\\\n])'/y, cls: "string" },
      NUMBER,
    ],
    keywords: kw(
      "fn let mut const static struct enum impl trait use pub mod match if else for while loop " +
        "return break continue as where type dyn ref move unsafe crate in true false self Self " +
        "async await Some None Ok Err String Vec Option Result Box i8 i16 i32 i64 u8 u16 u32 u64 " +
        "usize isize f32 f64 bool str char",
    ),
  },
  json: {
    patterns: [DQ_STRING, NUMBER],
    keywords: kw("true false null"),
  },
  bash: {
    patterns: [
      HASH_COMMENT,
      DQ_STRING,
      SQ_STRING,
      { re: /\$(?:\{[^}\n]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9?@#*])/y, cls: "keyword" },
      NUMBER,
    ],
    keywords: kw(
      "if then else elif fi for while until do done case esac function return in export local " +
        "readonly source alias unset shift trap eval exec set echo cd exit sudo apt npm git make",
    ),
  },
  css: {
    patterns: [
      C_BLOCK_COMMENT,
      DQ_STRING,
      SQ_STRING,
      { re: /@[-a-zA-Z]+/y, cls: "keyword" },
      { re: /!important/y, cls: "keyword" },
      { re: /[-a-zA-Z]+(?= *:)/y, cls: "keyword" },
      { re: /#[0-9a-fA-F]{3,8}\b/y, cls: "number" },
      {
        re: /-?\d[\d.]*(?:px|em|rem|ex|ch|%|vh|vw|vmin|vmax|s|ms|deg|turn|fr|pt)?/y,
        cls: "number",
      },
    ],
    keywords: kw(""),
  },
  html: {
    patterns: [
      { re: /<!--[\s\S]*?(?:-->|$)/y, cls: "comment" },
      { re: /<!DOCTYPE[^>\n]*>?/iy, cls: "keyword" },
      { re: /<\/?[A-Za-z][\w:-]*/y, cls: "keyword" },
      DQ_STRING,
      SQ_STRING,
    ],
    keywords: kw(""),
  },
};

/** Aliases accepted after the opening fence. */
const ALIASES: Readonly<Record<string, string>> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  javascript: "javascript",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  go: "go",
  golang: "go",
  py: "python",
  python: "python",
  python3: "python",
  rs: "rust",
  rust: "rust",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  console: "bash",
  css: "css",
  scss: "css",
  html: "html",
  xml: "html",
  svg: "html",
};

const DEFAULT_IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;

/** Canonical language id for a fence tag, or null when unknown. */
export function resolveLanguage(tag: string | null): string | null {
  if (tag === null) return null;
  const key = tag.toLowerCase();
  // Object.hasOwn guards against inherited keys ("constructor", "toString"),
  // which a bare index read would resolve to a prototype value. Once that
  // guard holds the own value is a real string, but noUncheckedIndexedAccess
  // still types the read as string | undefined, so narrow it explicitly.
  if (!Object.hasOwn(ALIASES, key)) return null;
  const canonical = ALIASES[key];
  return canonical === undefined ? null : canonical;
}

/**
 * Tokenize `code` for `lang` (a canonical id from {@link resolveLanguage}).
 * Unknown languages return a single plain token, so the caller never has to
 * branch on support.
 */
export function highlightCode(code: string, lang: string | null): CodeToken[] {
  const spec = lang === null ? undefined : LANGS[lang];
  if (spec === undefined) return code.length > 0 ? [{ text: code, cls: null }] : [];

  const tokens: CodeToken[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain.length > 0) {
      tokens.push({ text: plain, cls: null });
      plain = "";
    }
  };
  const ident = spec.ident ?? DEFAULT_IDENT;

  let i = 0;
  outer: while (i < code.length) {
    for (const p of spec.patterns) {
      p.re.lastIndex = i;
      const m = p.re.exec(code);
      if (m !== null && m[0].length > 0) {
        flush();
        tokens.push({ text: m[0], cls: p.cls });
        i += m[0].length;
        continue outer;
      }
    }

    ident.lastIndex = i;
    const word = ident.exec(code);
    if (word !== null && word[0].length > 0) {
      if (spec.keywords.has(word[0])) {
        flush();
        tokens.push({ text: word[0], cls: "keyword" });
      } else {
        plain += word[0];
      }
      i += word[0].length;
      continue;
    }

    plain += code[i]!;
    i++;
  }

  flush();
  return tokens;
}
