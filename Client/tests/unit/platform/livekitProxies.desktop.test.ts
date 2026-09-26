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

// Linux has no direct_url exception: its native (Rust) voice path applies the
// same loopback ws:/http: rule as every other platform. Anything else —
// notably a docker-compose service name like `ws://livekit:7880` that resolves
// only inside the compose network — goes through the /livekit tunnel.
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

  for (const directUrl of ["ws://localhost:7880", "ws://127.0.0.1:7880"]) {
    test(`keeps a loopback direct URL ${directUrl}`, async () => {
      await expect(resolveOnLinux(directUrl)).resolves.toBe(directUrl);
    });
  }

  // The Docker-host case: server on localhost, LiveKit's direct_url points at
  // the compose-internal service name (ws://livekit:7880), which does not
  // resolve on the host. wss: and IPv6 loopback get no Linux-only pass either.
  for (const directUrl of [
    "wss://localhost:7880",
    "ws://[::1]:7880",
    "ws://livekit:7880",
    "ws://my-host:7880",
  ]) {
    test(`tunnels a direct URL the shared rule rejects: ${directUrl}`, async () => {
      await expect(resolveOnLinux(directUrl)).resolves.toBe("ws://127.0.0.1:40123/livekit/rtc");
    });
  }
});
