// Legacy binding for the CredentialStore suite: today's `lib/net/credentials.ts`
// exports, wrapped with no cast against the contract. B7-4 re-runs
// `credentials.suite.ts` against `platform/desktop` instead of this file.
import { vi } from "vitest";
import type { CredentialStore } from "../../../src/platform/contracts/credentials";
import { describeCredentialStoreSuite } from "./credentials.suite";
import * as hn from "../../helpers/nativeCoreHarness";
import * as lm from "../../helpers/loggerMock";

// A getter export so each `await import("@tauri-apps/api/core")` inside
// credentials.ts re-reads the live value below — `getInvoke()` runs its own
// dynamic import per call, and toggling `core.invoke` is enough to move
// between "succeeds" / "fails" / "unavailable" with no module reset needed.
const core = hn.makeCore();

vi.mock("@tauri-apps/api/core", () => hn.coreMock(core));
vi.mock("@stores/auth.store", () => ({
  authStore: { getState: () => ({ user: null, token: null }) },
}));
vi.mock("@lib/api", () => ({
  ApiClientError: class ApiClientError extends Error {},
}));
vi.mock("@lib/logger", () => lm.loggerMock());

const mod = await import("../../../src/lib/net/credentials");
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
    native: hn.nativeControls(core),
  };
});
