// Desktop binding for the TrayStatus suite: `platform/desktop`'s tray
// subscription. There is no legacy binding — see the suite's header.
import { vi } from "vitest";
import type { TrayStatus } from "../../../src/platform/contracts/trayStatus";
import { describeTrayStatusSuite } from "./trayStatus.suite";

const handlers = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return Promise.resolve(() => set.delete(handler));
  },
}));

describeTrayStatusSuite(async () => {
  handlers.clear();
  const mod = await import("../../../src/platform/desktop/trayStatus");
  const desktopBinding: TrayStatus = mod.trayStatus;
  return {
    subject: desktopBinding,
    native: {
      async emits(status: string) {
        // Let a subscription that is still registering finish first.
        await Promise.resolve();
        for (const handler of handlers.get("status-change") ?? []) handler({ payload: status });
      },
    },
  };
});
