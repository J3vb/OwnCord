// Desktop binding for the LiveKit-proxies suite: `platform/desktop`'s
// `nativeProxies`, which now holds the server host and the tunnel that
// `LiveKitUrlResolver` held. The suite also runs in
// `livekitProxies.legacy.test.ts` against the class, which still exists as the
// LiveKit session's handle; green in both is the evidence the move changed
// nothing.
//
// The server host is module state, so each test needs a fresh module instance.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LiveKitProxiesSeam } from "./livekitProxies.suite";
import { describeLiveKitProxiesSuite } from "./livekitProxies.suite";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describeLiveKitProxiesSuite(async () => {
  vi.resetModules();
  invoke.mockReset().mockResolvedValue(undefined);
  const mod = await import("../../../src/platform/desktop/nativeProxies");
  const desktopBinding: LiveKitProxiesSeam = mod.nativeProxies;
  return {
    subject: desktopBinding,
    native: {
      succeedWith(port: number) {
        invoke.mockImplementation((cmd: string) =>
          cmd === "start_livekit_proxy" ? Promise.resolve(port) : Promise.resolve(undefined),
        );
      },
      failWith(error: unknown) {
        invoke.mockImplementation((cmd: string) =>
          cmd === "start_livekit_proxy" ? Promise.reject(error) : Promise.resolve(undefined),
        );
      },
    },
  };
});

// Linux voice is native (Rust), so its LiveKit socket is outside the
// webview's connect-src: on Linux a loopback direct URL is used as-is even
// for schemes/IPv6 the web path would tunnel. A non-loopback host — notably a
// docker-compose service name like `ws://livekit:7880` that resolves only
// inside the compose network — does not resolve on the host, so it must fall
// back to the /livekit tunnel like every other platform.
describe("nativeProxies on the Linux desktop (native voice)", () => {
  afterEach(() => {
    vi.doUnmock("../../../src/features/voice/native/platform");
  });

  async function resolveOnLinux(directUrl: string): Promise<string> {
    vi.resetModules();
    vi.doMock("../../../src/features/voice/native/platform", () => ({
      isLinuxDesktop: () => true,
    }));
    invoke.mockReset().mockResolvedValue(40123);
    const { nativeProxies } = await import("../../../src/platform/desktop/nativeProxies");
    nativeProxies.setLiveKitServerHost("localhost:8443");
    return nativeProxies.resolveLiveKitUrl("/livekit/rtc", directUrl);
  }

  for (const directUrl of [
    "ws://localhost:7880",
    "ws://127.0.0.1:7880",
    "ws://[::1]:7880",
    "wss://localhost:7880",
  ]) {
    test(`keeps a loopback direct URL ${directUrl}`, async () => {
      await expect(resolveOnLinux(directUrl)).resolves.toBe(directUrl);
    });
  }

  // The Docker-host case from the brief: server on localhost, LiveKit's
  // direct_url points at the compose-internal service name (ws://livekit:7880)
  // which does not resolve on the host, so the tunnel is the only working path.
  for (const directUrl of ["ws://livekit:7880", "ws://my-host:7880"]) {
    test(`tunnels a non-loopback direct URL ${directUrl}`, async () => {
      await expect(resolveOnLinux(directUrl)).resolves.toBe("ws://127.0.0.1:40123/livekit/rtc");
    });
  }
});
