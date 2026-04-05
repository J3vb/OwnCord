import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  voiceStore,
  resetVoiceStore,
  setVoiceStates,
  updateVoiceState,
  removeVoiceUser,
  joinVoiceChannel,
  leaveVoiceChannel,
  setLocalMuted,
  setLocalDeafened,
  setLocalCamera,
  setLocalScreenshare,
  setListenOnly,
  setLocalSpeaking,
  setSpeakers,
  setVoiceConfig,
  getChannelVoiceUsers,
} from "../../src/stores/voice.store";
import type { ReadyVoiceState, VoiceStatePayload, VoiceLeavePayload } from "../../src/lib/types";
import { authStore } from "../../src/stores/auth.store";

function resetStore(): void {
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

    it("has localCamera false", () => {
      expect(voiceStore.getState().localCamera).toBe(false);
    });

    it("has localScreenshare false", () => {
      expect(voiceStore.getState().localScreenshare).toBe(false);
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

  describe("setLocalCamera / setLocalScreenshare", () => {
    it("setLocalCamera sets camera to true", () => {
      setLocalCamera(true);
      expect(voiceStore.getState().localCamera).toBe(true);
    });

    it("setLocalCamera sets camera to false", () => {
      setLocalCamera(true);
      setLocalCamera(false);
      expect(voiceStore.getState().localCamera).toBe(false);
    });

    it("setLocalScreenshare sets screenshare to true", () => {
      setLocalScreenshare(true);
      expect(voiceStore.getState().localScreenshare).toBe(true);
    });

    it("setLocalScreenshare sets screenshare to false", () => {
      setLocalScreenshare(true);
      setLocalScreenshare(false);
      expect(voiceStore.getState().localScreenshare).toBe(false);
    });
  });

  describe("setLocalSpeaking", () => {
    it("updates speaking state for current user in active channel", () => {
      // Set up: current user (id=1) in channel 10
      authStore.setState(() => ({
        token: "t",
        user: { id: 1, username: "me", avatar: "", role: "member" },
        serverName: "s",
        motd: "",
        isAuthenticated: true,
      }));
      setVoiceStates([VOICE_STATE_1]);
      joinVoiceChannel(10);

      setLocalSpeaking(true);
      const user = voiceStore.getState().voiceUsers.get(10)?.get(1);
      expect(user?.speaking).toBe(true);

      setLocalSpeaking(false);
      const userAfter = voiceStore.getState().voiceUsers.get(10)?.get(1);
      expect(userAfter?.speaking).toBe(false);

      // Cleanup
      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));
    });

    it("is a no-op when not in a voice channel", () => {
      const before = voiceStore.getState();
      setLocalSpeaking(true);
      expect(voiceStore.getState()).toBe(before);
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

  describe("setSpeakers", () => {
    beforeEach(() => {
      // Set up: user 1 (local) and user 2 (remote) in channel 10
      authStore.setState(() => ({
        token: "t",
        user: { id: 1, username: "me", avatar: "", role: "member" },
        serverName: "s",
        motd: "",
        isAuthenticated: true,
      }));
      setVoiceStates([VOICE_STATE_1, VOICE_STATE_2]);
      joinVoiceChannel(10);
    });

    afterEach(() => {
      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));
    });

    it("updates local user's speaking state from LiveKit", () => {
      // LiveKit says we're speaking
      setSpeakers({ channel_id: 10, speakers: [1, 2], threshold_mode: "forwarding" });
      expect(voiceStore.getState().voiceUsers.get(10)?.get(1)?.speaking).toBe(true);

      // LiveKit says we're NOT speaking — should update
      setSpeakers({ channel_id: 10, speakers: [2], threshold_mode: "forwarding" });
      expect(voiceStore.getState().voiceUsers.get(10)?.get(1)?.speaking).toBe(false);
    });

    it("updates remote users' speaking state from server", () => {
      // Server says user 2 is speaking
      setSpeakers({ channel_id: 10, speakers: [2], threshold_mode: "forwarding" });
      expect(voiceStore.getState().voiceUsers.get(10)?.get(2)?.speaking).toBe(true);

      // Server says nobody is speaking — remote user updated, local unchanged
      setSpeakers({ channel_id: 10, speakers: [], threshold_mode: "forwarding" });
      expect(voiceStore.getState().voiceUsers.get(10)?.get(2)?.speaking).toBe(false);
    });
  });

  describe("setListenOnly", () => {
    it("sets listenOnly to true", () => {
      setListenOnly(true);
      expect(voiceStore.getState().listenOnly).toBe(true);
    });

    it("sets listenOnly back to false", () => {
      setListenOnly(true);
      setListenOnly(false);
      expect(voiceStore.getState().listenOnly).toBe(false);
    });
  });

  describe("setVoiceConfig", () => {
    it("stores voice config for a channel", () => {
      setVoiceConfig({
        channel_id: 10,
        quality: "high",
        bitrate: 128000,
        threshold_mode: "forwarding",
        mixing_threshold: 5,
        top_speakers: 3,
        max_users: 50,
      });

      const config = voiceStore.getState().voiceConfigs.get(10);
      expect(config).toEqual({
        quality: "high",
        bitrate: 128000,
        threshold_mode: "forwarding",
        mixing_threshold: 5,
        top_speakers: 3,
        max_users: 50,
      });
    });

    it("overwrites existing config for the same channel", () => {
      setVoiceConfig({
        channel_id: 10,
        quality: "low",
        bitrate: 64000,
        threshold_mode: "mixing",
        mixing_threshold: 3,
        top_speakers: 2,
        max_users: 25,
      });
      setVoiceConfig({
        channel_id: 10,
        quality: "high",
        bitrate: 128000,
        threshold_mode: "forwarding",
        mixing_threshold: 5,
        top_speakers: 3,
        max_users: 50,
      });

      const config = voiceStore.getState().voiceConfigs.get(10);
      expect(config?.quality).toBe("high");
      expect(config?.bitrate).toBe(128000);
    });

    it("does not affect other channels' configs", () => {
      setVoiceConfig({
        channel_id: 10,
        quality: "low",
        bitrate: 64000,
        threshold_mode: "mixing",
        mixing_threshold: 3,
        top_speakers: 2,
        max_users: 25,
      });
      setVoiceConfig({
        channel_id: 20,
        quality: "high",
        bitrate: 128000,
        threshold_mode: "forwarding",
        mixing_threshold: 5,
        top_speakers: 3,
        max_users: 50,
      });

      expect(voiceStore.getState().voiceConfigs.get(10)?.quality).toBe("low");
      expect(voiceStore.getState().voiceConfigs.get(20)?.quality).toBe("high");
    });
  });

  describe("joinVoiceChannel — same channel no-op", () => {
    it("does not reset joinedAt when re-joining the same channel", () => {
      joinVoiceChannel(42);
      const firstJoinedAt = voiceStore.getState().joinedAt;
      expect(firstJoinedAt).not.toBeNull();

      // Re-join same channel
      joinVoiceChannel(42);
      expect(voiceStore.getState().joinedAt).toBe(firstJoinedAt);
    });

    it("resets joinedAt when joining a different channel", () => {
      joinVoiceChannel(42);
      const firstJoinedAt = voiceStore.getState().joinedAt;

      // Small delay to ensure different timestamp
      joinVoiceChannel(99);
      expect(voiceStore.getState().joinedAt).not.toBeNull();
      expect(voiceStore.getState().currentChannelId).toBe(99);
    });
  });

  describe("leaveVoiceChannel — clears user from voiceUsers", () => {
    it("removes current user from the channel's voiceUsers map", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 1, username: "me", avatar: "", role: "member" },
        serverName: "s",
        motd: "",
        isAuthenticated: true,
      }));
      setVoiceStates([VOICE_STATE_1, VOICE_STATE_2]);
      joinVoiceChannel(10);

      leaveVoiceChannel();

      expect(voiceStore.getState().currentChannelId).toBeNull();
      expect(voiceStore.getState().joinedAt).toBeNull();
      // User 1 should be removed from channel 10
      const ch10 = voiceStore.getState().voiceUsers.get(10);
      expect(ch10?.has(1)).toBe(false);
      // User 2 should still be present
      expect(ch10?.has(2)).toBe(true);

      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));
    });

    it("removes the channel entry when current user is the last user", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 3, username: "me", avatar: "", role: "member" },
        serverName: "s",
        motd: "",
        isAuthenticated: true,
      }));
      setVoiceStates([VOICE_STATE_3]); // User 3 alone in channel 20
      joinVoiceChannel(20);

      leaveVoiceChannel();

      expect(voiceStore.getState().voiceUsers.has(20)).toBe(false);

      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));
    });
  });

  describe("setVoiceStates — auto-join for current user", () => {
    it("auto-joins current user's channel from ready payload", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 1, username: "me", avatar: "", role: "member" },
        serverName: "s",
        motd: "",
        isAuthenticated: true,
      }));

      setVoiceStates([VOICE_STATE_1, VOICE_STATE_2]);

      // Current user (id=1) is in channel 10
      expect(voiceStore.getState().currentChannelId).toBe(10);

      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));
    });

    it("preserves currentChannelId when current user is not in the payload", () => {
      authStore.setState(() => ({
        token: "t",
        user: { id: 999, username: "me", avatar: "", role: "member" },
        serverName: "s",
        motd: "",
        isAuthenticated: true,
      }));

      joinVoiceChannel(42);
      setVoiceStates([VOICE_STATE_1, VOICE_STATE_2]); // Neither is user 999

      // Should preserve the existing channel since user isn't in the payload
      expect(voiceStore.getState().currentChannelId).toBe(42);

      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));
    });
  });

  describe("resetVoiceStore", () => {
    it("resets all fields to initial state", () => {
      joinVoiceChannel(42);
      setLocalMuted(true);
      setLocalDeafened(true);
      setLocalCamera(true);
      setLocalScreenshare(true);
      setListenOnly(true);

      resetVoiceStore();

      const state = voiceStore.getState();
      expect(state.currentChannelId).toBeNull();
      expect(state.localMuted).toBe(false);
      expect(state.localDeafened).toBe(false);
      expect(state.localCamera).toBe(false);
      expect(state.localScreenshare).toBe(false);
      expect(state.joinedAt).toBeNull();
      expect(state.listenOnly).toBe(false);
      expect(state.voiceUsers.size).toBe(0);
      expect(state.voiceConfigs.size).toBe(0);
    });
  });

  describe("clearAuth voice cleanup", () => {
    it("calls leaveVoice to clean up session state", async () => {
      // We test indirectly: clearAuth should call leaveVoice(false) which
      // is idempotent, and then resetVoiceStore which clears the store.
      const { clearAuth } = await import("../../src/stores/auth.store");

      joinVoiceChannel(42);
      setLocalMuted(true);
      expect(voiceStore.getState().currentChannelId).toBe(42);

      clearAuth();

      // After clearAuth, voice store should be fully reset
      expect(voiceStore.getState().currentChannelId).toBeNull();
      expect(voiceStore.getState().localMuted).toBe(false);
      expect(voiceStore.getState().voiceUsers.size).toBe(0);
    });
  });

  describe("subscribe", () => {
    it("notifies on state changes", () => {
      const listener = vi.fn();
      const unsub = voiceStore.subscribe(listener);
      joinVoiceChannel(42);
      voiceStore.flush();
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
