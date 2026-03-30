import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  authStore,
  setAuth,
  clearAuth,
  getToken,
  getCurrentUser,
  updateUser,
} from "../../src/stores/auth.store";
import type { UserWithRole } from "../../src/lib/types";

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
});
