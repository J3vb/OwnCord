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
  setPeerWatching,
  noteWatchingResync,
} from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { startVoiceUiSounds } from "../../src/features/voice/uiSounds";
import { noteVoiceMoved, isVoiceMovePending } from "../../src/features/voice/moveHint";
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

  describe("stream start and end", () => {
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
  describe("viewers of your own stream", () => {
    const peer = (userId: number, screenshare = false) => ({
      ...SELF,
      userId,
      username: `u${String(userId)}`,
      screenshare,
    });
    const setRoster = (users: ReturnType<typeof peer>[]): void => {
      voiceStore.setState((prev) => ({
        ...prev,
        currentChannelId: 10,
        voiceStatus: "connected",
        voiceUsers: new Map([[10, new Map(users.map((u) => [u.userId, u]))]]),
      }));
      voiceStore.flush();
    };
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-21T10:00:00Z"));
      authStore.setState((prev) => ({ ...prev, user: { id: 1, username: "me" } as never }));
      setRoster([peer(1, true), peer(2), peer(3)]);
      vi.advanceTimersByTime(5000);
      playVoiceSound.mockClear();
    });

    it("plays viewerJoin and viewerLeave as people start and stop watching my share", () => {
      setPeerWatching(2, [1]);
      voiceStore.flush();
      setPeerWatching(2, []);
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["viewerJoin"], ["viewerLeave"]]);
    });

    it("ignores people watching someone else's share", () => {
      setRoster([peer(1, true), peer(2, true), peer(3)]);
      playVoiceSound.mockClear();
      setPeerWatching(3, [2]);
      voiceStore.flush();
      setPeerWatching(3, []);
      voiceStore.flush();
      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("plays nothing for a viewer who leaves voice entirely, only the leave", () => {
      setPeerWatching(2, [1]);
      voiceStore.flush();
      playVoiceSound.mockClear();
      removeVoiceUser({ channel_id: 10, user_id: 2 });
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["leave"]]);
    });

    it("plays nothing when my share starts with viewers already on the roster", () => {
      setRoster([peer(1), peer(2), peer(3)]);
      setPeerWatching(2, [1]);
      voiceStore.flush();
      playVoiceSound.mockClear();
      updateVoiceState({ ...voiceState(10, 1), screenshare: true });
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["streamStart"]]);
    });

    it("plays nothing from the re-sync after a resume", () => {
      noteWatchingResync();
      setPeerWatching(2, [1]);
      voiceStore.flush();
      setPeerWatching(3, [1]);
      voiceStore.flush();
      expect(playVoiceSound).not.toHaveBeenCalled();
      // Once the window has passed, a real change sounds again.
      vi.advanceTimersByTime(2500);
      setPeerWatching(3, []);
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["viewerLeave"]]);
    });

    it("respects Do Not Disturb and the voice sounds switch", () => {
      testPrefs.set("voiceSounds", false);
      setPeerWatching(2, [1]);
      voiceStore.flush();
      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("respects the stream sound switch", () => {
      testPrefs.set("soundStream", false);
      setPeerWatching(2, [1]);
      voiceStore.flush();
      expect(playVoiceSound).not.toHaveBeenCalled();
    });
  });
});

