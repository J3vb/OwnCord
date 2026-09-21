// Desktop binding for the PushToTalk suite: `platform/desktop`'s registered
// push-to-talk facade, which loads the service on first use. B7-5 re-runs the
// same suite file the legacy binding ran against
// `lib/ptt.ts`'s exports; those are now internal to the desktop adapter, so
// the legacy binding is deleted with this commit.
//
// The service keeps module-level binding/generation state across calls, so
// each test needs a fresh module instance.
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

  const mod = await import("../../../src/platform/desktop/pushToTalk");
  const desktopBinding: PushToTalk = mod.pushToTalk;

  return {
    subject: desktopBinding,
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
