// Desktop binding for the UrlOpener suite: `platform/desktop`'s shell opener.
// B7-5 ran the same suite file against the in-place seam in
// `lib/adminPanel.ts` first (proving it could fail and pinning today's
// behaviour), then re-bound it here. The legacy binding is deleted with this
// commit: its export is gone. The shell opener is the `open_external_url`
// command now, so the native side here is `invoke`.
import { vi } from "vitest";
import type { UrlOpener } from "../../../src/platform/contracts/opener";
import { describeUrlOpenerSuite } from "./opener.suite";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describeUrlOpenerSuite(async () => {
  invoke.mockReset().mockResolvedValue(undefined);
  const mod = await import("../../../src/platform/desktop/urlOpener");
  const desktopBinding: UrlOpener = mod.urlOpener;
  return {
    subject: desktopBinding,
    native: {
      failWith(error: unknown) {
        invoke.mockRejectedValue(error);
      },
      opened: () =>
        invoke.mock.calls
          .filter((call) => call[0] === "open_external_url")
          .map((call) => (call[1] as { url: string }).url),
    },
  };
});
