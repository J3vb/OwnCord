// Desktop binding for the IdentityStore suite: `platform/desktop`'s identity
// implementation. B7-4 runs the same suite file here and in
// `identityStore.legacy.test.ts`; green in both is the evidence the move
// changed nothing.
//
// The desktop module reads `invoke` per call through its own dynamic import,
// so toggling the live value below moves it between "succeeds" / "fails" /
// "unavailable" with no module reset — the same getter trick the legacy
// binding uses.
import { vi } from "vitest";
import type { IdentityStore } from "../../../src/platform/contracts/identityStore";
import { describeIdentityStoreSuite } from "./identityStore.suite";

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

const mod = await import("../../../src/platform/desktop/identity");
const desktopBinding: IdentityStore = mod.identity;

describeIdentityStoreSuite(async () => {
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
