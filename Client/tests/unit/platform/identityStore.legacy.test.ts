// Legacy binding for the IdentityStore suite: today's `lib/identity.ts`
// exports, wrapped with no cast against the contract. B7-4 re-runs
// `identityStore.suite.ts` against `platform/desktop` instead of this file.
import { vi } from "vitest";
import type { IdentityStore } from "../../../src/platform/contracts/identityStore";
import { describeIdentityStoreSuite } from "./identityStore.suite";

// A getter export so each `await import("@tauri-apps/api/core")` inside
// identity.ts re-reads the live value below — every wrapper here does its
// own dynamic import per call, so toggling `core.invoke` moves between
// "succeeds" / "fails" / "unavailable" with no module reset needed.
const core: {
  invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined;
} = { invoke: undefined };

vi.mock("@tauri-apps/api/core", () => ({
  get invoke() {
    return core.invoke;
  },
}));
vi.mock("@stores/auth.store", () => ({
  authStore: { getState: () => ({ user: null, token: null }) },
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mod = await import("../../../src/lib/identity");
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
