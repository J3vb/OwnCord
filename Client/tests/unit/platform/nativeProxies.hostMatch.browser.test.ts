// @vitest-environment-options {"url": "https://chat.example/"}
// The browser platform's ensureHttpProxy compares hosts as URL authorities
// (6.13c): case and the default https port do not make a different host, but
// any other host, port or an invalid host is refused.
import { describe, expect, it } from "vitest";
import { nativeProxies } from "../../../src/platform/browser/nativeProxies";

describe("browser nativeProxies: host matching", () => {
  it("runs on the page it expects", () => {
    expect(location.host).toBe("chat.example");
  });

  for (const host of ["chat.example", "Chat.example:443", "CHAT.EXAMPLE"]) {
    it(`treats ${host} as the page's host`, async () => {
      await expect(nativeProxies.ensureHttpProxy(host)).resolves.toBe("https://chat.example");
    });
  }

  for (const host of [
    "chat.example:8443",
    "other.example",
    "chat.example.net",
    "chat.example@other.example",
    "",
    "bad host",
  ]) {
    it(`refuses ${JSON.stringify(host)}`, async () => {
      await expect(nativeProxies.ensureHttpProxy(host)).rejects.toThrow();
    });
  }
});
