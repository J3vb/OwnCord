// Desktop binding for the GlobalShortcuts suite: `platform/desktop`'s poller
// commands and its `voice-shortcut` subscription. There is no legacy binding —
// see the suite's header.
import { vi } from "vitest";
import type { GlobalShortcuts } from "../../../src/platform/contracts/globalShortcuts";
import { describeGlobalShortcutsSuite } from "./globalShortcuts.suite";

const handlers = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());
const invoked = vi.hoisted(() => [] as string[]);
const supportValue = vi.hoisted(() => ({ value: true }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return Promise.resolve(() => set.delete(handler));
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    invoked.push(command);
    return Promise.resolve(
      command === "voice_shortcuts_supported" ? supportValue.value : undefined,
    );
  },
}));

describeGlobalShortcutsSuite(async () => {
  handlers.clear();
  invoked.length = 0;
  supportValue.value = true;
  const mod = await import("../../../src/platform/desktop/globalShortcuts");
  const subject: GlobalShortcuts = mod.globalShortcuts;
  return {
    subject,
    native: {
      supported: true,
      async emits(action: "mute" | "deafen") {
        // Let the dynamic import + listen() registration finish first.
        for (let i = 0; i < 8; i++) await Promise.resolve();
        for (const handler of handlers.get("voice-shortcut") ?? []) handler({ payload: action });
      },
      commands: () => invoked,
    },
  };
});
