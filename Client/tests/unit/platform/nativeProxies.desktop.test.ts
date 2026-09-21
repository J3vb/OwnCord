// Desktop binding for the NativeProxies (ensureHttpProxy) suite:
// `platform/desktop`'s tunnel. B7-5 runs the same suite file here and in
// `nativeProxies.legacy.test.ts`, whose `lib/httpProxy.ts` export still
// exists; green in both is the evidence the move changed nothing.
//
// The module keeps a module-level `pending` map to de-duplicate concurrent
// starts, so each test needs a fresh module instance.
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
  const mod = await import("../../../src/platform/desktop/nativeProxies");
  const desktopBinding: NativeProxiesSeam = mod.nativeProxies;
  return {
    subject: desktopBinding,
    native: {
      succeedWith(port: number) {
        let n = 0;
        invoke.mockImplementation(() => Promise.resolve(port + n++));
      },
      failWith(error: unknown) {
        invoke.mockRejectedValue(error);
      },
    },
  };
});
