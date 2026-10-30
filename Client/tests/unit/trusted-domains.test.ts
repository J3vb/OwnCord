import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TRUSTED_DOMAINS,
  isDomainTrusted,
  linkDomain,
  trustDomain,
} from "../../src/lib/net/trustedDomains";

const KEY = "owncord:trustedLinkDomains";

describe("linkDomain", () => {
  it("lowercases the host and drops a trailing dot", () => {
    expect(linkDomain("https://Example.COM./path?q=1")).toBe("example.com");
  });

  it("keeps subdomains distinct and ignores port and credentials", () => {
    expect(linkDomain("http://user:pw@docs.example.com:8080/x")).toBe("docs.example.com");
  });

  it("returns null for non-http(s) and unparseable URLs", () => {
    expect(linkDomain("javascript:alert(1)")).toBeNull();
    expect(linkDomain("ftp://example.com/")).toBeNull();
    expect(linkDomain("not a url")).toBeNull();
  });
});

describe("trusted link domains", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("trusts nothing by default", () => {
    expect(isDomainTrusted("example.com")).toBe(false);
  });

  it("remembers a trusted domain case-insensitively, persisted as a JSON array", () => {
    trustDomain("Example.com");
    expect(isDomainTrusted("example.COM")).toBe(true);
    expect(isDomainTrusted("other.com")).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["example.com"]);
  });

  it("does not store a domain twice", () => {
    trustDomain("example.com");
    trustDomain("example.com");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["example.com"]);
  });

  it("ignores an empty domain", () => {
    trustDomain("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("keeps only the newest entries past the cap", () => {
    for (let i = 0; i < MAX_TRUSTED_DOMAINS + 5; i++) trustDomain(`d${i}.example`);
    const stored = JSON.parse(localStorage.getItem(KEY)!) as string[];
    expect(stored).toHaveLength(MAX_TRUSTED_DOMAINS);
    expect(stored[0]).toBe("d5.example");
    expect(stored.at(-1)).toBe(`d${MAX_TRUSTED_DOMAINS + 4}.example`);
    expect(isDomainTrusted("d0.example")).toBe(false);
  });

  it("re-trusting a domain moves it to the newest end", () => {
    trustDomain("a.example");
    trustDomain("b.example");
    trustDomain("a.example");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["b.example", "a.example"]);
  });

  it("reads corrupt or wrongly shaped storage as empty and recovers on write", () => {
    localStorage.setItem(KEY, "{not json");
    expect(isDomainTrusted("example.com")).toBe(false);
    localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
    expect(isDomainTrusted("example.com")).toBe(false);
    localStorage.setItem(KEY, JSON.stringify(["ok.example", 7, "", null]));
    expect(isDomainTrusted("ok.example")).toBe(true);
    trustDomain("new.example");
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["ok.example", "new.example"]);
  });

  it("survives storage that throws on read and on write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(isDomainTrusted("example.com")).toBe(false);
    expect(() => trustDomain("example.com")).not.toThrow();
  });
});
