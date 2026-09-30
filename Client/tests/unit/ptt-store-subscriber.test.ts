/**
 * The PTT binding subscribes to the real voiceStore and writes the
 * pttOwnsMute latch from inside a notification. A write on every
 * notification re-enters the store's drain loop forever, freezing the
 * client on the first voice-store update after a key is bound (the
 * `ready` payload at login). ptt.test.ts mocks the store, so this runs
 * against the real one.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "ptt_polling_supported" ? true : undefined)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@lib/preferences", () => ({
  loadPref: (key: string, fallback: unknown) => (key === "pttVk" ? 0x56 : fallback),
  savePref: vi.fn(),
}));

vi.mock("../../src/lib/livekitSession", () => ({
  setMuted: vi.fn(),
}));

import { voiceStore, setVoiceStates, setPttOwnsMute, resetVoiceStore } from "@stores/voice.store";
import { pushToTalk } from "../../src/platform/desktop/pushToTalkService";

afterEach(async () => {
  await pushToTalk.stop();
  resetVoiceStore();
});

describe("PTT voiceStore subscriber", () => {
  it("settles after a voice-store update instead of re-notifying forever", async () => {
    let notifications = 0;
    const unsubscribe = voiceStore.subscribe(() => {
      if (++notifications > 1000) throw new Error("voiceStore notify loop");
    });
    await pushToTalk.init();
    setVoiceStates([]);
    await Promise.resolve();
    await Promise.resolve();
    unsubscribe();

    expect(notifications).toBeLessThan(10);
  });

  it("still clears a PTT-owned latch once the mic is unmuted", async () => {
    await pushToTalk.init();
    setPttOwnsMute(true);
    await Promise.resolve();

    expect(voiceStore.getState().localMuted).toBe(false);
    expect(voiceStore.getState().pttOwnsMute).toBe(false);
  });
});