describe("voice UI sounds: session start, teardown and ordering", () => {
  const peerRow = (userId: number, screenshare = false) => ({
    ...SELF,
    userId,
    username: `u${String(userId)}`,
    screenshare,
  });
  const signIn = (): void => {
    authStore.setState((prev) => ({ ...prev, user: { id: 1, username: "me" } as never }));
  };
  /** Restart the sounds on top of whatever the store holds now. */
  const restartOn = (patch: Partial<ReturnType<typeof voiceStore.getState>>): void => {
    stop();
    voiceStore.setState((prev) => ({ ...prev, ...patch }));
    voiceStore.flush();
    playVoiceSound.mockClear();
    stop = startVoiceUiSounds();
  };

  describe("a session that is already running when the sounds start", () => {
    it("sounds the leave of a connected session", () => {
      vi.useFakeTimers();
      restartOn({ currentChannelId: 10, voiceStatus: "connected" });

      leaveVoiceChannel();
      voiceStore.flush();
      vi.advanceTimersByTime(250);

      expect(playVoiceSound.mock.calls).toEqual([["leave"]]);
    });

    it("sounds the leave of a session that is reconnecting", () => {
      vi.useFakeTimers();
      restartOn({ currentChannelId: 10, voiceStatus: "reconnecting" });

      leaveVoiceChannel();
      voiceStore.flush();
      vi.advanceTimersByTime(250);

      expect(playVoiceSound.mock.calls).toEqual([["leave"]]);
    });

    it("plays nothing when a join that never connected is abandoned", () => {
      vi.useFakeTimers();
      restartOn({ currentChannelId: 10, voiceStatus: "securing" });

      leaveVoiceChannel();
      voiceStore.flush();
      vi.advanceTimersByTime(1000);

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("plays nothing when a join that is still opening is abandoned", () => {
      vi.useFakeTimers();
      restartOn({ currentChannelId: 10, voiceStatus: "joining" });

      leaveVoiceChannel();
      voiceStore.flush();
      vi.advanceTimersByTime(1000);

      expect(playVoiceSound).not.toHaveBeenCalled();
    });
  });

  describe("your own leave", () => {
    function connectTo(channelId: number): void {
      joinVoiceChannel(channelId);
      voiceStore.flush();
      setVoiceStatus("connected");
      voiceStore.flush();
    }

    it("sounds one leave when two leaves land inside the grace period", () => {
      vi.useFakeTimers();
      connectTo(10);
      leaveVoiceChannel();
      voiceStore.flush();
      connectTo(20);
      leaveVoiceChannel();
      voiceStore.flush();
      playVoiceSound.mockClear();

      vi.advanceTimersByTime(1000);

      expect(playVoiceSound.mock.calls).toEqual([["leave"]]);
    });

    it("sounds nothing for a leave that signing out overtakes", () => {
      vi.useFakeTimers();
      connectTo(10);
      playVoiceSound.mockClear();
      leaveVoiceChannel();
      voiceStore.flush();

      authStore.setState((prev) => ({ ...prev, isAuthenticated: false }));
      resetVoiceStore();
      voiceStore.flush();
      vi.advanceTimersByTime(1000);

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("sounds nothing for a leave still waiting when the sounds are stopped", () => {
      vi.useFakeTimers();
      connectTo(10);
      playVoiceSound.mockClear();
      leaveVoiceChannel();
      voiceStore.flush();

      stop();
      vi.advanceTimersByTime(1000);

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("holds the leave back while a moderator move is noted, even one noted first", () => {
      vi.useFakeTimers();
      connectTo(10);
      playVoiceSound.mockClear();
      noteVoiceMoved(20);

      leaveVoiceChannel();
      voiceStore.flush();
      vi.advanceTimersByTime(1000);

      expect(isVoiceMovePending()).toBe(true);
      expect(playVoiceSound).not.toHaveBeenCalled();
    });
  });

  describe("the move note", () => {
    it("is forgotten when the sounds are stopped", () => {
      noteVoiceMoved(20);
      stop();
      expect(isVoiceMovePending()).toBe(false);
    });

    it("is forgotten when signing out resets the session", () => {
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
      voiceStore.flush();
      noteVoiceMoved(20);

      authStore.setState((prev) => ({ ...prev, isAuthenticated: false }));
      resetVoiceStore();
      voiceStore.flush();

      expect(isVoiceMovePending()).toBe(false);
    });

    it("survives updates that happen while no channel is joined", () => {
      noteVoiceMoved(20);

      setLocalMuted(true);
      voiceStore.flush();

      expect(isVoiceMovePending()).toBe(true);
    });

    it("survives the leave of a live call that the move follows", () => {
      vi.useFakeTimers();
      restartOn({ currentChannelId: 10, voiceStatus: "connected" });
      noteVoiceMoved(20);

      leaveVoiceChannel();
      voiceStore.flush();

      expect(isVoiceMovePending()).toBe(true);
    });

    it("survives a leave that happens while deafened, and is not spent by the next update", () => {
      restartOn({ currentChannelId: 10, voiceStatus: "connected", localDeafened: true });

      leaveVoiceChannel();
      voiceStore.flush();
      noteVoiceMoved(20);
      setLocalMuted(true);
      voiceStore.flush();

      expect(isVoiceMovePending()).toBe(true);
    });

    it("survives a leave that happens under Do Not Disturb, and is not spent by the next update", () => {
      testPrefs.set("userStatus", "dnd");
      restartOn({ currentChannelId: 10, voiceStatus: "connected" });

      leaveVoiceChannel();
      voiceStore.flush();
      noteVoiceMoved(20);
      setLocalMuted(true);
      voiceStore.flush();

      expect(isVoiceMovePending()).toBe(true);
    });
  });

  describe("signing out and back in", () => {
    it("does not read the old deafen flag as an undeafen at the next update", () => {
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10, localDeafened: true }));
      voiceStore.flush();
      authStore.setState((prev) => ({ ...prev, isAuthenticated: false }));
      resetVoiceStore();
      voiceStore.flush();
      authStore.setState((prev) => ({ ...prev, isAuthenticated: true }));
      playVoiceSound.mockClear();

      setLocalMuted(true);
      voiceStore.flush();

      expect(playVoiceSound.mock.calls).toEqual([["mute"]]);
    });
  });

  describe("deafen and the sound switches", () => {
    it("plays no deafen sound under Do Not Disturb", () => {
      testPrefs.set("userStatus", "dnd");
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
      voiceStore.flush();
      playVoiceSound.mockClear();

      setLocalDeafened(true);
      voiceStore.flush();
      setLocalDeafened(false);
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("plays no deafen sound when the voice sounds are off", () => {
      testPrefs.set("voiceSounds", false);
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
      voiceStore.flush();
      playVoiceSound.mockClear();

      setLocalDeafened(true);
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });
  });

  describe("switching channels and rosters", () => {
    it("sounds no mute in the update that starts a channel switch", () => {
      restartOn({ currentChannelId: 10, voiceStatus: "connected" });

      joinVoiceChannel(20);
      setLocalMuted(true);
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("sounds the mute that comes with a roster change in another channel while none is joined", () => {
      updateVoiceState(voiceState(20, 2));
      setLocalMuted(true);
      voiceStore.flush();

      expect(playVoiceSound.mock.calls).toEqual([["mute"]]);
    });

    it("plays nothing when your own row arrives in the roster of your channel", () => {
      signIn();
      voiceStore.setState((prev) => ({
        ...prev,
        currentChannelId: 10,
        voiceUsers: new Map([[10, new Map([[2, peerRow(2)]])]]),
      }));
      voiceStore.flush();
      playVoiceSound.mockClear();

      updateVoiceState(voiceState(10, 1));
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });

    it("plays nothing when your own row leaves the roster of your channel", () => {
      signIn();
      voiceStore.setState((prev) => ({
        ...prev,
        currentChannelId: 10,
        voiceUsers: new Map([
          [
            10,
            new Map([
              [1, peerRow(1)],
              [2, peerRow(2)],
            ]),
          ],
        ]),
      }));
      voiceStore.flush();
      playVoiceSound.mockClear();

      removeVoiceUser({ channel_id: 10, user_id: 1 });
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });
  });

  describe("people watching your stream after your own join", () => {
    const T0 = new Date("2026-10-21T10:00:00Z");
    function sharingRoomJoined(moved: boolean): void {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      signIn();
      voiceStore.setState((prev) => ({
        ...prev,
        voiceUsers: new Map([
          [
            10,
            new Map([
              [1, peerRow(1, true)],
              [2, peerRow(2)],
              [3, peerRow(3)],
            ]),
          ],
        ]),
      }));
      voiceStore.flush();
      if (moved) noteVoiceMoved(10);
      joinVoiceChannel(10);
      voiceStore.flush();
      setVoiceStatus("connected");
      voiceStore.flush();
    }

    it("treats the watch sets sent on a join as a re-sync until the window has passed", () => {
      sharingRoomJoined(false);
      expect(playVoiceSound.mock.calls).toEqual([["join"]]);
      playVoiceSound.mockClear();

      vi.advanceTimersByTime(1999);
      setPeerWatching(2, [1]);
      voiceStore.flush();
      expect(playVoiceSound).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      setPeerWatching(3, [1]);
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["viewerJoin"]]);
    });

    it("treats the watch sets sent after a moderator move the same way", () => {
      sharingRoomJoined(true);
      expect(playVoiceSound.mock.calls).toEqual([["moved"]]);
      playVoiceSound.mockClear();

      vi.advanceTimersByTime(1000);
      setPeerWatching(2, [1]);
      voiceStore.flush();
      expect(playVoiceSound).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1500);
      setPeerWatching(3, [1]);
      voiceStore.flush();
      expect(playVoiceSound.mock.calls).toEqual([["viewerJoin"]]);
    });

    it("plays no viewer sound when no signed-in user id is known", () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      voiceStore.setState((prev) => ({
        ...prev,
        currentChannelId: 10,
        voiceStatus: "connected",
        voiceUsers: new Map([
          [
            10,
            new Map([
              [0, peerRow(0, true)],
              [2, peerRow(2)],
            ]),
          ],
        ]),
      }));
      voiceStore.flush();
      vi.advanceTimersByTime(5000);
      playVoiceSound.mockClear();

      setPeerWatching(2, [0]);
      voiceStore.flush();

      expect(playVoiceSound).not.toHaveBeenCalled();
    });
  });
});
