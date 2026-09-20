// Legacy binding for the PushToTalk suite: today's `lib/ptt.ts` exports,
// wrapped with no cast against the contract. B7-5 re-runs
// `pushToTalk.suite.ts` against `platform/desktop` instead of this file.
//
// `ptt.ts` keeps module-level binding/generation state across calls, so each
// test needs a fresh module instance.
import { vi } from "vitest";
import type { PushToTalk } from "../../../src/platform/contracts/pushToTalk";
import { describePushToTalkSuite } from "./pushToTalk.suite";

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@components/settings/helpers", () => ({
  loadPref: () => 0, // no PTT key configured — the common case
  savePref: vi.fn(),
}));
vi.mock("@stores/voice.store", () => ({
  voiceStore: {
    getState: () => ({
      pttGated: false,
      currentChannelId: null,
      joinedAt: null,
      localMuted: false,
      localDeafened: false,
    }),
    subscribe: () => () => {},
  },
  setPttGated: vi.fn(),
  setPttPollingLive: vi.fn(),
  isPttPollingLive: () => false,
}));

describePushToTalkSuite(async () => {
  vi.resetModules();
  invoke
    .mockReset()
    .mockImplementation((cmd: string) =>
      cmd === "ptt_listen_for_key"
        ? Promise.reject(new Error("not configured"))
        : Promise.resolve(undefined),
    );
  listen.mockReset().mockResolvedValue(() => {});

  const mod = await import("../../../src/lib/ptt");
  const legacy: PushToTalk = {
    init: mod.initPtt,
    stop: mod.stopPtt,
    updateKey: mod.updatePttKey,
    captureKeyPress: mod.captureKeyPress,
  };

  return {
    subject: legacy,
    native: {
      captureSucceedsWith(vk: number) {
        invoke.mockImplementation((cmd: string) =>
          cmd === "ptt_listen_for_key" ? Promise.resolve(vk) : Promise.resolve(undefined),
        );
      },
      captureFailsWith(error: unknown) {
        invoke.mockImplementation((cmd: string) =>
          cmd === "ptt_listen_for_key" ? Promise.reject(error) : Promise.resolve(undefined),
        );
      },
    },
  };
});
