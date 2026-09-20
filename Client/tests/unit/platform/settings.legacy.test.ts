// Legacy binding for the SettingsStore suite: today's `lib/profiles.ts`
// `createTauriBackend()`, assigned with no cast against the contract — if
// this line needed a cast, the contract would be wrong (rule 5). B7-4
// re-runs `settings.suite.ts` against `platform/desktop` instead of this
// file.
import { vi } from "vitest";
import type { SettingsStore } from "../../../src/platform/contracts/settings";
import { describeSettingsStoreSuite } from "./settings.suite";

// A getter export so each `await import("@tauri-apps/api/core")` inside
// createTauriBackend() re-reads the live value below.
const core: {
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
} = { invoke: undefined };

vi.mock("@tauri-apps/api/core", () => ({
  get invoke() {
    return core.invoke;
  },
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@lib/httpProxy", () => ({ ensureHttpProxy: vi.fn() }));

const { createTauriBackend } = await import("../../../src/lib/profiles");
const legacy: SettingsStore = createTauriBackend();

describeSettingsStoreSuite(async () => {
  core.invoke = undefined;
  return {
    subject: legacy,
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
