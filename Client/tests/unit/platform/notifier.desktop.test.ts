// Desktop binding for the Notifier suite: `platform/desktop`'s notifier. B7-5
// ran the same suite file against the in-place seam in `lib/notifications.ts`
// first (proving it could fail and pinning today's behaviour), then re-bound
// it here. The legacy binding is deleted with this commit: its export is gone.
import { vi } from "vitest";
import type { Notifier, NotificationTarget } from "../../../src/platform/contracts/notifications";
import { describeNotifierSuite } from "./notifier.suite";

const isPermissionGranted = vi.fn();
const requestPermission = vi.fn();
const sendNotification = vi.fn();
const requestUserAttention = vi.fn();
const invoke = vi.fn();
type ActivationHandler = (e: { payload: NotificationTarget }) => void;
const handlers = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted,
  requestPermission,
  sendNotification,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ requestUserAttention }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return Promise.resolve(() => set.delete(handler));
  },
}));

describeNotifierSuite(async () => {
  for (const mock of [isPermissionGranted, requestPermission, sendNotification]) mock.mockReset();
  requestUserAttention.mockReset().mockResolvedValue(undefined);
  invoke.mockReset().mockResolvedValue(undefined);
  handlers.clear();
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
      messageShown: () =>
        invoke.mock.calls
          .filter((call) => call[0] === "notify_message")
          .map((call) => {
            const args = call[1] as {
              title: string;
              body: string;
              host: string;
              channelId: number;
              messageId?: number;
            };
            const { host, channelId, messageId } = args;
            return {
              title: args.title,
              body: args.body,
              target:
                messageId === undefined ? { host, channelId } : { host, channelId, messageId },
            };
          }),
      async emitsActivation(target) {
        // Let a subscription that is still registering finish first.
        await Promise.resolve();
        await Promise.resolve();
        for (const handler of handlers.get("notification-click") ?? [])
          (handler as ActivationHandler)({ payload: target });
      },
      attentionRequests: () => requestUserAttention.mock.calls.length,
      // Tauri's UserAttentionType: 1 is Critical, 2 Informational.
      urgentAttentionRequests: () =>
        requestUserAttention.mock.calls.filter((call) => call[0] === 1).length,
      badgeCounts: () =>
        invoke.mock.calls
          .filter((call) => call[0] === "set_unread_badge")
          .map((call) => (call[1] as { count: number }).count),
      ringsShown: () =>
        invoke.mock.calls
          .filter((call) => call[0] === "notify_message" && (call[1] as { ring?: boolean }).ring)
          .map((call) => (call[1] as { channelId: number }).channelId),
      callsCleared: () =>
        invoke.mock.calls
          .filter((call) => call[0] === "clear_call_notification")
          .map((call) => (call[1] as { channelId: number }).channelId),
    },
  };
});
