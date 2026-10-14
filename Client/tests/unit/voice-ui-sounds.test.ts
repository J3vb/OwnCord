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
  setLocalScreenshare,
  resetVoiceStore,
  joinVoiceChannel,
  leaveVoiceChannel,
  setVoiceStatus,
} from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { startVoiceUiSounds } from "../../src/features/voice/uiSounds";
import { noteVoiceMoved } from "../../src/features/voice/moveHint";
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
  vi.useRealTimers();
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

  describe("stream start and end (WP 1C-4)", () => {
    const member = { ...SELF, userId: 2, username: "peer" };
    beforeEach(() => {
      authStore.setState((prev) => ({ ...prev, user: { id: 1, username: "me" } as never }));
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
    });

    it("plays the stream sounds when a member in your channel starts and stops sharing", () => {
      updateVoiceState({ ...voiceState(10, 2), screenshare: true });
      voiceStore.flush();
      updateVoiceState({ ...voiceState(10, 2), screenshare: false });
      voiceStore.flush();

      expect(playVoiceSound.mock.calls).toEqual([["streamStart"], ["streamEnd"]]);
    });

    it("plays only the join for a member who joins already sharing, and only the leave for one who leaves sharing", () => {
      updateVoiceState({ ...voiceState(10, 3), screenshare: true });
      voiceStore.flush();
      removeVoiceUser({ channel_id: 10, user_id: 3 });
      voiceStore.flush();

      expect(playVoiceSound.mock.calls).toEqual([["join"], ["leave"]]);
    });

    it("plays nothing for a share in another channel, or a camera", () => {
      updateVoiceState({ ...voiceState(20, 4), screenshare: true });
      voiceStore.flush();
      updateVoiceState({ ...voiceState(10, 2), camera: true });
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("plays nothing when a reconnect replays a member already sharing", () => {
      setVoiceStates([
        { channel_id: 10, user_id: 1, muted: false, deafened: false },
        { channel_id: 10, user_id: 2, muted: false, deafened: false, screenshare: true },
      ]);
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("plays the stream sounds when the server has your own share start and stop", () => {
      updateVoiceState({ ...voiceState(10, 1), screenshare: true });
      voiceStore.flush();
      updateVoiceState({ ...voiceState(10, 1), screenshare: false });
      voiceStore.flush();

      expect(playVoiceSound.mock.calls).toEqual([["streamStart"], ["streamEnd"]]);
    });

    it("plays nothing for a share the server never had (picker cancelled)", () => {
      setLocalScreenshare(true);
      voiceStore.flush();
      setLocalScreenshare(false);
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("plays nothing for a share while deafened", () => {
      setLocalDeafened(true);
      voiceStore.flush();
      playVoiceSound.mockClear();
      updateVoiceState({ ...voiceState(10, 2), screenshare: true });
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });
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

  it("plays nothing on a voice-session reset (sign-out)", () => {
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10, localDeafened: true }));
    voiceStore.flush();
    playVoiceSound.mockClear();

    authStore.setState((prev) => ({ ...prev, isAuthenticated: false }));
    resetVoiceStore();
    voiceStore.flush();

    expect(playVoiceSound).not.toHaveBeenCalled();
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

  describe("your own join, leave and move", () => {
    function connectTo(channelId: number): void {
      joinVoiceChannel(channelId);
      voiceStore.flush();
      setVoiceStatus("securing");
      voiceStore.flush();
      setVoiceStatus("connected");
      voiceStore.flush();
    }

    it("plays the join sound when the session connects, not on the click", () => {
      joinVoiceChannel(10);
      voiceStore.flush();
      setVoiceStatus("securing");
      voiceStore.flush();
      expect(playVoiceSound).not.toHaveBeenCalled();

      setVoiceStatus("connected");
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["join"]]);
    });

    it("plays nothing for a join that fails before it connects", () => {
      joinVoiceChannel(10);
      voiceStore.flush();
      setVoiceStatus("securing");
      voiceStore.flush();
      leaveVoiceChannel();
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("plays the leave sound when a connected session ends", () => {
      vi.useFakeTimers();
      connectTo(10);
      playVoiceSound.mockClear();

      leaveVoiceChannel();
      voiceStore.flush();
      // Held briefly, in case a moderator move is right behind it.
      expect(playVoiceSound).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);

      expect(playVoiceSound.mock.calls).toEqual([["leave"]]);
      vi.useRealTimers();
    });

    it("plays nothing for a reconnect inside the same channel", () => {
      connectTo(10);
      playVoiceSound.mockClear();

      setVoiceStatus("reconnecting");
      voiceStore.flush();
      setVoiceStatus("idle");
      setVoiceStatus("joining");
      voiceStore.flush();
      setVoiceStatus("connected");
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("plays only the join, once the new channel connects, on a switch", () => {
      connectTo(10);
      playVoiceSound.mockClear();

      joinVoiceChannel(20);
      voiceStore.flush();
      expect(playVoiceSound).not.toHaveBeenCalled();

      setVoiceStatus("connected");
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["join"]]);
    });

    it("plays the moved tone, not the join one, when a moderator moves you", () => {
      vi.useFakeTimers();
      connectTo(10);
      playVoiceSound.mockClear();

      // The server's order: voice_leave (its own frame, so the store flushes
      // before the next), then voice_moved, whose handler notes the move and
      // joins the destination.
      leaveVoiceChannel();
      voiceStore.flush();
      noteVoiceMoved(20);
      joinVoiceChannel(20);
      voiceStore.flush();
      vi.advanceTimersByTime(250);
      expect(playVoiceSound).not.toHaveBeenCalled();

      setVoiceStatus("connected");
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["moved"]]);

      // The note is spent: your own next switch is an ordinary join.
      playVoiceSound.mockClear();
      joinVoiceChannel(30);
      voiceStore.flush();
      setVoiceStatus("connected");
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["join"]]);
      vi.useRealTimers();
    });

    it("spends the move note when the destination join fails", () => {
      vi.useFakeTimers();
      connectTo(10);
      leaveVoiceChannel();
      voiceStore.flush();
      noteVoiceMoved(20);
      joinVoiceChannel(20);
      voiceStore.flush();
      leaveVoiceChannel();
      voiceStore.flush();
      vi.advanceTimersByTime(250);
      playVoiceSound.mockClear();

      // Joining that channel yourself later is an ordinary join.
      connectTo(20);
      expect(playVoiceSound.mock.calls).toEqual([["join"]]);
      vi.useRealTimers();
    });
  });
});
