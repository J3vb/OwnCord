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

  it("rejects a host containing an underscore (OC-0322: Rust proxies reject it)", () => {
    // http_proxy::validate_remote_host and livekit_proxy::validate_remote_host
    // only allow is_ascii_alphanumeric() || '.' | '-' | ':' | '[' | ']' -- JS
    // `\w` wrongly includes '_', which would let the client save/accept a
    // host neither Rust proxy can ever connect to.
    expect(isValidHost("chat_example.com")).toBe(false);
    expect(isValidHost("my_server.lan:8443")).toBe(false);
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

  it("rejects a bracketed IPv6 literal with characters before or after the brackets", () => {
    // The bracketed-IPv6 regex is anchored at both ends (^...$); without
    // those anchors, a bracket pattern anywhere in the string would
    // wrongly match.
    expect(isValidHost("evil[::1]")).toBe(false);
    expect(isValidHost("[::1]evil")).toBe(false);
  });

  it("rejects a multi-colon host whose characters are not all IPv6-valid", () => {
    // More than one colon alone must not be enough to accept a host as a
    // bare IPv6 literal -- every character has to be IPv6-valid too (the
    // `&&`, not `||`, between the colon-count and character checks).
    expect(isValidHost("not:valid:host")).toBe(false);
  });

  it("rejects a single-colon host with a non-numeric port suffix", () => {
    // Exactly one colon must never satisfy the bare-IPv6 branch (which
    // requires *more than* one), and it isn't a valid host:port either
    // unless the suffix after the colon is numeric.
    expect(isValidHost("a:b")).toBe(false);
  });

  it("rejects a multi-colon host where the IPv6-valid run is only a substring", () => {
    // The bare-IPv6 character regex is anchored at both ends -- it has to
    // match the whole (multi-colon) host, not just some valid-looking
    // substring within or at either end of it.
    expect(isValidHost("xyz:ab:cd")).toBe(false);
    expect(isValidHost("ab:cd:xyz")).toBe(false);
  });
});
