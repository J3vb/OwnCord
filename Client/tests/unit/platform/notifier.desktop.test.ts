// Desktop binding for the Notifier suite: `platform/desktop`'s notifier. B7-5
// ran the same suite file against the in-place seam in `lib/notifications.ts`
// first (proving it could fail and pinning today's behaviour), then re-bound
// it here. The legacy binding is deleted with this commit: its export is gone.
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
  const mod = await import("../../../src/platform/desktop/notifications");
  const desktopBinding: Notifier = mod.notifier;
  return {
    subject: desktopBinding,
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
