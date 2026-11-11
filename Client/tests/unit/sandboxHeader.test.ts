// The nightly sandbox adds a `// @ts-nocheck` line to each copied source file;
// tests that read source as text strip it with this helper.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripSandboxHeader } from "../helpers/instrumented";

const insertAfterLeadingComment = (code: string): string => {
  const comment = /^\s*\/\*.*?\*\//s.exec(code)?.[0];
  return comment === undefined
    ? `// @ts-nocheck\n${code}`
    : `${comment}\n// @ts-nocheck\n${code.slice(comment.length)}`;
};

describe("stripSandboxHeader", () => {
  it("removes the header from the top of a file", () => {
    expect(stripSandboxHeader("// @ts-nocheck\nconst a = 1;\n")).toBe("const a = 1;\n");
  });

  it("removes the header and its extra line break after a leading block comment", () => {
    const original = "/**\n * About this file.\n */\n\nexport const a = 1;\n";
    expect(stripSandboxHeader(insertAfterLeadingComment(original))).toBe(original);
  });

  it("leaves a file without the header unchanged", () => {
    const original = "/** Doc. */\nexport const a = 1;\n// @ts-nocheck\n";
    expect(stripSandboxHeader(original)).toBe(original);
  });

  it("restores a real source file that opens with a block comment", () => {
    const original = readFileSync(
      path.resolve(__dirname, "../../src/features/settings/KeybindsTab.ts"),
      "utf8",
    );
    expect(original.startsWith("/**")).toBe(true);
    expect(stripSandboxHeader(insertAfterLeadingComment(original))).toBe(original);
  });
});
