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

let configuredVk = 0;
let captureBehavior: () => Promise<number> = () => Promise.reject(new Error("not configured"));
let pollingLive = false;

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("@components/settings/helpers", () => ({
  loadPref: () => configuredVk,
  savePref: (_key: string, vk: number) => {
    configuredVk = vk;
  },
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
  setPttPollingLive: (live: boolean) => {
    pollingLive = live;
  },
  isPttPollingLive: () => pollingLive,
}));

describePushToTalkSuite(async () => {
  vi.resetModules();
  configuredVk = 0;
  pollingLive = false;
  captureBehavior = () => Promise.reject(new Error("not configured"));
  invoke.mockReset().mockImplementation((cmd: string) => {
    if (cmd === "ptt_listen_for_key") return captureBehavior();
    if (cmd === "ptt_polling_supported") return Promise.resolve(true);
    return Promise.resolve(undefined);
  });
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
        captureBehavior = () => Promise.resolve(vk);
      },
      captureFailsWith(error: unknown) {
        captureBehavior = () => Promise.reject(error);
      },
      configuredKey(vk: number) {
        configuredVk = vk;
      },
      pollingStarted() {
        return pollingLive;
      },
    },
  };
});
