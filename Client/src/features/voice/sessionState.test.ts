import { describe, it, expect } from "vitest";
import { parseUserId } from "./sessionState";

describe("parseUserId", () => {
  it("parses a bare user identity", () => {
    expect(parseUserId("user-42")).toBe(42);
  });

  it("parses an identity carrying a token suffix", () => {
    expect(parseUserId("user-7:abc")).toBe(7);
  });

  it("returns 0 for anything else", () => {
    expect(parseUserId("")).toBe(0);
    expect(parseUserId("user-")).toBe(0);
    expect(parseUserId("user-12x")).toBe(0);
    expect(parseUserId("xuser-12")).toBe(0);
    expect(parseUserId("bot-3")).toBe(0);
  });
});
