// The browser platform's proxies (6.13c). The page talks to the server that
// served it, so there is no tunnel: the HTTP origin is the page's own, and
// LiveKit is reached through the server's proxy path on the page's host. The
// tunnel suites (`nativeProxies.suite.ts`, `livekitProxies.suite.ts`) pin a
// loopback tunnel, which this platform does not have, so the cases here pin
// the same caller-visible questions against the browser answers.
import { describe, expect, it } from "vitest";
import type { NativeProxies } from "../../../src/platform/contracts/nativeProxies";
import { nativeProxies } from "../../../src/platform/browser/nativeProxies";

const subject: NativeProxies = nativeProxies;
const socketScheme = location.protocol === "https:" ? "wss:" : "ws:";

describe("browser nativeProxies: ensureHttpProxy", () => {
  it("resolves the page's own origin for the page's host", async () => {
    await expect(subject.ensureHttpProxy(location.host)).resolves.toBe(location.origin);
  });

  it("matches the host without regard to case", async () => {
    await expect(subject.ensureHttpProxy(location.host.toUpperCase())).resolves.toBe(
      location.origin,
    );
  });

  it("resolves the same origin to two concurrent callers", async () => {
    const [first, second] = await Promise.all([
      subject.ensureHttpProxy(location.host),
      subject.ensureHttpProxy(location.host),
    ]);
    expect(first).toBe(location.origin);
    expect(second).toBe(first);
  });

  it("rejects any other host", async () => {
    await expect(subject.ensureHttpProxy("other.example")).rejects.toThrow();
    await expect(subject.ensureHttpProxy(`${location.hostname}:1`)).rejects.toThrow();
  });
});

describe("browser nativeProxies: LiveKit", () => {
  it("reaches a proxy path on the page's host", async () => {
    subject.setLiveKitServerHost(location.host);
    await expect(
      subject.resolveLiveKitUrl("/livekit/rtc", "wss://chat.example:7880"),
    ).resolves.toBe(`${socketScheme}//${location.host}/livekit/rtc`);
  });

  it("ignores the direct URL, and does not depend on the server host being set", async () => {
    subject.setLiveKitServerHost(null);
    await expect(subject.resolveLiveKitUrl("/livekit/rtc", "ws://localhost:7880")).resolves.toBe(
      `${socketScheme}//${location.host}/livekit/rtc`,
    );
  });

  it("passes an absolute URL through", async () => {
    await expect(subject.resolveLiveKitUrl("wss://sfu.example/rtc")).resolves.toBe(
      "wss://sfu.example/rtc",
    );
  });

  it("has nothing to stop", () => {
    expect(() => subject.stopLiveKitProxy()).not.toThrow();
  });
});
