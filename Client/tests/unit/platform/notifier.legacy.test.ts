// Legacy binding for the Notifier suite: the in-place seam in
// `lib/notifications.ts` (`nativeNotifier`), bound with no cast. B7-5 re-runs
// `notifier.suite.ts` against `platform/desktop` once the notifier moves there.
import { vi } from "vitest";
import type { Notifier } from "../../../src/platform/contracts/notifications";
import { describeNotifierSuite } from "./notifier.suite";

const isPermissionGranted = vi.fn();
const requestPermission = vi.fn();
const sendNotification = vi.fn();
const requestUserAttention = vi.fn();

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted,
  requestPermission,
  sendNotification,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ requestUserAttention }),
}));

describeNotifierSuite(async () => {
  for (const mock of [isPermissionGranted, requestPermission, sendNotification]) mock.mockReset();
  requestUserAttention.mockReset().mockResolvedValue(undefined);
  const mod = await import("../../../src/lib/notifications");
  const legacy: Notifier = mod.nativeNotifier;
  return {
    subject: legacy,
    native: {
      permissionIs(granted) {
        isPermissionGranted.mockResolvedValue(granted);
      },
      userAnswers(answer) {
        requestPermission.mockResolvedValue(answer);
      },
      unavailable() {
        isPermissionGranted.mockRejectedValue(new Error("not running under the native host"));
      },
      shown: () =>
        sendNotification.mock.calls.map((call) => call[0] as { title: string; body: string }),
      attentionRequests: () => requestUserAttention.mock.calls.length,
    },
  };
});
