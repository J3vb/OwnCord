// Legacy binding for the LiveKit-proxies suite: today's `LiveKitUrlResolver`
// (`lib/livekitUrlResolver.ts`), wrapped with no cast against the seam subset
// of the contract. B7-5 re-runs `livekitProxies.suite.ts` against
// `platform/desktop` once the tunnel moves there.
import { vi } from "vitest";
import type { LiveKitProxiesSeam } from "./livekitProxies.suite";
import { describeLiveKitProxiesSuite } from "./livekitProxies.suite";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describeLiveKitProxiesSuite(async () => {
  invoke.mockReset().mockResolvedValue(undefined);
  const { LiveKitUrlResolver } = await import("../../../src/lib/livekitUrlResolver");
  const resolver = new LiveKitUrlResolver();
  const legacy: LiveKitProxiesSeam = {
    setLiveKitServerHost: (host) => resolver.setServerHost(host),
    resolveLiveKitUrl: (proxyPath, directUrl) => resolver.resolve(proxyPath, directUrl),
    stopLiveKitProxy: () => resolver.stopProxy(),
  };
  return {
    subject: legacy,
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
