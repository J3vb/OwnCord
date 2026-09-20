// Legacy binding for the DeepLinks suite: today's `lib/deep-link.ts` export,
// wrapped with no cast against the contract. B7-5 re-runs
// `deepLinks.suite.ts` against `platform/desktop` instead of this file.
//
// Each test needs a fresh module instance and a fresh `vi.doMock` of the
// native plugin — `vi.resetModules()` alone does not reliably force a
// hoisted `vi.mock` factory to re-run once an earlier test in the same file
// already resolved it successfully, so the plugin is (re-)mocked with
// `vi.doMock` right before each fresh import.
import { vi } from "vitest";
import type { DeepLinks } from "../../../src/platform/contracts/deepLinks";
import { describeDeepLinksSuite } from "./deepLinks.suite";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describeDeepLinksSuite(async () => {
  vi.resetModules();
  const legacy: DeepLinks = {
    init: async (onInvite, onMessage) => {
      const mod = await import("../../../src/lib/deep-link");
      return mod.initDeepLinks(onInvite, onMessage);
    },
  };

  return {
    subject: legacy,
    native: {
      coldStartLinks(urls: readonly string[]) {
        vi.doMock("@tauri-apps/plugin-deep-link", () => ({
          register: vi.fn().mockResolvedValue(undefined),
          getCurrent: vi.fn().mockResolvedValue(urls),
          onOpenUrl: vi.fn().mockResolvedValue(undefined),
        }));
      },
      unavailable() {
        vi.doMock("@tauri-apps/plugin-deep-link", () => {
          throw new Error("not running under the native host");
        });
      },
    },
  };
});
