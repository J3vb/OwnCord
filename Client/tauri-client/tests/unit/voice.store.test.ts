import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  voiceStore,
  setVoiceStates,
  updateVoiceState,
  removeVoiceUser,
  joinVoiceChannel,
  leaveVoiceChannel,
  setLocalMuted,
  setLocalDeafened,
  getChannelVoiceUsers,
} from "../../src/stores/voice.store";
import type {
  ReadyVoiceState,
  VoiceStatePayload,
  VoiceLeavePayload,
} from "../../src/lib/types";

function resetStore(): void {
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
  }));
}

const VOICE_STATE_1: ReadyVoiceState = {
  channel_id: 10,
  user_id: 1,
  muted: false,
  deafened: false,
};

const VOICE_STATE_2: ReadyVoiceState = {
  channel_id: 10,
  user_id: 2,
  muted: true,
  deafened: false,
};

const VOICE_STATE_3: ReadyVoiceState = {
  channel_id: 20,
  user_id: 3,
  muted: false,
  deafened: true,
};

const FULL_VOICE_PAYLOAD: VoiceStatePayload = {
  channel_id: 10,
  user_id: 5,
  username: "dave",
  muted: false,
  deafened: false,
  speaking: true,
  camera: false,
  screenshare: false,
};

describe("voice store", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("initial state", () => {
    it("has null currentChannelId", () => {
      expect(voiceStore.getState().currentChannelId).toBeNull();
    });

    it("has empty voiceUsers map", () => {
      expect(voiceStore.getState().voiceUsers.size).toBe(0);
    });

    it("has localMuted false", () => {
      expect(voiceStore.getState().localMuted).toBe(false);
    });

    it("has localDeafened false", () => {
      expect(voiceStore.getState().localDeafened).toBe(false);
    });
  });

  describe("setVoiceStates", () => {
    it("populates voice users grouped by channel", () => {
      setVoiceStates([VOICE_STATE_1, VOICE_STATE_2, VOICE_STATE_3]);
      const state = voiceStore.getState();
      expect(state.voiceUsers.size).toBe(2); // 2 channels
      expect(state.voiceUsers.get(10)?.size).toBe(2);
      expect(state.voiceUsers.get(20)?.size).toBe(1);
    });

    it("maps muted/deafened from ready payload", () => {
      setVoiceStates([VOICE_STATE_2]);
      const user = voiceStore.getState().voiceUsers.get(10)?.get(2);
      expect(user?.muted).toBe(true);
      expect(user?.deafened).toBe(false);
    });

    it("sets default false for speaking, camera, screenshare", () => {
      setVoiceStates([VOICE_STATE_1]);
      const user = voiceStore.getState().voiceUsers.get(10)?.get(1);
      expect(user?.speaking).toBe(false);
      expect(user?.camera).toBe(false);
      expect(user?.screenshare).toBe(false);
    });

    it("replaces existing voice states entirely", () => {
      setVoiceStates([VOICE_STATE_1, VOICE_STATE_2]);
      setVoiceStates([VOICE_STATE_3]);
      const state = voiceStore.getState();
      expect(state.voiceUsers.size).toBe(1);
      expect(state.voiceUsers.has(10)).toBe(false);
      expect(state.voiceUsers.has(20)).toBe(true);
    });
  });

  describe("updateVoiceState", () => {
    it("adds a new user to a channel", () => {
      updateVoiceState(FULL_VOICE_PAYLOAD);
      const user = voiceStore.getState().voiceUsers.get(10)?.get(5);
      expect(user).toEqual({
        userId: 5,
        username: "dave",
        muted: false,
        deafened: false,
        speaking: true,
        camera: false,
        screenshare: false,
      });
    });

    it("updates an existing user in the same channel", () => {
      updateVoiceState(FULL_VOICE_PAYLOAD);
      updateVoiceState({ ...FULL_VOICE_PAYLOAD, muted: true, speaking: false });
      const user = voiceStore.getState().voiceUsers.get(10)?.get(5);
      expect(user?.muted).toBe(true);
      expect(user?.speaking).toBe(false);
    });

    it("does not affect other channels", () => {
      setVoiceStates([VOICE_STATE_3]);
      updateVoiceState(FULL_VOICE_PAYLOAD);
      expect(voiceStore.getState().voiceUsers.get(20)?.size).toBe(1);
    });

    it("produces a new state object", () => {
      const before = voiceStore.getState();
      updateVoiceState(FULL_VOICE_PAYLOAD);
      expect(voiceStore.getState()).not.toBe(before);
    });
  });

  describe("removeVoiceUser", () => {
    it("removes a user from a channel", () => {
      setVoiceStates([VOICE_STATE_1, VOICE_STATE_2]);
      const payload: VoiceLeavePayload = { channel_id: 10, user_id: 1 };
      removeVoiceUser(payload);
      expect(voiceStore.getState().voiceUsers.get(10)?.has(1)).toBe(false);
      expect(voiceStore.getState().voiceUsers.get(10)?.size).toBe(1);
    });

    it("removes channel entry when last user leaves", () => {
      setVoiceStates([VOICE_STATE_3]);
      removeVoiceUser({ channel_id: 20, user_id: 3 });
      expect(voiceStore.getState().voiceUsers.has(20)).toBe(false);
    });

    it("is a no-op for non-existent user", () => {
      setVoiceStates([VOICE_STATE_1]);
      const before = voiceStore.getState();
      removeVoiceUser({ channel_id: 10, user_id: 999 });
      expect(voiceStore.getState()).toBe(before);
    });

    it("is a no-op for non-existent channel", () => {
      const before = voiceStore.getState();
      removeVoiceUser({ channel_id: 999, user_id: 1 });
      expect(voiceStore.getState()).toBe(before);
    });
  });

  describe("joinVoiceChannel / leaveVoiceChannel", () => {
    it("joinVoiceChannel sets currentChannelId", () => {
      joinVoiceChannel(42);
      expect(voiceStore.getState().currentChannelId).toBe(42);
    });

    it("joinVoiceChannel overwrites previous channel", () => {
      joinVoiceChannel(42);
      joinVoiceChannel(99);
      expect(voiceStore.getState().currentChannelId).toBe(99);
    });

    it("leaveVoiceChannel clears currentChannelId", () => {
      joinVoiceChannel(42);
      leaveVoiceChannel();
      expect(voiceStore.getState().currentChannelId).toBeNull();
    });

    it("leaveVoiceChannel is safe when not in a channel", () => {
      leaveVoiceChannel();
      expect(voiceStore.getState().currentChannelId).toBeNull();
    });
  });

  describe("setLocalMuted / setLocalDeafened", () => {
    it("setLocalMuted sets muted to true", () => {
      setLocalMuted(true);
      expect(voiceStore.getState().localMuted).toBe(true);
    });

    it("setLocalMuted sets muted to false", () => {
      setLocalMuted(true);
      setLocalMuted(false);
      expect(voiceStore.getState().localMuted).toBe(false);
    });

    it("setLocalDeafened sets deafened to true", () => {
      setLocalDeafened(true);
      expect(voiceStore.getState().localDeafened).toBe(true);
    });

    it("setLocalDeafened sets deafened to false", () => {
      setLocalDeafened(true);
      setLocalDeafened(false);
      expect(voiceStore.getState().localDeafened).toBe(false);
    });
  });

  describe("getChannelVoiceUsers", () => {
    it("returns all voice users for a channel", () => {
      setVoiceStates([VOICE_STATE_1, VOICE_STATE_2]);
      const users = getChannelVoiceUsers(10);
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.userId).sort()).toEqual([1, 2]);
    });

    it("returns empty array for unknown channel", () => {
      expect(getChannelVoiceUsers(999)).toHaveLength(0);
    });

    it("returns empty array when no voice states exist", () => {
      expect(getChannelVoiceUsers(10)).toHaveLength(0);
    });
  });

  describe("subscribe", () => {
    it("notifies on state changes", () => {
      const listener = vi.fn();
      const unsub = voiceStore.subscribe(listener);
      joinVoiceChannel(42);
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });

    it("does not notify after unsubscribe", () => {
      const listener = vi.fn();
      const unsub = voiceStore.subscribe(listener);
      unsub();
      joinVoiceChannel(42);
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
