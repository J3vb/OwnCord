/**
 * DP-40: voice join/leave and mute/deafen sounds. The edge logic lives in
 * features/voice/uiSounds.ts; this pins the tricky ones — a remote join in the
 * current channel plays once, a PTT gate edge plays nothing, and an initial
 * roster or reconnect replay does not produce a storm.
 *
 * The audio graph itself (the shared sink, the deafen silence) is
 * notification-sound.test.ts's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { testPrefs, playVoiceSound } = vi.hoisted(() => ({
  testPrefs: new Map<string, unknown>(),
  playVoiceSound: vi.fn(),
}));

vi.mock("../../src/lib/preferences", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));

vi.mock("../../src/lib/notificationSound", () => ({ playVoiceSound }));

import {
  voiceStore,
  setVoiceStates,
  updateVoiceState,
  removeVoiceUser,
  setLocalMuted,
  setLocalDeafened,
  setPttGated,
} from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { startVoiceUiSounds } from "../../src/features/voice/uiSounds";
import type { ReadyVoiceState, VoiceStatePayload } from "@lib/types";

function voiceState(channelId: number, userId: number): VoiceStatePayload {
  return {
    channel_id: channelId,
    user_id: userId,
    username: `user-${userId}`,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
  };
}

const SELF = {
  userId: 1,
  username: "me",
  muted: false,
  deafened: false,
  speaking: false,
  camera: false,
  screenshare: false,
};

let stop: () => void = () => {};

beforeEach(() => {
  testPrefs.clear();
  playVoiceSound.mockClear();
  authStore.setState(() => ({
    token: "t",
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
    voiceStatus: "idle",
    peerVerifications: new Map(),
  }));
  stop = startVoiceUiSounds();
});

afterEach(() => {
  stop();
});

describe("voice UI sounds", () => {
  it("plays the join sound once for a remote voice_join in the current channel", () => {
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 10,
      voiceUsers: new Map([[10, new Map([[1, SELF]])]]),
    }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    updateVoiceState(voiceState(10, 2));
    voiceStore.flush();

    expect(playVoiceSound.mock.calls).toEqual([["join"]]);
  });

  it("plays the leave sound once for a remote voice_leave", () => {
    const member = { ...SELF, userId: 2, username: "peer" };
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 10,
      voiceUsers: new Map([
        [
          10,
          new Map([
            [1, SELF],
            [2, member],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    removeVoiceUser({ channel_id: 10, user_id: 2 });
    voiceStore.flush();

    expect(playVoiceSound.mock.calls).toEqual([["leave"]]);
  });

  it("plays nothing for a peer's mute toggle in the current channel", () => {
    const member = { ...SELF, userId: 2, username: "peer" };
    voiceStore.setState((prev) => ({
      ...prev,
      currentChannelId: 10,
      voiceUsers: new Map([
        [
          10,
          new Map([
            [1, SELF],
            [2, member],
          ]),
        ],
      ]),
    }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    updateVoiceState({ ...voiceState(10, 2), muted: true });
    voiceStore.flush();

    expect(playVoiceSound).not.toHaveBeenCalled();
  });

  it("plays nothing for a voice_state in another channel", () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    updateVoiceState(voiceState(20, 2));
    voiceStore.flush();

    expect(playVoiceSound).not.toHaveBeenCalled();
  });

  it("plays nothing for a push-to-talk gate edge", () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    setPttGated(true);
    voiceStore.flush();
    setPttGated(false);
    voiceStore.flush();

    expect(playVoiceSound).not.toHaveBeenCalled();
  });

  it("does not storm on the initial roster", () => {
    const states: ReadyVoiceState[] = [
      { channel_id: 10, user_id: 1, muted: false, deafened: false },
      { channel_id: 10, user_id: 2, muted: false, deafened: false },
      { channel_id: 10, user_id: 3, muted: false, deafened: false },
    ];
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    setVoiceStates(states);
    voiceStore.flush();

    expect(playVoiceSound).not.toHaveBeenCalled();
  });

  it("plays the mute and unmute sounds on the local mute edge", () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    setLocalMuted(true);
    voiceStore.flush();
    setLocalMuted(false);
    voiceStore.flush();

    expect(playVoiceSound.mock.calls).toEqual([["mute"], ["unmute"]]);
  });

  it("plays the deafen sound and suppresses the accompanying mute edge", () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    setLocalDeafened(true);
    setLocalMuted(true);
    voiceStore.flush();

    expect(playVoiceSound.mock.calls).toEqual([["deafen"]]);
  });

  it("plays the undeafen sound on the deafen falling edge", () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10, localDeafened: true }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    setLocalDeafened(false);
    voiceStore.flush();

    expect(playVoiceSound.mock.calls).toEqual([["undeafen"]]);
  });

  it("obeys Do Not Disturb, matching the message chime", () => {
    testPrefs.set("userStatus", "dnd");
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    setLocalMuted(true);
    voiceStore.flush();

    expect(playVoiceSound).not.toHaveBeenCalled();
  });

  it("plays nothing while deafened", () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10, localDeafened: true }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    updateVoiceState(voiceState(10, 2));
    voiceStore.flush();

    expect(playVoiceSound).not.toHaveBeenCalled();
  });

  it("obeys the voiceSounds preference", () => {
    testPrefs.set("voiceSounds", false);
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    setLocalMuted(true);
    voiceStore.flush();

    expect(playVoiceSound).not.toHaveBeenCalled();
  });
});
