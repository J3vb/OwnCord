// Legacy binding for the UrlOpener suite: the in-place seam in
// `lib/admin-panel.ts` (`nativeUrlOpener`), bound with no cast. B7-5 re-runs
// `opener.suite.ts` against `platform/desktop` once the opener moves there.
import { vi } from "vitest";
import type { UrlOpener } from "../../../src/platform/contracts/opener";
import { describeUrlOpenerSuite } from "./opener.suite";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

describeUrlOpenerSuite(async () => {
  openUrl.mockReset().mockResolvedValue(undefined);
  const mod = await import("../../../src/lib/admin-panel");
  const legacy: UrlOpener = mod.nativeUrlOpener;
  return {
    subject: legacy,
    native: {
      failWith(error: unknown) {
        openUrl.mockRejectedValue(error);
      },
      opened: () => openUrl.mock.calls.map((call) => call[0] as string),
    },
  };
});
