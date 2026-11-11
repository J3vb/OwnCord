// The nightly test-depth run copies Client/ into a sandbox and rewrites the
// source files it exercises. Tests that read source as text judge the original
// files; a rewritten copy says nothing about them, so such tests skip it.
const MARKER = /\bstryMutAct_[0-9a-f]+\(/;

export function isInstrumented(text: string): boolean {
  return MARKER.test(text);
}

const NO_CHECK_HEADER = "// @ts-nocheck\n";
const LEADING_BLOCK_COMMENT = /^\s*\/\*.*?\*\//s;

/**
 * The sandbox also puts a `// @ts-nocheck` line in every file it copies,
 * rewritten or not: on top, or right after a leading block comment, where it
 * adds a line break too. Drop it in the nightly run so line counts and file
 * headers read as they do in the original.
 */
export function withoutSandboxHeader(text: string): string {
  if (process.env.OC_MUTATION_RUN === undefined) return text;
  return stripSandboxHeader(text);
}

/** The header removal itself, without the nightly-run check. */
export function stripSandboxHeader(text: string): string {
  if (text.startsWith(NO_CHECK_HEADER)) return text.slice(NO_CHECK_HEADER.length);
  const comment = LEADING_BLOCK_COMMENT.exec(text)?.[0];
  const inserted = `\n${NO_CHECK_HEADER}`;
  if (comment === undefined || !text.startsWith(inserted, comment.length)) return text;
  return comment + text.slice(comment.length + inserted.length);
}
