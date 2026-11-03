// The system share sheet. Only the Android app has one; on a desktop host
// `available` is false and callers offer no Share.
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
};
