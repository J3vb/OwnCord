// Desktop binding for the SettingsStore suite: `platform/desktop`'s settings
// implementation. B7-4 runs the same suite file here and in
// `settings.legacy.test.ts`; green in both is the evidence the move changed
// nothing.
//
// The desktop module reads `invoke` per call through its own dynamic import,
// so toggling the live value below moves it between "succeeds" / "fails" /
// "unavailable" with no module reset — the same getter trick the legacy
// binding uses.
import { vi } from "vitest";
import type { SettingsStore } from "../../../src/platform/contracts/settings";
import { describeSettingsStoreSuite } from "./settings.suite";

const core: {
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
} = { invoke: undefined };

vi.mock("@tauri-apps/api/core", () => ({
  get invoke() {
    return core.invoke;
  },
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mod = await import("../../../src/platform/desktop/settings");
const desktopBinding: SettingsStore = mod.settings;

describeSettingsStoreSuite(async () => {
  core.invoke = undefined;
  return {
    subject: desktopBinding,
    native: {
      succeedWith(value: unknown) {
        core.invoke = vi.fn().mockResolvedValue(value);
      },
      failWith(error: unknown) {
        core.invoke = vi.fn().mockRejectedValue(error);
      },
      unavailable() {
        core.invoke = undefined;
      },
    },
  };
});
