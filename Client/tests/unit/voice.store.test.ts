import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  voiceStore,
  resetVoiceStore,
  setVoiceStates,
  updateVoiceState,
  updateVoiceUserProfile,
  removeVoiceUser,
  joinVoiceChannel,
  leaveVoiceChannel,
  setLocalMuted,
  setLocalDeafened,
  setPttGated,
  setLocalCamera,
  setLocalScreenshare,
  setListenOnly,
  setLocalSpeaking,
  setSpeakers,
  setVoiceConfig,
  getChannelVoiceUsers,
  setVoiceStatus,
  setEncryptionDegraded,
  setPeerVerification,
  clearPeerVerification,
  clearPeerVerifications,
  getPeerVerification,
  setLocalSessionFingerprint,
  setPttPollingLive,
  isPttPollingLive,
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
    voiceStatus: "idle",
    peerVerifications: new Map(),
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

    it("maps camera/screenshare from the ready payload when present", () => {
      // The server marshals the voice_states rows wholesale — a full-ready
      // resync mid-call must not blank a peer's active camera/screenshare.
      setVoiceStates([{ ...VOICE_STATE_1, camera: true, screenshare: true }]);
      const user = voiceStore.getState().voiceUsers.get(10)?.get(1);
      expect(user?.camera).toBe(true);
      expect(user?.screenshare).toBe(true);
    });

    it("defaults username to empty string when the user isn't in membersStore", () => {
      // VOICE_STATE_1's user_id (1) has no matching membersStore entry in
      // this test file, so the `member?.username ?? ""` fallback applies.
      setVoiceStates([VOICE_STATE_1]);
      const user = voiceStore.getState().voiceUsers.get(10)?.get(1);
      expect(user?.username).toBe("");
    });

    it("defaults serverMuted/serverDeafened to false when the ready row omits them", () => {
      setVoiceStates([VOICE_STATE_1]); // no server_muted/server_deafened on this fixture
      const user = voiceStore.getState().voiceUsers.get(10)?.get(1);
      expect(user?.serverMuted).toBe(false);
      expect(user?.serverDeafened).toBe(false);
    });

    it("carries serverMuted/serverDeafened through from the ready row when true", () => {
      setVoiceStates([{ ...VOICE_STATE_1, server_muted: true, server_deafened: true }]);
      const user = voiceStore.getState().voiceUsers.get(10)?.get(1);
      expect(user?.serverMuted).toBe(true);
      expect(user?.serverDeafened).toBe(true);
    });

    it("does not auto-join when there is no signed-in user, even if a row's user_id is 0", () => {
      // authStore has no user in this test, so currentUserId defaults to 0
      // (authStore.getState().user?.id ?? 0). The self-state lookup loop
      // must be gated on "there IS a signed-in user", not run unconditionally
      // and coincidentally match a user_id: 0 row.
      joinVoiceChannel(42);
      setVoiceStates([{ ...VOICE_STATE_1, user_id: 0 }]);
      expect(voiceStore.getState().currentChannelId).toBe(42);
    });

    it("replaces existing voice states entirely", () => {
      setVoiceStates([VOICE_STATE_1, VOICE_STATE_2]);
      setVoiceStates([VOICE_STATE_3]);
      const state = voiceStore.getState();
      expect(state.voiceUsers.size).toBe(1);
      expect(state.voiceUsers.has(10)).toBe(false);
      expect(state.voiceUsers.has(20)).toBe(true);
    });

    describe("local moderator-flag derivation (v049)", () => {
      afterEach(() => {
        authStore.setState(() => ({
          token: null,
          user: null,
          serverName: null,
          motd: "",
          isAuthenticated: false,
        }));
      });

      it("derives localServerMuted/localServerDeafened from the signed-in user's row", () => {
        authStore.setState((prev) => ({
          ...prev,
          user: { id: 1, username: "me", avatar: null, role: "member" },
        }));
        // A full-ready reconnect (mustFullResync / replay miss) that
        // preserves a live voice session reports the moderator flags on the
        // signed-in user's own row.
        setVoiceStates([
          { ...VOICE_STATE_1, server_muted: true, server_deafened: true },
          VOICE_STATE_2,
        ]);
        const state = voiceStore.getState();
        expect(state.localServerMuted).toBe(true);
        expect(state.localServerDeafened).toBe(true);
      });

      it("resets the local moderator flags to false when the signed-in user's row omits them", () => {
        authStore.setState((prev) => ({
          ...prev,
          user: { id: 1, username: "me", avatar: null, role: "member" },
        }));
        // Simulate a stale localServerMuted from before the resync.
        voiceStore.setState((prev) => ({ ...prev, localServerMuted: true }));
        setVoiceStates([VOICE_STATE_1]); // no server_muted/server_deafened on this row
        const state = voiceStore.getState();
        expect(state.localServerMuted).toBe(false);
        expect(state.localServerDeafened).toBe(false);
      });

      it("leaves the local moderator flags false when the signed-in user is absent from the payload", () => {
        authStore.setState((prev) => ({
          ...prev,
          user: { id: 999, username: "me", avatar: null, role: "member" },
        }));
        setVoiceStates([{ ...VOICE_STATE_1, server_muted: true }]);
        const state = voiceStore.getState();
        expect(state.localServerMuted).toBe(false);
        expect(state.localServerDeafened).toBe(false);
      });
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
        // Absent from the payload means not moderator-imposed.
        serverMuted: false,
        serverDeafened: false,
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

    it("mirrors the moderator flags into the local ones for the signed-in user", () => {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "dave", avatar: null, role: "member" },
      }));
      updateVoiceState({
        ...FULL_VOICE_PAYLOAD,
        muted: true,
        deafened: true,
        server_muted: true,
        server_deafened: true,
      });
      const state = voiceStore.getState();
      expect(state.localServerMuted).toBe(true);
      expect(state.localServerDeafened).toBe(true);
      expect(state.voiceUsers.get(10)?.get(5)?.serverMuted).toBe(true);
    });

    it("leaves the local flags alone for another user's state", () => {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 999, username: "me", avatar: null, role: "member" },
      }));
      updateVoiceState({ ...FULL_VOICE_PAYLOAD, muted: true, server_muted: true });
      expect(voiceStore.getState().localServerMuted).not.toBe(true);
    });
  });

  describe("updateVoiceUserProfile", () => {
    it("patches the username in every channel the user occupies", () => {
      setVoiceStates([VOICE_STATE_1]); // user 1 in channel 10
      updateVoiceState({ ...FULL_VOICE_PAYLOAD, user_id: 1, channel_id: 20 }); // user 1 also in channel 20

      updateVoiceUserProfile(1, { username: "renamed" });

      expect(voiceStore.getState().voiceUsers.get(10)?.get(1)?.username).toBe("renamed");
      expect(voiceStore.getState().voiceUsers.get(20)?.get(1)?.username).toBe("renamed");
    });

    it("is a no-op (same state reference) when the user is in no voice channel", () => {
      setVoiceStates([VOICE_STATE_1]);
      const before = voiceStore.getState();
      updateVoiceUserProfile(999, { username: "nobody" });
      expect(voiceStore.getState()).toBe(before);
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

    it("leaveVoiceChannel clears the moderator-imposed flags with the session", () => {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "dave", avatar: null, role: "member" },
      }));
      joinVoiceChannel(10);
      updateVoiceState({ ...FULL_VOICE_PAYLOAD, muted: true, server_muted: true });
      expect(voiceStore.getState().localServerMuted).toBe(true);

      leaveVoiceChannel();
      expect(voiceStore.getState().localServerMuted).toBe(false);
      expect(voiceStore.getState().localServerDeafened).toBe(false);

      // This describe block has no shared afterEach — without this reset the
      // signed-in user leaks into every later test here (they'd silently
      // stop exercising the "no signed-in user" / currentUserId === 0 path).
      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));
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

    it("leaveVoiceChannel clears encryptionDegraded with the session", () => {
      joinVoiceChannel(10);
      voiceStore.setState((prev) => ({ ...prev, encryptionDegraded: true }));
      leaveVoiceChannel();
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("leaveVoiceChannel with no signed-in user does not touch voiceUsers, even if a row's user_id is 0", () => {
      // authStore has no user, so currentUserId defaults to 0. The
      // `currentUserId === 0` guard must take the early-return branch
      // (which never touches voiceUsers) rather than falling through and
      // deleting a "user_id: 0" row it has no business owning.
      setVoiceStates([{ ...VOICE_STATE_1, user_id: 0 }]);
      joinVoiceChannel(10);
      leaveVoiceChannel();
      expect(voiceStore.getState().voiceUsers.get(10)?.has(0)).toBe(true);
    });

    it("leaveVoiceChannel preserves the voiceUsers map reference when the current user isn't in it", () => {
      authStore.setState((prev) => ({
        ...prev,
        user: { id: 5, username: "dave", avatar: null, role: "member" },
      }));
      // Join channel 10 locally, but voiceUsers was never populated for
      // user 5 (setVoiceStates/updateVoiceState were never called for it) —
      // the second guard (existingChannel missing / doesn't have the user)
      // must early-return without allocating a new voiceUsers Map.
      joinVoiceChannel(10);
      const usersBefore = voiceStore.getState().voiceUsers;

      leaveVoiceChannel();

      expect(voiceStore.getState().voiceUsers).toBe(usersBefore);

      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));
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

  describe("setPttGated", () => {
    it("sets pttGated to true", () => {
      setPttGated(true);
      expect(voiceStore.getState().pttGated).toBe(true);
    });

    it("sets pttGated to false", () => {
      setPttGated(true);
      setPttGated(false);
      expect(voiceStore.getState().pttGated).toBe(false);
    });

    it("does not touch localMuted — PTT must never write the explicit-mute flag (v006)", () => {
      setLocalMuted(true);
      setPttGated(false); // PTT key pressed
      expect(voiceStore.getState().localMuted).toBe(true);
      expect(voiceStore.getState().pttGated).toBe(false);
    });

    it("is a no-op (same state reference) when the value hasn't changed", () => {
      setPttGated(true);
      const before = voiceStore.getState();
      setPttGated(true);
      expect(voiceStore.getState()).toBe(before);
    });
  });

  describe("setEncryptionDegraded", () => {
    it("sets encryptionDegraded to true", () => {
      setEncryptionDegraded(true);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("sets encryptionDegraded back to false", () => {
      setEncryptionDegraded(true);
      setEncryptionDegraded(false);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("is a no-op (same state reference) when the value hasn't changed", () => {
      setEncryptionDegraded(true);
      const before = voiceStore.getState();
      setEncryptionDegraded(true);
      expect(voiceStore.getState()).toBe(before);
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

    it("is a no-op with no signed-in user, even if a row's user_id is 0", () => {
      // authStore has no user, so currentUserId defaults to 0. Without the
      // `currentUserId === 0` early return, the function would happily
      // treat a "user_id: 0" roster row as "us" and flip its speaking flag.
      setVoiceStates([{ ...VOICE_STATE_1, user_id: 0 }]);
      joinVoiceChannel(10);
      setLocalSpeaking(true);
      expect(voiceStore.getState().voiceUsers.get(10)?.get(0)?.speaking).toBe(false);
    });

    it("is a no-op (same state reference) when speaking already matches the requested value", () => {
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
      const before = voiceStore.getState();

      setLocalSpeaking(true); // already true — must not allocate a new state

      expect(voiceStore.getState()).toBe(before);

      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));
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

    it("updates remote users' speaking state from LiveKit", () => {
      // LiveKit says user 2 is speaking
      setSpeakers({ channel_id: 10, speakers: [2], threshold_mode: "forwarding" });
      expect(voiceStore.getState().voiceUsers.get(10)?.get(2)?.speaking).toBe(true);

      // LiveKit says nobody is speaking — remote user updated, local unchanged
      setSpeakers({ channel_id: 10, speakers: [], threshold_mode: "forwarding" });
      expect(voiceStore.getState().voiceUsers.get(10)?.get(2)?.speaking).toBe(false);
    });

    it("preserves the VoiceUser object reference for a user whose speaking state doesn't change", () => {
      // Both users default to speaking: false (from setVoiceStates). An
      // empty speakers list changes nothing, so the unchanged branch must
      // reuse the existing VoiceUser object rather than cloning it.
      const before = voiceStore.getState().voiceUsers.get(10)?.get(1);
      setSpeakers({ channel_id: 10, speakers: [], threshold_mode: "forwarding" });
      expect(voiceStore.getState().voiceUsers.get(10)?.get(1)).toBe(before);
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
      // Date.now() spied with distinct values per call — two real calls in
      // the same millisecond would otherwise make this assertion pass by
      // coincidence even if the same-channel guard were gone entirely.
      const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(2000);
      try {
        joinVoiceChannel(42);
        const firstJoinedAt = voiceStore.getState().joinedAt;
        expect(firstJoinedAt).toBe(1000);

        // Re-join same channel — guard must return `prev` before Date.now()
        // is called again, so joinedAt stays 1000, not the mocked 2000.
        joinVoiceChannel(42);
        expect(voiceStore.getState().joinedAt).toBe(firstJoinedAt);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it("resets joinedAt when joining a different channel", () => {
      joinVoiceChannel(42);

      joinVoiceChannel(99);
      expect(voiceStore.getState().joinedAt).not.toBeNull();
      expect(voiceStore.getState().currentChannelId).toBe(99);
    });

    it("clears encryptionDegraded on a fresh join — a new session doesn't inherit the previous one's degraded flag", () => {
      voiceStore.setState((prev) => ({ ...prev, encryptionDegraded: true }));
      joinVoiceChannel(42);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });
  });

  describe("voiceStatus", () => {
    it("seeds 'joining' optimistically on a fresh join", () => {
      expect(voiceStore.getState().voiceStatus).toBe("idle");
      joinVoiceChannel(42);
      expect(voiceStore.getState().voiceStatus).toBe("joining");
    });

    it("resets to 'idle' on leaveVoiceChannel", () => {
      joinVoiceChannel(42);
      setVoiceStatus("connected");
      leaveVoiceChannel();
      expect(voiceStore.getState().voiceStatus).toBe("idle");
    });

    it("setVoiceStatus writes the given status", () => {
      setVoiceStatus("securing");
      expect(voiceStore.getState().voiceStatus).toBe("securing");
      setVoiceStatus("reconnecting");
      expect(voiceStore.getState().voiceStatus).toBe("reconnecting");
    });

    it("setVoiceStatus is a no-op (same state reference) when the status hasn't changed", () => {
      setVoiceStatus("securing");
      const before = voiceStore.getState();
      setVoiceStatus("securing");
      expect(voiceStore.getState()).toBe(before);
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

    it("resets localServerMuted/localServerDeafened/pttGated/encryptionDegraded to false", () => {
      voiceStore.setState((prev) => ({
        ...prev,
        localServerMuted: true,
        localServerDeafened: true,
        pttGated: true,
        encryptionDegraded: true,
      }));

      resetVoiceStore();

      const state = voiceStore.getState();
      expect(state.localServerMuted).toBe(false);
      expect(state.localServerDeafened).toBe(false);
      expect(state.pttGated).toBe(false);
      expect(state.encryptionDegraded).toBe(false);
    });
  });

  describe("setPttPollingLive / isPttPollingLive", () => {
    afterEach(() => {
      // Module-level flag, not covered by resetStore() — restore the
      // default so later tests in this file see a clean slate.
      setPttPollingLive(false);
    });

    it("defaults to false", () => {
      expect(isPttPollingLive()).toBe(false);
    });

    it("setPttPollingLive(true) flips isPttPollingLive() to true", () => {
      setPttPollingLive(true);
      expect(isPttPollingLive()).toBe(true);
    });

    it("resetVoiceStore() does not clear it — process-wide platform capability, not per-session voice state", () => {
      setPttPollingLive(true);
      resetVoiceStore();
      expect(isPttPollingLive()).toBe(true);
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

  describe("setPeerVerification / clearPeerVerification / clearPeerVerifications / getPeerVerification (F3 TOFU)", () => {
    it("getPeerVerification returns null for an unknown peer", () => {
      expect(getPeerVerification(1)).toBeNull();
    });

    it("setPeerVerification records a peer's verification, readable via getPeerVerification", () => {
      setPeerVerification({
        userId: 1,
        status: "verified",
        safetyNumber: "abcd-1234",
        sessionFingerprint: "fp-1",
      });
      expect(getPeerVerification(1)).toEqual({
        userId: 1,
        status: "verified",
        safetyNumber: "abcd-1234",
        sessionFingerprint: "fp-1",
      });
    });

    it("setPeerVerification overwrites a previous verification for the same peer", () => {
      setPeerVerification({
        userId: 1,
        status: "unverified",
        safetyNumber: null,
        sessionFingerprint: "fp-1",
      });
      setPeerVerification({
        userId: 1,
        status: "mismatch",
        safetyNumber: null,
        sessionFingerprint: "fp-2",
      });
      expect(getPeerVerification(1)?.status).toBe("mismatch");
      expect(getPeerVerification(1)?.sessionFingerprint).toBe("fp-2");
    });

    it("clearPeerVerification removes a single peer's verification", () => {
      setPeerVerification({
        userId: 1,
        status: "verified",
        safetyNumber: "x",
        sessionFingerprint: "y",
      });
      setPeerVerification({
        userId: 2,
        status: "verified",
        safetyNumber: "x",
        sessionFingerprint: "y",
      });

      clearPeerVerification(1);

      expect(getPeerVerification(1)).toBeNull();
      expect(getPeerVerification(2)).not.toBeNull();
    });

    it("clearPeerVerification is a no-op (same state reference) for a peer with no verification", () => {
      setPeerVerification({
        userId: 2,
        status: "verified",
        safetyNumber: "x",
        sessionFingerprint: "y",
      });
      const before = voiceStore.getState();
      clearPeerVerification(999);
      expect(voiceStore.getState()).toBe(before);
    });

    it("clearPeerVerifications drops every peer's verification", () => {
      setPeerVerification({
        userId: 1,
        status: "verified",
        safetyNumber: "x",
        sessionFingerprint: "y",
      });
      setPeerVerification({
        userId: 2,
        status: "unverified",
        safetyNumber: null,
        sessionFingerprint: "z",
      });

      clearPeerVerifications();

      expect(voiceStore.getState().peerVerifications?.size).toBe(0);
    });

    it("clearPeerVerifications is a no-op (same state reference) when already empty", () => {
      const before = voiceStore.getState();
      clearPeerVerifications();
      expect(voiceStore.getState()).toBe(before);
    });
  });

  describe("setLocalSessionFingerprint", () => {
    it("publishes the local session fingerprint", () => {
      setLocalSessionFingerprint("fp-local");
      expect(voiceStore.getState().localSessionFingerprint).toBe("fp-local");
    });

    it("clears the fingerprint with null", () => {
      setLocalSessionFingerprint("fp-local");
      setLocalSessionFingerprint(null);
      expect(voiceStore.getState().localSessionFingerprint).toBeNull();
    });

    it("is a no-op (same state reference) when the value hasn't changed", () => {
      setLocalSessionFingerprint("fp-local");
      const before = voiceStore.getState();
      setLocalSessionFingerprint("fp-local");
      expect(voiceStore.getState()).toBe(before);
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

  // MUST stay the last describe block in this file: vi.resetModules() below
  // repoints subsequent `await import(...)` calls at fresh module instances
  // for the rest of the file's execution, which would desync any later
  // test's dynamically-imported module from this file's statically-imported
  // `voiceStore`/`authStore` (as it did for the "clearAuth voice cleanup"
  // test above, which relies on that static `voiceStore` observing the
  // effect of a dynamically-imported `clearAuth()`).
  describe("module INITIAL_STATE (fresh import, untouched by any reset)", () => {
    it("defaults every flag to false — the describe blocks above only ever observe state after the outer beforeEach's resetStore() has already overwritten it, and that local helper doesn't even set localServerMuted/localServerDeafened/pttGated/encryptionDegraded (they'd read `undefined` there, not the real default)", async () => {
      vi.resetModules();
      const fresh = await import("../../src/stores/voice.store");
      const state = fresh.voiceStore.getState();
      expect(state.localMuted).toBe(false);
      expect(state.localDeafened).toBe(false);
      expect(state.localServerMuted).toBe(false);
      expect(state.localServerDeafened).toBe(false);
      expect(state.pttGated).toBe(false);
      expect(state.localCamera).toBe(false);
      expect(state.localScreenshare).toBe(false);
      expect(state.listenOnly).toBe(false);
      expect(state.encryptionDegraded).toBe(false);
      expect(fresh.isPttPollingLive()).toBe(false);
    });
  });
});
