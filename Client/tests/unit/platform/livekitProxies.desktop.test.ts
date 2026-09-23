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
// webview's connect-src: a local server's non-loopback direct URL stays
// direct there. The tunnel would drop the native SDK's Authorization header.
describe("nativeProxies on the Linux desktop (native voice)", () => {
  afterEach(() => {
    vi.doUnmock("../../../src/features/voice/native/platform");
  });

  for (const directUrl of ["ws://my-host:7880", "wss://localhost:7880", "ws://[::1]:7880"]) {
    test(`keeps a local server's direct URL ${directUrl}`, async () => {
      vi.resetModules();
      vi.doMock("../../../src/features/voice/native/platform", () => ({
        isLinuxDesktop: () => true,
      }));
      invoke.mockReset().mockResolvedValue(40123);
      const { nativeProxies } = await import("../../../src/platform/desktop/nativeProxies");
      nativeProxies.setLiveKitServerHost("localhost:8443");
      await expect(nativeProxies.resolveLiveKitUrl("/livekit/rtc", directUrl)).resolves.toBe(
        directUrl,
      );
    });
  }
});
