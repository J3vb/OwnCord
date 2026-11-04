import { describe, expect, it } from "vitest";
import {
  SECOND_NIGHT,
  SPLIT_BY_LINE,
  filesForNight,
  nightFromEnv,
  splitLine,
} from "../mutation/nights.mjs";

describe("nightFromEnv", () => {
  it("does both halves outside CI", () => {
    expect(nightFromEnv({})).toBe("both");
  });

  it("alternates on the workflow run number", () => {
    expect(nightFromEnv({ GITHUB_RUN_NUMBER: "41" })).toBe("first");
    expect(nightFromEnv({ GITHUB_RUN_NUMBER: "42" })).toBe("second");
  });

  it("lets OC_MUTATION_NIGHT override the run number", () => {
    expect(nightFromEnv({ GITHUB_RUN_NUMBER: "41", OC_MUTATION_NIGHT: "second" })).toBe("second");
    expect(nightFromEnv({ GITHUB_RUN_NUMBER: "42", OC_MUTATION_NIGHT: "both" })).toBe("both");
  });

  it("rejects an unknown override", () => {
    expect(() => nightFromEnv({ OC_MUTATION_NIGHT: "third" })).toThrow(/first, second or both/);
  });
});

describe("splitLine", () => {
  it("cuts at the top-level statement nearest the middle", () => {
    const text = [
      "const a = 1;",
      "function f() {",
      "  return 1;",
      "}",
      "export const b = 2;",
      "const c = 3;",
    ].join("\n");
    expect(splitLine(text)).toEqual({ cut: 5, lines: 6 });
  });

  it("never cuts inside an indented block", () => {
    const text = [
      "export function f() {",
      "  const a = 1;",
      "  const b = 2;",
      "  const c = 3;",
      "}",
      "const z = 0;",
    ].join("\n");
    expect(splitLine(text).cut).toBe(6);
  });
});

describe("filesForNight", () => {
  const second = [...SECOND_NIGHT][0]!;
  const split = [...SPLIT_BY_LINE][0]!;
  const plain = "src/not-on-the-second-night.ts";
  const text = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n");
  const files = [plain, second, split];

  it("returns every file whole when both halves run", () => {
    expect(filesForNight(files, "both", () => text)).toEqual(files);
  });

  it("puts each file on exactly one night and splits the long one by line", () => {
    expect(filesForNight(files, "first", () => text)).toEqual([plain, `${split}:1-2`]);
    expect(filesForNight(files, "second", () => text)).toEqual([second, `${split}:3-4`]);
  });
});
