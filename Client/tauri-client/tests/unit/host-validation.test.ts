import { describe, it, expect } from "vitest";

import { isValidHost } from "../../src/lib/hostValidation";

describe("isValidHost", () => {
  it("rejects a host containing '@' (identity.ts's OC-0118 scope-key premise)", () => {
    // identity.ts's identityScopeKey builds `${userId}@${host}` and relies on
    // isValidHost forbidding '@' in any accepted host so a scoped key can
    // never collide with a legacy host-only account. If '@' were ever
    // accepted here, a host literally equal to "2@chat.example" would be
    // indistinguishable from userId 2 scoped to host "chat.example".
    expect(isValidHost("2@chat.example")).toBe(false);
    expect(isValidHost("user@evil.example:8443")).toBe(false);
  });

  it("rejects a host longer than 253 characters", () => {
    const longHost = "a".repeat(254);
    expect(isValidHost(longHost)).toBe(false);
    // 253 is the boundary and must still be accepted (paired with a valid
    // DNS label shape).
    const maxHost = "a".repeat(253);
    expect(isValidHost(maxHost)).toBe(true);
  });

  it("accepts a DNS name, optionally with a port", () => {
    expect(isValidHost("chat.example.com")).toBe(true);
    expect(isValidHost("chat.example.com:8443")).toBe(true);
  });

  it("accepts an IPv4 literal, optionally with a port", () => {
    expect(isValidHost("192.168.1.1")).toBe(true);
    expect(isValidHost("192.168.1.1:8443")).toBe(true);
  });

  it("accepts a bracketed IPv6 literal, optionally with a port", () => {
    expect(isValidHost("[::1]")).toBe(true);
    expect(isValidHost("[::1]:8443")).toBe(true);
    expect(isValidHost("[2001:db8::1]")).toBe(true);
  });

  it("accepts a bare (unbracketed) IPv6 literal", () => {
    expect(isValidHost("::1")).toBe(true);
    expect(isValidHost("2001:db8::1")).toBe(true);
  });
});
