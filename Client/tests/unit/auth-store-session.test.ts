import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authStore,
  clearAuth,
  onAuthCleared,
  registerVoiceLogoutTeardown,
  setAuth,
} from "@stores/auth.store";
import { channelsStore, setChannels } from "@stores/channels.store";
import type { UserWithRole } from "@lib/types";

const USER: UserWithRole = { id: 1, username: "alice", avatar: null, role: "member" };

afterEach(() => {
  clearAuth();
});

describe("onAuthCleared", () => {
  it("runs every registered listener with the reason", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = onAuthCleared(first);
    const offSecond = onAuthCleared(second);
    clearAuth("server_switch");
    expect(first).toHaveBeenCalledExactlyOnceWith("server_switch");
    expect(second).toHaveBeenCalledExactlyOnceWith("server_switch");
    offFirst();
    offSecond();
  });

  it("stops calling a listener once it is removed", () => {
    const gone = vi.fn();
    const kept = vi.fn();
    const offGone = onAuthCleared(gone);
    const offKept = onAuthCleared(kept);
    offGone();
    clearAuth();
    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
    offKept();
  });

  it("runs before the domain stores are emptied", () => {
    setChannels([{ id: 1, name: "general", type: "text", category: null, position: 0 }]);
    let channelsSeen = -1;
    const off = onAuthCleared(() => {
      channelsSeen = channelsStore.getState().channels.size;
    });
    clearAuth();
    off();
    expect(channelsSeen).toBe(1);
    expect(channelsStore.getState().channels.size).toBe(0);
  });
});

describe("clearAuth", () => {
  it("clears the credentials and records why", () => {
    setAuth("tok", USER, "Srv", "hello");
    clearAuth("protocol_epoch");
    expect(authStore.getState()).toMatchObject({
      token: null,
      user: null,
      isAuthenticated: false,
      logoutReason: "protocol_epoch",
      logoutWasInVoice: false,
    });
  });

  it("notes that the user was in a voice channel when the voice store says so", () => {
    registerVoiceLogoutTeardown({
      snapshot: () => ({ currentChannelId: 7, voiceStatus: "idle" }),
    });
    setAuth("tok", USER, "Srv", "hello");
    clearAuth();
    expect(authStore.getState().logoutWasInVoice).toBe(true);
  });

  it("notes that the user was not in voice when no channel is joined", () => {
    registerVoiceLogoutTeardown({
      snapshot: () => ({ currentChannelId: null, voiceStatus: "idle" }),
    });
    setAuth("tok", USER, "Srv", "hello");
    clearAuth();
    expect(authStore.getState().logoutWasInVoice).toBe(false);
  });
});

describe("setAuth", () => {
  it("does not invent a totp flag the profile fetch never set", () => {
    setAuth("tok", USER, "Srv", "hello");
    setAuth("tok2", { ...USER }, "Srv", "hello");
    expect(authStore.getState().user).not.toBeNull();
    expect("totp_enabled" in (authStore.getState().user ?? {})).toBe(false);
  });

  it("keeps the totp flag the profile fetch set for the same account", () => {
    setAuth("tok", { ...USER, totp_enabled: true }, "Srv", "hello");
    setAuth("tok2", USER, "Srv", "hello");
    expect(authStore.getState().user?.totp_enabled).toBe(true);
  });

  it("drops the totp flag when a different account signs in", () => {
    setAuth("tok", { ...USER, totp_enabled: true }, "Srv", "hello");
    setAuth("tok2", { ...USER, id: 2 }, "Srv", "hello");
    expect("totp_enabled" in (authStore.getState().user ?? {})).toBe(false);
  });
});
