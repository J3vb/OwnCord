// Legacy binding for the IdentityStore suite: today's `lib/net/identity.ts`
// exports, wrapped with no cast against the contract. B7-4 re-runs
// `identityStore.suite.ts` against `platform/desktop` instead of this file.
import { vi } from "vitest";
import type { IdentityStore } from "../../../src/platform/contracts/identityStore";
import { describeIdentityStoreSuite } from "./identityStore.suite";
import * as hn from "../../helpers/nativeCoreHarness";
import * as lm from "../../helpers/loggerMock";

// A getter export so each `await import("@tauri-apps/api/core")` inside
// identity.ts re-reads the live value below — every wrapper here does its
// own dynamic import per call, so toggling `core.invoke` moves between
// "succeeds" / "fails" / "unavailable" with no module reset needed.
const core = hn.makeCore();

vi.mock("@tauri-apps/api/core", () => hn.coreMock(core));
vi.mock("@stores/auth.store", () => ({
  authStore: { getState: () => ({ user: null, token: null }) },
}));
vi.mock("@lib/logger", () => lm.loggerMock());

const mod = await import("../../../src/lib/net/identity");
const legacy: IdentityStore = {
  saveKey: mod.saveIdentityKey,
  loadKey: mod.loadIdentityKey,
  deleteKey: mod.deleteIdentityKey,
  storePin: mod.storeIdentityPin,
  getPin: mod.getIdentityPin,
};

describeIdentityStoreSuite(async () => {
  core.invoke = undefined;
  return {
    subject: legacy,
    native: hn.nativeControls(core),
  };
});
