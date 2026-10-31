// Desktop binding for the GlobalShortcuts suite: `platform/desktop`'s poller
// commands and its `voice-shortcut` subscription. There is no legacy binding —
// see the suite's header.
import { vi } from "vitest";
import { tauriEventMock } from "../../helpers/tauriEventMock";
import type { GlobalShortcuts } from "../../../src/platform/contracts/globalShortcuts";
import { describeGlobalShortcutsSuite } from "./globalShortcuts.suite";

const handlers = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());
const invoked = vi.hoisted(() => [] as string[]);
const supportValue = vi.hoisted(() => ({ value: true }));
const statusPayload = vi.hoisted(() => ({ value: undefined as unknown }));
const rejections = vi.hoisted(() => new Map<string, unknown>());
const lastArgs = vi.hoisted(() => new Map<string, Record<string, unknown> | undefined>());
const keyCodes = vi.hoisted(() => ({
  value: undefined as { muteVk: number; deafenVk: number } | undefined,
}));

vi.mock("@tauri-apps/api/event", () => tauriEventMock(handlers));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => {
    invoked.push(command);
    lastArgs.set(command, args);
    if (rejections.has(command)) return Promise.reject(rejections.get(command));
    if (command === "global_keys_status" || command === "global_keys_portal_bind") {
      return Promise.resolve(statusPayload.value);
    }
    if (command === "voice_shortcuts_set_keys") {
      keyCodes.value = { muteVk: args?.muteVk as number, deafenVk: args?.deafenVk as number };
    }
    return Promise.resolve(
      command === "voice_shortcuts_supported" ? supportValue.value : undefined,
    );
  },
}));

describeGlobalShortcutsSuite(async () => {
  handlers.clear();
  invoked.length = 0;
  supportValue.value = true;
  keyCodes.value = undefined;
  statusPayload.value = undefined;
  rejections.clear();
  lastArgs.clear();
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
      statusIs(payload: unknown) {
        statusPayload.value = payload;
      },
      rejects(command: string, reason: unknown) {
        rejections.set(command, reason);
      },
      lastArgs: (command: string) => lastArgs.get(command),
      async emitsStatus(payload: unknown) {
        for (let i = 0; i < 8; i++) await Promise.resolve();
        for (const handler of Array.from(handlers.get("global-keys-changed") ?? []))
          handler({ payload });
        // The payload is narrowed in a lazily imported module; let it settle.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      statusListeners: () => handlers.get("global-keys-changed")?.size ?? 0,
      keyCodes: () => keyCodes.value,
    },
  };
});
