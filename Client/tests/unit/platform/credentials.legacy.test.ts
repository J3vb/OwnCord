// Legacy binding for the CredentialStore suite: today's `lib/credentials.ts`
// exports, wrapped with no cast against the contract. B7-4 re-runs
// `credentials.suite.ts` against `platform/desktop` instead of this file.
import { vi } from "vitest";
import type { CredentialStore } from "../../../src/platform/contracts/credentials";
import { describeCredentialStoreSuite } from "./credentials.suite";

// A getter export so each `await import("@tauri-apps/api/core")` inside
// credentials.ts re-reads the live value below — `getInvoke()` runs its own
// dynamic import per call, and toggling `core.invoke` is enough to move
// between "succeeds" / "fails" / "unavailable" with no module reset needed.
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
vi.mock("@lib/api", () => ({
  ApiClientError: class ApiClientError extends Error {},
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mod = await import("../../../src/lib/credentials");
const legacy: CredentialStore = {
  save: mod.saveCredential,
  load: mod.loadCredential,
  delete: mod.deleteCredential,
  loginWithSavedPassword: mod.loginWithSavedPassword,
};

describeCredentialStoreSuite(async () => {
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
