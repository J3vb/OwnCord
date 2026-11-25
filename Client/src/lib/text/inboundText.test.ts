import { describe, expect, it } from "vitest";
import { boundInboundText, MAX_INBOUND_TEXT_UNITS } from "./inboundText";

describe("boundInboundText", () => {
  it("returns text a server stores unchanged", () => {
    const longest = "😀".repeat(4000);
    expect(boundInboundText(longest)).toBe(longest);
    expect(boundInboundText("")).toBe("");
    const atCap = "a".repeat(MAX_INBOUND_TEXT_UNITS);
    expect(boundInboundText(atCap)).toBe(atCap);
  });

  it("cuts longer text to the ceiling and marks the cut", () => {
    const out = boundInboundText("a".repeat(MAX_INBOUND_TEXT_UNITS + 5));
    expect(out).toBe(`${"a".repeat(MAX_INBOUND_TEXT_UNITS)}…`);
  });

  it("passes a value that is not a string through as it came", () => {
    const odd = {} as unknown as string;
    expect(boundInboundText(odd)).toBe(odd);
    expect(boundInboundText(undefined as unknown as string)).toBeUndefined();
  });

  it("never splits a surrogate pair at the cut", () => {
    const text = `${"a".repeat(MAX_INBOUND_TEXT_UNITS - 1)}😀tail`;
    const out = boundInboundText(text);
    expect(out).toBe(`${"a".repeat(MAX_INBOUND_TEXT_UNITS - 1)}…`);
    expect(/[\ud800-\udbff]/.test(out)).toBe(false);
  });
});
