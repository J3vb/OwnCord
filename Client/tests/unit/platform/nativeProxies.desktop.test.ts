// Desktop binding for the NativeProxies (ensureHttpProxy) suite:
// `platform/desktop`'s tunnel. B7-5 runs the same suite file here and in
// `nativeProxies.legacy.test.ts`, whose `lib/net/httpProxy.ts` export still
// exists; green in both is the evidence the move changed nothing.
//
// The module keeps a module-level `pending` map to de-duplicate concurrent
// starts, so each test needs a fresh module instance.
import { vi } from "vitest";
import type { NativeProxiesSeam } from "./nativeProxies.suite";
import { describeNativeProxiesSuite, httpNativeControl } from "./nativeProxies.suite";
import * as lm from "../../helpers/loggerMock";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@lib/logger", () => lm.loggerMock());

describeNativeProxiesSuite(async () => {
  vi.resetModules();
  invoke.mockReset();
  const mod = await import("../../../src/platform/desktop/nativeProxies");
  const desktopBinding: NativeProxiesSeam = mod.nativeProxies;
  return {
    subject: desktopBinding,
    native: httpNativeControl(invoke),
  };
});
