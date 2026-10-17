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

export type TokenClass = "keyword" | "string" | "comment" | "number" | "inserted" | "deleted";

export interface CodeToken {
  readonly text: string;
  /** null renders as plain text (or as `ansi` classes when that is set). */
  readonly cls: TokenClass | null;
  /**
   * Space-separated CSS class names of an ansi run (`ansi-31 ansi-b`). Set only
   * by the ansi highlighter, on tokens whose `cls` is null.
   */
  readonly ansi?: string;
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
  /** Keywords are stored lowercase and matched case-insensitively (SQL). */
  readonly ignoreCase?: boolean;
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

const JS_LIKE_NO_BT: readonly Pattern[] = [
  SLASH_LINE_COMMENT,
  C_BLOCK_COMMENT,
  DQ_STRING,
  SQ_STRING,
  NUMBER,
];

/** C/C++ preprocessor directive (`#include`, `#define`). */
const C_PREPROC: Pattern = { re: /#[ \t]*[a-z]+/y, cls: "keyword" };

/**
 * Unified diff. Every pattern is anchored with ^ and the m flag: with the
 * sticky flag ^ matches only when lastIndex sits at a line start, so a "-" or
 * "+" in the middle of a line is never coloured. File and hunk headers come
 * first so "+++ b/x" and "--- a/x" are not read as an insertion and a deletion.
 */
const DIFF_PATTERNS: readonly Pattern[] = [
  { re: /^(?:diff --git |index |@@|(?:\+\+\+|---)(?=[ \t]|$))[^\n]*/my, cls: "keyword" },
  { re: /^\+[^\n]*/my, cls: "inserted" },
  { re: /^-[^\n]*/my, cls: "deleted" },
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
  c: {
    patterns: [C_PREPROC, ...JS_LIKE_NO_BT],
    keywords: kw(
      "if else for while do switch case default break continue return goto sizeof typedef struct union enum static const extern volatile register inline void char short int long float double signed unsigned NULL true false bool size_t",
    ),
  },
  cpp: {
    patterns: [C_PREPROC, ...JS_LIKE_NO_BT],
    keywords: kw(
      "if else for while do switch case default break continue return goto sizeof typedef struct union enum static const extern volatile register inline void char short int long float double signed unsigned NULL true false bool size_t class public private protected virtual override namespace using template typename new delete this nullptr try catch throw auto constexpr operator explicit friend std",
    ),
  },
  java: {
    patterns: [{ re: /"""[\s\S]*?(?:"""|$)/y, cls: "string" }, ...JS_LIKE_NO_BT],
    keywords: kw(
      "class interface enum extends implements package import public private protected static final " +
        "abstract void int long short byte char float double boolean new this super return if else for " +
        "while do switch case default break continue try catch finally throw throws instanceof null " +
        "true false var synchronized String",
    ),
  },
  csharp: {
    patterns: [{ re: /@"(?:[^"]|"")*"?/y, cls: "string" }, ...JS_LIKE_NO_BT],
    keywords: kw(
      "namespace using class struct interface enum record public private protected internal static " +
        "readonly const abstract virtual override sealed void int long short byte char float double " +
        "decimal bool string var new this base return if else for foreach while do switch case default " +
        "break continue try catch finally throw null true false async await in is as get set",
    ),
  },
  sql: {
    ignoreCase: true,
    patterns: [
      { re: /--[^\n]*/y, cls: "comment" },
      C_BLOCK_COMMENT,
      // Standard SQL has no backslash escape; '' is two adjacent strings.
      { re: /'[^'\n]*'?/y, cls: "string" },
      DQ_STRING,
      NUMBER,
    ],
    keywords: kw(
      "select from where and or not in is null like between join inner left right full outer cross on " +
        "group by order having limit offset as distinct union all insert into values update set delete " +
        "create alter drop table index view database primary key foreign references default unique " +
        "check constraint case when then else end exists asc desc with returning begin commit rollback " +
        "int integer bigint text varchar char boolean date timestamp true false",
    ),
  },
  yaml: {
    patterns: [
      // A comment needs whitespace before "#"; a quote opens a string only
      // where a value starts, so "don't" stays plain text; a key starts only
      // at the start of a run, which keeps hostile runs linear.
      { re: /(?<!\S)#[^\n]*/y, cls: "comment" },
      DQ_STRING,
      { re: /'(?<=(?:^|[:[{,-])[ \t]*')(?:[^'\n]|'')*'?/my, cls: "string" },
      { re: /(?<![\w./-])[\w./-]+(?=[ \t]*:(?:[ \t]|$))/my, cls: "keyword" },
      NUMBER,
    ],
    keywords: kw("true false null"),
  },
  diff: { patterns: DIFF_PATTERNS, keywords: new Set() },
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
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  java: "java",
  cs: "csharp",
  csharp: "csharp",
  "c#": "csharp",
  sql: "sql",
  sqlite: "sql",
  postgres: "sql",
  mysql: "sql",
  yaml: "yaml",
  yml: "yaml",
  diff: "diff",
  patch: "diff",
  ansi: "ansi",
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

// -- ansi ---------------------------------------------------------------------

interface AnsiState {
  fg: number;
  bg: number;
  bold: boolean;
  underline: boolean;
}

/** Class names for a style, or null for the default style. */
function ansiClasses(st: AnsiState): string | null {
  const names: string[] = [];
  if (st.fg > 0) names.push(`ansi-${st.fg}`);
  if (st.bg > 0) names.push(`ansi-${st.bg}`);
  if (st.bold) names.push("ansi-b");
  if (st.underline) names.push("ansi-u");
  return names.length > 0 ? names.join(" ") : null;
}

/** Apply one SGR parameter list. Codes outside the supported set are ignored. */
function applySgr(st: AnsiState, body: string): void {
  const parts = body.split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const n = part === "" ? 0 : Number(part);
    if (n === 38 || n === 48) {
      // Extended colour: skip its arguments (5;n or 2;r;g;b), no colour set.
      i += parts[i + 1] === "5" ? 2 : parts[i + 1] === "2" ? 4 : 0;
    } else if (n === 0) {
      st.fg = 0;
      st.bg = 0;
      st.bold = false;
      st.underline = false;
    } else if (n === 1) st.bold = true;
    else if (n === 4) st.underline = true;
    else if (n >= 30 && n <= 37) st.fg = n;
    else if (n >= 40 && n <= 47) st.bg = n;
    else if (n === 39) st.fg = 0;
    else if (n === 49) st.bg = 0;
    else if (n === 22) st.bold = false;
    else if (n === 24) st.underline = false;
  }
}

/**
 * Tokenize Discord-style ```ansi text: `ESC [ params m` sequences set the
 * style of the text after them and are dropped from the output. Other CSI
 * sequences are dropped without effect; an ESC that does not start a complete
 * CSI sequence stays as text. Linear: a scan for a sequence stops at the next
 * character that cannot belong to one, which includes the next ESC.
 */
function highlightAnsi(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const st: AnsiState = { fg: 0, bg: 0, bold: false, underline: false };
  let classes: string | null = null;
  const push = (text: string): void => {
    if (text.length === 0) return;
    const last = tokens[tokens.length - 1];
    if (last !== undefined && (last.ansi ?? null) === classes) {
      tokens[tokens.length - 1] =
        classes === null
          ? { text: last.text + text, cls: null }
          : { text: last.text + text, cls: null, ansi: classes };
      return;
    }
    tokens.push(classes === null ? { text, cls: null } : { text, cls: null, ansi: classes });
  };

  let start = 0;
  let i = code.indexOf("\u001b");
  while (i !== -1) {
    let end = -1;
    if (code.charCodeAt(i + 1) === 0x5b) {
      let j = i + 2;
      for (; j < code.length; j++) {
        const c = code.charCodeAt(j);
        if (!((c >= 0x30 && c <= 0x39) || c === 0x3b)) break;
      }
      const fin = code.charCodeAt(j);
      if (j < code.length && fin >= 0x40 && fin <= 0x7e) {
        push(code.slice(start, i));
        if (fin === 0x6d) {
          applySgr(st, code.slice(i + 2, j));
          classes = ansiClasses(st);
        }
        end = j + 1;
      }
    }
    if (end === -1) {
      i = code.indexOf("\u001b", i + 1);
      continue;
    }
    start = end;
    i = code.indexOf("\u001b", start);
  }
  push(code.slice(start));
  return tokens;
}

/**
 * Tokenize `code` for `lang` (a canonical id from {@link resolveLanguage}).
 * Unknown languages return a single plain token, so the caller never has to
 * branch on support.
 */
export function highlightCode(code: string, lang: string | null): CodeToken[] {
  if (lang === "ansi") return highlightAnsi(code);
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
      if (spec.keywords.has(spec.ignoreCase === true ? word[0].toLowerCase() : word[0])) {
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
