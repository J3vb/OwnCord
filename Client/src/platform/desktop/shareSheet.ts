// The system share sheet, both ways. Only the Android app has one; on a
// desktop host `available` is false, callers offer no Share and nothing is
// ever received.
import { isAndroidHost } from "@lib/hostPlatform";
import type { ShareSheet } from "../contracts/shareSheet";

// i18n-exempt: internal error, logged by the caller, never rendered
const NO_SHEET = "no share sheet on this host";

export const shareSheet: ShareSheet = {
  get available() {
    return isAndroidHost();
  },
  async shareFile(name, data) {
    if (!isAndroidHost()) throw new Error(NO_SHEET);
    await (await import("./androidFiles")).shareFile(name, data);
  },
  async shareText(text) {
    if (!isAndroidHost()) throw new Error(NO_SHEET);
    await (await import("./androidFiles")).shareText(text);
  },
  onReceived(handler) {
    if (!isAndroidHost()) return () => undefined;
    let active = true;
    let stop: (() => void) | null = null;
    import("./androidShareIn")
      .then((m) => {
        if (active) stop = m.listenForShares(handler);
      })
      .catch(() => {
        // The chunk did not load (an update replaced it): no shares this run.
      });
    return () => {
      active = false;
      stop?.();
    };
  },
};
