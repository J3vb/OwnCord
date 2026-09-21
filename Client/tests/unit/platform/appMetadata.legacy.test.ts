// Legacy binding for the AppMetadata suite: the in-place seam in
// `settings/LogsTab.ts` (`nativeAppMetadata`), bound with no cast. B7-5
// re-runs `appMetadata.suite.ts` against `platform/desktop` once it moves.
import { vi } from "vitest";
import type { AppMetadata } from "../../../src/platform/contracts/appMetadata";
import { describeAppMetadataSuite } from "./appMetadata.suite";

const getVersion = vi.fn();
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

describeAppMetadataSuite(async () => {
  getVersion.mockReset();
  const mod = await import("../../../src/components/settings/LogsTab");
  const legacy: AppMetadata = mod.nativeAppMetadata;
  return {
    subject: legacy,
    native: {
      version(value: string) {
        getVersion.mockResolvedValue(value);
      },
      failWith(error: unknown) {
        getVersion.mockRejectedValue(error);
      },
    },
  };
});
