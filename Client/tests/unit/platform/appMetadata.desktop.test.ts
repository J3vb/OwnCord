// Desktop binding for the AppMetadata suite: `platform/desktop`'s app
// metadata. B7-5 ran the same suite file against the in-place seam in
// `settings/LogsTab.ts` first (proving it could fail and pinning today's
// behaviour), then re-bound it here. The legacy binding is deleted with this
// commit: its export is gone.
import { vi } from "vitest";
import type { AppMetadata } from "../../../src/platform/contracts/appMetadata";
import { describeAppMetadataSuite } from "./appMetadata.suite";

const getVersion = vi.fn();
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));

describeAppMetadataSuite(async () => {
  getVersion.mockReset();
  const mod = await import("../../../src/platform/desktop/appMetadata");
  const desktopBinding: AppMetadata = mod.appMetadata;
  return {
    subject: desktopBinding,
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
