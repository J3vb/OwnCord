/**
 * Two limits on the Rust side of the client (Client/src-tauri):
 *
 * - No `.rs` file is longer than 1,500 lines, so a reader or an agent can load
 *   one whole. Split a file that grows past it; there is no allowlist.
 * - Production code never calls `.unwrap()` or `.expect(`. A panic there takes
 *   the window down, so the error is handled or passed up instead. Test code
 *   (a `#[cfg(test)]` item, a `#[test]` fn, or a file only such a module pulls
 *   in) may still unwrap.
 *
 * Clippy denies the same calls (Cargo.toml, clippy.toml), but CI's clippy only
 * compiles the Linux and Android code on a dev PR. This scan reads every file,
 * so Windows-only code is held to the same line before it reaches main.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const CRATE = resolve(__dirname, "../../src-tauri");
const MAX_LINES = 1500;

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rustFiles(path);
    return entry.name.endsWith(".rs") ? [path] : [];
  });
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

const blank = (text: string): string => text.replace(/[^\n]/g, " ");

function blockCommentEnd(src: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < src.length && depth > 0) {
    const pair = src.slice(i, i + 2);
    if (pair === "/*") depth++;
    if (pair === "*/") depth--;
    i += pair === "/*" || pair === "*/" ? 2 : 1;
  }
  return i;
}

