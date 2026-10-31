// Desktop binding for the CredentialStore suite: `platform/desktop`'s
// credentials implementation. B7-4 runs the same suite file here and in
// `credentials.legacy.test.ts`; green in both is the evidence the move
// changed nothing.
//
// The desktop module reads `invoke` per call through its own dynamic import,
// so toggling the live value below moves it between "succeeds" / "fails" /
// "unavailable" with no module reset — the same getter trick the legacy
// binding uses.
import { vi } from "vitest";
import type { CredentialStore } from "../../../src/platform/contracts/credentials";
import { describeCredentialStoreSuite } from "./credentials.suite";
import * as hn from "../../helpers/nativeCoreHarness";
import * as lm from "../../helpers/loggerMock";

const core = hn.makeCore();

vi.mock("@tauri-apps/api/core", () => hn.coreMock(core));
vi.mock("@lib/logger", () => lm.loggerMock());

const mod = await import("../../../src/platform/desktop/credentials");
const desktopBinding: CredentialStore = mod.credentials;

describeCredentialStoreSuite(async () => {
  core.invoke = undefined;
  return {
    subject: desktopBinding,
    native: hn.nativeControls(core),
  };
});
