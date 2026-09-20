// Legacy binding for the NativeProxies (ensureHttpProxy) suite: today's
// `lib/httpProxy.ts` export, wrapped with no cast against the seam subset of
// the contract. B7-5 re-runs `nativeProxies.suite.ts` against
// `platform/desktop` instead of this file.
//
// `httpProxy.ts` keeps a module-level `pending` map to de-duplicate
// concurrent starts, so each test needs a fresh module instance.
import { vi } from "vitest";
import type { NativeProxiesSeam } from "./nativeProxies.suite";
import { describeNativeProxiesSuite } from "./nativeProxies.suite";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describeNativeProxiesSuite(async () => {
  vi.resetModules();
  invoke.mockReset();
  const mod = await import("../../../src/lib/httpProxy");
  const legacy: NativeProxiesSeam = { ensureHttpProxy: mod.ensureHttpProxy };
  return {
    subject: legacy,
    native: {
      succeedWith(port: number) {
        invoke.mockResolvedValue(port);
      },
      failWith(error: unknown) {
        invoke.mockRejectedValue(error);
      },
    },
  };
});
