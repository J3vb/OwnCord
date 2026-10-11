// Every desktop binding that subscribes to a native event registers it with
// `void listen(...).then(...)`. When the host rejects the registration (no
// Tauri runtime, a torn-down webview) that promise must not escape as an
// unhandled rejection: it logs, and the returned unsubscribe stays callable.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.reject(new Error("event host gone")),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(undefined) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: () => Promise.resolve(new Response()) }));

import { trayStatus } from "../../../src/platform/desktop/trayStatus";
import { notifier } from "../../../src/platform/desktop/notifications";
import { http } from "../../../src/platform/desktop/http";
import { nativeVoice } from "../../../src/platform/desktop/nativeVoiceService";
import { expectConsole } from "../../helpers/console";

const noop = (): void => {};

const bindings: ReadonlyArray<readonly [string, () => () => void, RegExp]> = [
  ["trayStatus", () => trayStatus.onStatusChange(noop), /status-change listen failed/],
  ["notifier", () => notifier.onMessageActivated(noop), /notification-click listen failed/],
  ["http", () => http.onUploadProgress(noop), /upload-progress listen failed/],
  ["nativeVoice", () => nativeVoice.onEvent(noop), /native-voice listen failed/],
];

describe("desktop event subscriptions when listen() rejects", () => {
  it.each(bindings)("%s logs the rejection and keeps unsubscribe callable", async (_n, sub, re) => {
    const unsubscribe = sub();
    await vi.waitFor(() => expectConsole("warn", re));
    expect(() => unsubscribe()).not.toThrow();
  });
});
