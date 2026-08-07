import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  authStore,
  setAuth,
  clearAuth,
  getToken,
  getCurrentUser,
  updateUser,
} from "../../src/stores/auth.store";
import {
  voiceStore,
  resetVoiceStore,
  joinVoiceChannel,
  setVoiceStatus,
} from "../../src/stores/voice.store";
import { leaveVoice } from "@lib/livekitSession";
import { setMessages, isChannelLoaded, getChannelMessages } from "../../src/stores/messages.store";
import { acknowledgeNsfw, isNsfwAcknowledged } from "../../src/lib/nsfw-gate";
import type { UserWithRole, MessageResponse, MessageUser } from "../../src/lib/types";

// Mock the lazily-imported voice SDK module so we can assert clearAuth() only
// pulls it in (loading the ~1.3 MB LiveKit chunk) when a voice session exists.
vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
}));

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

const TEST_USER: UserWithRole = {
  id: 42,
  username: "testuser",
  avatar: "avatar.png",
  role: "member",
};

const TEST_TOKEN = "session-token-abc123";
const TEST_SERVER_NAME = "My OwnCord Server";
const TEST_MOTD = "Welcome to OwnCord!";

function resetStore(): void {
  clearAuth();
}

describe("auth store", () => {
  beforeEach(() => {
    resetStore();
  });

  // 1. Initial state is unauthenticated
  describe("initial state", () => {
    it("has null token", () => {
      expect(authStore.getState().token).toBeNull();
    });

    it("has null user", () => {
      expect(authStore.getState().user).toBeNull();
    });

    it("has null serverName", () => {
      expect(authStore.getState().serverName).toBeNull();
    });

    it("has null motd", () => {
      expect(authStore.getState().motd).toBeNull();
    });

    it("is not authenticated", () => {
      expect(authStore.getState().isAuthenticated).toBe(false);
    });
  });

  // 2. setAuth populates all fields correctly
  describe("setAuth", () => {
    it("sets token", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(authStore.getState().token).toBe(TEST_TOKEN);
    });

    it("sets user", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(authStore.getState().user).toEqual(TEST_USER);
    });

    it("sets serverName", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(authStore.getState().serverName).toBe(TEST_SERVER_NAME);
    });

    it("sets motd", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(authStore.getState().motd).toBe(TEST_MOTD);
    });

    it("sets isAuthenticated to true", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(authStore.getState().isAuthenticated).toBe(true);
    });

    it("returns a new state object on each call", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      const first = authStore.getState();
      setAuth("other-token", TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      const second = authStore.getState();
      expect(first).not.toBe(second);
    });
  });

  // 3. clearAuth resets to initial state
  describe("clearAuth", () => {
    it("resets all fields after being authenticated", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      clearAuth();

      const state = authStore.getState();
      expect(state.token).toBeNull();
      expect(state.user).toBeNull();
      expect(state.serverName).toBeNull();
      expect(state.motd).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });

    it("produces a new state object", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      const before = authStore.getState();
      clearAuth();
      const after = authStore.getState();
      expect(before).not.toBe(after);
    });

    // v076: acknowledgements are per-viewer consent, not per-device. Host
    // scoping cannot cover a second account on the SAME server, so the age
    // gate must be re-armed on logout or the next user silently inherits it.
    it("clears NSFW acknowledgements so the next account re-sees the age gate", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      acknowledgeNsfw(12);
      expect(isNsfwAcknowledged(12)).toBe(true);

      clearAuth();

      expect(isNsfwAcknowledged(12)).toBe(false);
    });

    it("records 'user' as the default logout reason", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      clearAuth();
      expect(authStore.getState().logoutReason).toBe("user");
    });

    it("records an explicit logout reason and resets it on the next setAuth", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      clearAuth("server_shutdown");
      expect(authStore.getState().logoutReason).toBe("server_shutdown");

      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(authStore.getState().logoutReason).toBeUndefined();
    });
  });

  // 4. getToken returns current token
  describe("getToken", () => {
    it("returns null when unauthenticated", () => {
      expect(getToken()).toBeNull();
    });

    it("returns token after setAuth", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(getToken()).toBe(TEST_TOKEN);
    });

    it("returns null after clearAuth", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      clearAuth();
      expect(getToken()).toBeNull();
    });
  });

  // 5. updateUser patches user fields
  describe("updateUser", () => {
    it("updates username on authenticated user", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      updateUser({ username: "newname" });
      expect(authStore.getState().user?.username).toBe("newname");
    });

    it("preserves other user fields when patching", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      updateUser({ username: "newname" });
      const user = authStore.getState().user;
      expect(user?.id).toBe(42);
      expect(user?.avatar).toBe("avatar.png");
      expect(user?.role).toBe("member");
    });

    it("is a no-op when user is null", () => {
      updateUser({ username: "newname" });
      expect(authStore.getState().user).toBeNull();
    });

    it("produces a new state object", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      const before = authStore.getState();
      updateUser({ username: "changed" });
      expect(authStore.getState()).not.toBe(before);
    });

    it("produces a new user object (immutable)", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      const userBefore = authStore.getState().user;
      updateUser({ avatar: "new-avatar.png" });
      const userAfter = authStore.getState().user;
      expect(userBefore).not.toBe(userAfter);
      expect(userAfter?.avatar).toBe("new-avatar.png");
    });

    it("sets totp_enabled to true", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      updateUser({ totp_enabled: true });
      expect(authStore.getState().user?.totp_enabled).toBe(true);
    });

    it("sets totp_enabled to false", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      updateUser({ totp_enabled: true });
      updateUser({ totp_enabled: false });
      expect(authStore.getState().user?.totp_enabled).toBe(false);
    });

    it("initial user has no totp_enabled (undefined)", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(authStore.getState().user?.totp_enabled).toBeUndefined();
    });
  });

  // 6. getCurrentUser returns current user
  describe("getCurrentUser", () => {
    it("returns null when unauthenticated", () => {
      expect(getCurrentUser()).toBeNull();
    });

    it("returns user after setAuth", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(getCurrentUser()).toEqual(TEST_USER);
    });

    it("returns null after clearAuth", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      clearAuth();
      expect(getCurrentUser()).toBeNull();
    });
  });

  // clearAuth voice-session cleanup (regression: don't force-load the LiveKit
  // chunk on every logout/401 for a text-only user).
  describe("clearAuth voice cleanup", () => {
    beforeEach(() => {
      resetVoiceStore();
      vi.mocked(leaveVoice).mockClear();
    });

    it("does NOT load livekitSession when there is no active voice session", async () => {
      // Voice store is idle (currentChannelId null, voiceStatus "idle").
      clearAuth();
      await flushMicrotasks();
      expect(leaveVoice).not.toHaveBeenCalled();
    });

    it("leaves voice when a voice session is active", async () => {
      joinVoiceChannel(7); // currentChannelId=7, voiceStatus="joining"
      setVoiceStatus("connected");
      clearAuth();
      await flushMicrotasks();
      expect(leaveVoice).toHaveBeenCalledWith(false);
    });
  });

  // clearAuth's logoutWasInVoice snapshot — main.ts's isAuthenticated
  // subscriber gates its voice_leave send on this instead of re-reading
  // voiceStore, which clearAuth has already reset by the time any subscriber
  // observes the transition (store notifications are microtask-deferred).
  describe("clearAuth logoutWasInVoice snapshot", () => {
    beforeEach(() => {
      resetVoiceStore();
    });

    it("is false when not in a voice channel at logout", () => {
      clearAuth();
      expect(authStore.getState().logoutWasInVoice).toBe(false);
    });

    it("snapshots true when in a voice channel, surviving clearAuth's own voiceStore reset", () => {
      joinVoiceChannel(7);
      clearAuth();

      expect(authStore.getState().logoutWasInVoice).toBe(true);
      // The snapshot must reflect voice state as it was BEFORE this same
      // call reset it — not the (already-idle) state read afterward.
      expect(voiceStore.getState().currentChannelId).toBeNull();
    });
  });

  // 6. Subscribe receives updates on setAuth/clearAuth
  describe("subscribe", () => {
    it("notifies on setAuth", () => {
      const listener = vi.fn();
      const unsub = authStore.subscribe(listener);

      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      authStore.flush();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          token: TEST_TOKEN,
          user: TEST_USER,
          serverName: TEST_SERVER_NAME,
          motd: TEST_MOTD,
          isAuthenticated: true,
        }),
      );

      unsub();
    });

    it("notifies on clearAuth", () => {
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);

      const listener = vi.fn();
      const unsub = authStore.subscribe(listener);

      clearAuth();
      authStore.flush();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          token: null,
          user: null,
          serverName: null,
          motd: null,
          isAuthenticated: false,
        }),
      );

      unsub();
    });

    it("does not notify after unsubscribe", () => {
      const listener = vi.fn();
      const unsub = authStore.subscribe(listener);
      unsub();

      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      expect(listener).not.toHaveBeenCalled();
    });

    it("notifies multiple subscribers independently", () => {
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      const unsubA = authStore.subscribe(listenerA);
      const unsubB = authStore.subscribe(listenerB);

      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);
      authStore.flush();

      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);

      unsubA();
      unsubB();
    });
  });

  // Regression: clearAuth() must also drop messagesStore, or a channel id
  // that also exists on the next-signed-into server (channel ids are only
  // unique per-server) renders the previous session's cached messages and
  // never refetches, because MessageController.loadMessages short-circuits
  // on isChannelLoaded.
  describe("clearAuth messages cleanup", () => {
    const AUTHOR: MessageUser = { id: 1, username: "alice", avatar: "alice.png" };

    function makeMessageResponse(overrides?: Partial<MessageResponse>): MessageResponse {
      return {
        id: 1,
        channel_id: 1,
        user: AUTHOR,
        content: "pre-logout message",
        reply_to: null,
        attachments: [],
        reactions: [],
        pinned: false,
        edited_at: null,
        deleted: false,
        timestamp: "2026-03-15T10:00:00Z",
        ...overrides,
      };
    }

    it("clears cached messages and the loaded flag on logout", () => {
      setMessages(1, [makeMessageResponse()], false);
      expect(isChannelLoaded(1)).toBe(true);
      expect(getChannelMessages(1)).toHaveLength(1);

      clearAuth();

      expect(isChannelLoaded(1)).toBe(false);
      expect(getChannelMessages(1)).toHaveLength(0);
    });

    it("does not leak the previous session's message content into the next", () => {
      setMessages(1, [makeMessageResponse({ content: "server A secret" })], false);
      clearAuth();
      setAuth(TEST_TOKEN, TEST_USER, TEST_SERVER_NAME, TEST_MOTD);

      // Same numeric channel id, different server: must come back empty and
      // unloaded so the caller refetches instead of rendering stale content.
      expect(isChannelLoaded(1)).toBe(false);
      expect(getChannelMessages(1)).toHaveLength(0);
    });
  });
});
