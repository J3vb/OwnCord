// The nightly test-depth run copies Client/ into a sandbox and rewrites the
// source files it exercises. Tests that read source as text judge the original
// files; a rewritten copy says nothing about them, so such tests skip it.
const MARKER = /\bstryMutAct_[0-9a-f]+\(/;

export function isInstrumented(text: string): boolean {
  return MARKER.test(text);
}
