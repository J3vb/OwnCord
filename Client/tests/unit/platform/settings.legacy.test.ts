// Legacy binding for the SettingsStore suite: today's `lib/presence/profiles.ts`
// `createTauriBackend()`, assigned with no cast against the contract — if
// this line needed a cast, the contract would be wrong (rule 5). B7-4
// re-runs `settings.suite.ts` against `platform/desktop` instead of this
// file.
import { vi } from "vitest";
import type { SettingsStore } from "../../../src/platform/contracts/settings";
import { describeSettingsStoreSuite } from "./settings.suite";
import * as hn from "../../helpers/nativeCoreHarness";

// A getter export so each `await import("@tauri-apps/api/core")` inside
// createTauriBackend() re-reads the live value below.
const core = hn.makeCore();

vi.mock("@tauri-apps/api/core", () => hn.coreMock(core));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@lib/net/httpProxy", () => ({ ensureHttpProxy: vi.fn() }));

const { createTauriBackend } = await import("../../../src/lib/presence/profiles");
const legacy: SettingsStore = createTauriBackend();

describeSettingsStoreSuite(async () => {
  core.invoke = undefined;
  return {
    subject: legacy,
    native: hn.nativeControls(core),
  };
});
