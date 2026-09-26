// Desktop binding for the DeepLinks suite: `platform/desktop`'s deep-link
// wiring. B7-5 re-runs the same suite file the legacy binding ran against
// `lib/deep-link.ts`'s `initDeepLinks`; that export is now internal to the
// desktop adapter, so the legacy binding is deleted with this commit.
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
  const desktopBinding: DeepLinks = {
    init: async (onInvite, onMessage) => {
      const mod = await import("../../../src/platform/desktop/deepLinks");
      return mod.deepLinks.init(onInvite, onMessage);
    },
  };

  return {
    subject: desktopBinding,
    native: {
      coldStartLinks(urls: readonly string[]) {
        vi.doMock("@tauri-apps/plugin-deep-link", () => ({
          register: vi.fn().mockResolvedValue(undefined),
          getCurrent: vi.fn().mockResolvedValue(urls),
          onOpenUrl: vi.fn().mockResolvedValue(undefined),
        }));
      },
    },
  };
});
