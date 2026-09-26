// Desktop binding for the UrlOpener suite: `platform/desktop`'s shell opener.
// B7-5 ran the same suite file against the in-place seam in
// `lib/admin-panel.ts` first (proving it could fail and pinning today's
// behaviour), then re-bound it here. The legacy binding is deleted with this
// commit: its export is gone.
import { vi } from "vitest";
import type { UrlOpener } from "../../../src/platform/contracts/opener";
import { describeUrlOpenerSuite } from "./opener.suite";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

describeUrlOpenerSuite(async () => {
  openUrl.mockReset().mockResolvedValue(undefined);
  const mod = await import("../../../src/platform/desktop/urlOpener");
  const desktopBinding: UrlOpener = mod.urlOpener;
  return {
    subject: desktopBinding,
    native: {
      failWith(error: unknown) {
        openUrl.mockRejectedValue(error);
      },
      opened: () => openUrl.mock.calls.map((call) => call[0] as string),
    },
  };
});
