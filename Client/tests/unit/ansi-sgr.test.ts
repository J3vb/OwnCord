import { describe, expect, it } from "vitest";
import { highlightCode } from "../../src/features/messaging/content/syntaxHighlight";

const ESC = "\u001b";
const sgr = (body: string): string => `${ESC}[${body}m`;

/** The ansi class of each token the text `x` takes after the given SGR codes. */
function classesAfter(...bodies: string[]): string | undefined {
  const tokens = highlightCode(`${bodies.map(sgr).join("")}x`, "ansi");
  return tokens.at(-1)?.ansi;
}

describe("ansi SGR codes", () => {
  it.each([
    ["31", "ansi-31"],
    ["37", "ansi-37"],
    ["40", "ansi-40"],
    ["47", "ansi-47"],
    ["1", "ansi-b"],
    ["4", "ansi-u"],
    ["1;4;32;44", "ansi-32 ansi-44 ansi-b ansi-u"],
  ])("sets the style for %s", (body, expected) => {
    expect(classesAfter(body)).toBe(expected);
  });

  it.each([
    ["0", undefined],
    ["", undefined],
    ["39", "ansi-44 ansi-b ansi-u"],
    ["49", "ansi-32 ansi-b ansi-u"],
    ["22", "ansi-32 ansi-44 ansi-u"],
    ["24", "ansi-32 ansi-44 ansi-b"],
  ])("code %s after green on blue, bold and underlined", (body, expected) => {
    expect(classesAfter("32;44;1;4", body)).toBe(expected);
  });

  it("clears everything on a bare reset, whatever follows it", () => {
    expect(classesAfter("1;31;42;0;4")).toBe("ansi-u");
  });

  it("skips the arguments of an extended colour and sets no colour", () => {
    expect(classesAfter("38;5;196")).toBeUndefined();
    expect(classesAfter("48;2;10;20;30")).toBeUndefined();
    expect(classesAfter("38;5;196;1")).toBe("ansi-b");
    expect(classesAfter("48;2;10;20;30;4")).toBe("ansi-u");
  });

  it("treats a bare 38 or an unknown mode as having no arguments", () => {
    expect(classesAfter("38;1")).toBe("ansi-b");
    expect(classesAfter("48")).toBeUndefined();
  });

  it("ignores codes outside the supported set", () => {
    expect(classesAfter("90")).toBeUndefined();
    expect(classesAfter("3;9;7;48;5")).toBeUndefined();
    expect(classesAfter("1;99;4")).toBe("ansi-b ansi-u");
  });
});
