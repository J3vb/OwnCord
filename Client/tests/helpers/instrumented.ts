// The nightly test-depth run copies Client/ into a sandbox and rewrites the
// source files it exercises. Tests that read source as text judge the original
// files; a rewritten copy says nothing about them, so such tests skip it.
const MARKER = /\bstryMutAct_[0-9a-f]+\(/;

export function isInstrumented(text: string): boolean {
  return MARKER.test(text);
}

const NO_CHECK_HEADER = "// @ts-nocheck\n";

/**
 * The sandbox also puts a `// @ts-nocheck` line on top of every file it copies,
 * rewritten or not. Drop it in the nightly run so line counts and file headers
 * read as they do in the original.
 */
export function withoutSandboxHeader(text: string): string {
  if (process.env.OC_MUTATION_RUN === undefined) return text;
  return text.startsWith(NO_CHECK_HEADER) ? text.slice(NO_CHECK_HEADER.length) : text;
}