function quotedEnd(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** Literal prefixes that open a string: `"`, `b"`, `c"`, and the raw forms `r#"` and `br#"`. */
const STRING_START = /^(?:[bc]?r(#*)"|[bc]?")/;
const CHAR_LITERAL = /^b?'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\'\n])'/;

/** Where the comment or literal starting at `i` ends, or -1 when `i` starts plain code. */
function literalEnd(src: string, i: number): number {
  const rest = src.slice(i, i + 300);
  if (rest.startsWith("//")) {
    const newline = src.indexOf("\n", i);
    return newline === -1 ? src.length : newline;
  }
  if (rest.startsWith("/*")) return blockCommentEnd(src, i);
  if (/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) return -1;
  const str = STRING_START.exec(rest);
  if (str && str[1] !== undefined) {
    const close = `"${str[1]}`;
    const found = src.indexOf(close, i + str[0].length);
    return found === -1 ? src.length : found + close.length;
  }
  if (str) return quotedEnd(src, i + str[0].length - 1);
  const chr = CHAR_LITERAL.exec(rest);
  return chr ? i + chr[0].length : -1;
}

/** Blanks comments, strings and char literals, keeping every newline and offset in place. */
function stripLiterals(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const end = literalEnd(src, i);
    if (end === -1) {
      out += src[i];
      i++;
    } else {
      out += blank(src.slice(i, end));
      i = end;
    }
  }
  return out;
}

/** `#[cfg(test)]`, `#[cfg(all(.., test, ..))]`, `#[test]`, `#[tokio::test(..)]`; never `not(test)` or `any(..)`. */
const TEST_ATTR =
  /#\[\s*(?:cfg\s*\(\s*(?:test|all\s*\((?:[^()]|\([^()]*\))*\btest\b(?:[^()]|\([^()]*\))*\))\s*\)|(?:tokio::)?test(?:\s*\([^\]]*\))?)\s*\]/g;

function isTestAttr(attr: string): boolean {
  return !/not\s*\(\s*test\s*\)/.test(attr);
}

/** Blanks every item a test-only attribute guards, through its matching brace or its `;`. */
function dropTestItems(code: string): string {
  let out = code;
  for (const match of code.matchAll(TEST_ATTR)) {
    if (!isTestAttr(match[0])) continue;
    let j = match.index + match[0].length;
    while (j < code.length && code[j] !== "{" && code[j] !== ";") j++;
    if (code[j] === "{") {
      for (let depth = 0; j < code.length; j++) {
        if (code[j] === "{") depth++;
        if (code[j] === "}" && --depth === 0) break;
      }
    }
    out = out.slice(0, match.index) + blank(out.slice(match.index, j + 1)) + out.slice(j + 1);
  }
  return out;
}

function panicCalls(src: string): number {
  return (dropTestItems(stripLiterals(src)).match(/\.\s*(?:unwrap|expect)\s*\(/g) ?? []).length;
}

/** Files that exist only because a test-only `mod name;` declaration pulls them in. */
function testOnlyFiles(files: Map<string, string>): Set<string> {
  const declared = new Set<string>();
  const decl = new RegExp(
    `${TEST_ATTR.source}\\s*(?:#\\[[^\\]]*\\]\\s*)*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+(\\w+)\\s*;`,
    "g",
  );
  for (const [path, code] of files) {
    const name = basename(path);
    const isRoot = name === "lib.rs" || name === "main.rs" || name === "mod.rs";
    const dir = isRoot ? dirname(path) : join(dirname(path), name.slice(0, -3));
    for (const match of code.matchAll(decl)) {
      const mod = match[match.length - 1];
      if (!isTestAttr(match[0]) || mod === undefined) continue;
      for (const candidate of [join(dir, `${mod}.rs`), join(dir, mod, "mod.rs")]) {
        if (existsSync(candidate)) declared.add(candidate);
      }
    }
  }
  return declared;
}

const paths = [...rustFiles(join(CRATE, "src")), ...rustFiles(join(CRATE, "examples"))];
const raw = new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
const stripped = new Map([...raw].map(([path, text]) => [path, stripLiterals(text)]));
const testOnly = testOnlyFiles(stripped);
const rel = (path: string): string => relative(CRATE, path).split("\\").join("/");

describe("Rust source limits", () => {
  it("finds the Rust files it is meant to measure", () => {
    expect(raw.size).toBeGreaterThan(60);
    expect([...testOnly].map(rel)).toContain("src/config_gates.rs");
  });

  it(`keeps every .rs file at ${MAX_LINES} lines or fewer`, () => {
    const tooLong = [...raw]
      .filter(([, text]) => lineCount(text) > MAX_LINES)
      .map(([path, text]) => `${rel(path)} (${lineCount(text)} lines)`);
    expect(tooLong).toEqual([]);
  });

  it("keeps unwrap and expect out of production code", () => {
    const offenders = [...raw]
      .filter(([path]) => !testOnly.has(path))
      .map(([path, text]) => [rel(path), panicCalls(text)] as const)
      .filter(([, count]) => count > 0)
      .map(([file, count]) => `${file} (${count})`);
    expect(offenders).toEqual([]);
  });
});

describe("the unwrap counter", () => {
  it("counts calls in production code, split across lines too", () => {
    expect(panicCalls('fn a() { x.unwrap(); y\n    .expect("why"); }')).toBe(2);
  });

  it("ignores comments, strings, raw strings and char literals", () => {
    const src = [
      "// x.unwrap()",
      "/* outer /* x.unwrap() */ still a comment .expect( */",
      'let a = "x.unwrap() \\" .expect(";',
      'let b = r#"x.unwrap() " .expect("#;',
      "let c = b'\"'; let d = '\\''; let e = 'a';",
      "fn f<'a>(s: &'a str) -> &'a str { s }",
    ].join("\n");
    expect(panicCalls(src)).toBe(0);
    expect(panicCalls(`${src}\nfn g() { h.unwrap(); }`)).toBe(1);
  });

  it("skips test items but not other cfg gates", () => {
    const src = [
      "#[cfg(test)]\nmod tests { fn a() { x.unwrap(); { y.unwrap(); } } }",
      '#[cfg(all(test, target_os = "linux"))]\nfn b() { x.unwrap(); }',
      '#[test]\nfn c() { x.expect("t"); }',
      '#[tokio::test(flavor = "multi_thread")]\nasync fn d() { x.unwrap(); }',
      '#[cfg(any(test, target_os = "android"))]\nfn e() { x.unwrap(); }',
      "#[cfg(not(test))]\nfn f() { x.unwrap(); }",
      '#[cfg(target_os = "windows")]\nfn g() { x.unwrap(); }',
    ].join("\n");
    expect(panicCalls(src)).toBe(3);
  });

  it("leaves the methods with a fallback alone", () => {
    expect(panicCalls('x.unwrap_or(1); y.unwrap_or_default(); z.expect_err("e");')).toBe(0);
  });
});
