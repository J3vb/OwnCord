import { describe, expect, it } from "vitest";
import { cleanFileName, FALLBACK_FILE_NAME, MAX_FILE_NAME_UNITS } from "./fileName";

describe("cleanFileName", () => {
  it.each([
    ["report.pdf", "report.pdf"],
    ["café photo 😀.png", "café photo 😀.png"],
    ["owncord-support-2026-11-25-10-00-00.zip", "owncord-support-2026-11-25-10-00-00.zip"],
    ["/etc/cron.d/job", "job"],
    ["C:\\Users\\Public\\Desktop\\run.cmd", "run.cmd"],
    ["a/b\\c.txt", "c.txt"],
    ["photo\u202egnp.exe", "photognp.exe"],
    ["na\u2066me\u2069.txt", "name.txt"],
    ["line\nbreak\t.txt", "linebreak.txt"],
    [".bashrc", "bashrc"],
    ["...hidden.txt", "hidden.txt"],
    ["notes.txt:stream", "notes.txt_stream"],
    ['what?<"x">|*.txt', "what___x____.txt"],
    ["trailing.  ", "trailing"],
  ])("cleans %j to %j", (input, expected) => {
    expect(cleanFileName(input)).toBe(expected);
  });

  it.each(["", "/", "..", "...", "a/..", "\u202e", " \t "])(
    "falls back when nothing is left of %j",
    (input) => {
      expect(cleanFileName(input)).toBe(FALLBACK_FILE_NAME);
    },
  );

  it("cuts a long name and keeps its extension", () => {
    const out = cleanFileName(`${"a".repeat(500)}.tar.gz`);
    expect(out).toHaveLength(MAX_FILE_NAME_UNITS);
    expect(out.endsWith("a.gz")).toBe(true);
  });

  it("cuts a long name without an extension and never splits a surrogate pair", () => {
    const out = cleanFileName("😀".repeat(200));
    expect(out.length).toBeLessThanOrEqual(MAX_FILE_NAME_UNITS);
    expect(out).toBe("😀".repeat(MAX_FILE_NAME_UNITS / 2));
  });
});
