import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bumpLocalCameraRev,
  bumpLocalShareRev,
  clearChannelVoiceUsers,
  clearPeerWatching,
  getVoiceRosterRevision,
  joinVoiceChannel,
  removeVoiceUser,
  resetVoiceStore,
  restateSelfVoiceState,
  restoreSavedSelfVoiceState,
  saveSelfVoiceState,
  setLocalDeafened,
  setLocalGateSpeaking,
  setLocalMuted,
  setModeratorDeafened,
  setMutedBeforeDeafen,
  setPeerVideoDecode,
  setPeerWatching,
  setPttGated,
  setShareDenied,
  setVoiceStates,
  updateVoiceState,
  voiceStore,
} from "../../src/stores/voice.store";
import type { VoiceStatePayload } from "../../src/lib/types";
import { authStore } from "../../src/stores/auth.store";
import { isVoiceDeafened, setVoiceInSession } from "../../src/lib/voice/voiceDeafened";
import { loadPref, savePref } from "../../src/lib/prefs/preferences";

const ME = 1;

function payload(userId: number, over: Partial<VoiceStatePayload> = {}): VoiceStatePayload {
  return {
    channel_id: 10,
    user_id: userId,
    username: `u${userId}`,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
    ...over,
  };
}

function signIn(id: number | null): void {
  authStore.setState((prev) => ({
    ...prev,
    user: id === null ? null : { id, username: "me", avatar: null, role: "member" },
  }));
}

function inChannel(...userIds: number[]): void {
  for (const id of userIds) updateVoiceState(payload(id));
  joinVoiceChannel(10);
  voiceStore.flush();
}

beforeEach(() => {
  localStorage.clear();
  resetVoiceStore();
  voiceStore.flush();
  signIn(ME);
});

afterEach(() => {
  resetVoiceStore();
  voiceStore.flush();
  signIn(null);
});

describe("roster revision", () => {
  it("counts each live update, leave and cleared roster once, and a wholesale replace not at all", () => {
    const start = getVoiceRosterRevision();
    updateVoiceState(payload(2));
    expect(getVoiceRosterRevision()).toBe(start + 1);
    removeVoiceUser({ channel_id: 10, user_id: 2 });
    expect(getVoiceRosterRevision()).toBe(start + 2);

    setVoiceStates([{ channel_id: 10, user_id: 3, muted: false, deafened: false }]);
    expect(getVoiceRosterRevision()).toBe(start + 2);

    clearChannelVoiceUsers(10);
    expect(getVoiceRosterRevision()).toBe(start + 3);
    clearChannelVoiceUsers(10);
    expect(getVoiceRosterRevision()).toBe(start + 3);
  });

  it("does not count a cleared roster while the member is in that channel", () => {
    inChannel(2);
    const before = getVoiceRosterRevision();
    clearChannelVoiceUsers(10);
    expect(getVoiceRosterRevision()).toBe(before);
  });
});

describe("local moderator flags", () => {
  it("takes them from the member's own row only", () => {
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));
    updateVoiceState(payload(2, { server_muted: true, server_deafened: true }));
    expect(voiceStore.getState().localServerMuted).toBe(false);
    expect(voiceStore.getState().localServerDeafened).toBe(false);

    updateVoiceState(payload(ME, { server_muted: true, server_deafened: true }));
    expect(voiceStore.getState().localServerMuted).toBe(true);
    expect(voiceStore.getState().localServerDeafened).toBe(true);
  });
});

describe("channel membership", () => {
  it("keeps who-watches-whom for the members who stay when another one leaves", () => {
    inChannel(2, 3);
    setPeerWatching(3, [2]);
    const watching = voiceStore.getState().peerWatching;
    removeVoiceUser({ channel_id: 10, user_id: 2 });
    expect(voiceStore.getState().peerWatching).toBe(watching);
    removeVoiceUser({ channel_id: 10, user_id: 3 });
    expect(voiceStore.getState().peerWatching?.has(3)).toBe(false);
  });

  it("lets a new join start with share allowed again", () => {
    setShareDenied(true);
    expect(voiceStore.getState().shareDenied).toBe(true);
    joinVoiceChannel(10);
    expect(voiceStore.getState().shareDenied).toBe(false);
  });
});

describe("small flags", () => {
  it("counts camera and share revisions up from nothing", () => {
    expect(voiceStore.getState().localCameraRev).toBeUndefined();
    bumpLocalCameraRev();
    expect(voiceStore.getState().localCameraRev).toBe(1);
    bumpLocalCameraRev();
    expect(voiceStore.getState().localCameraRev).toBe(2);
    bumpLocalShareRev();
    bumpLocalShareRev();
    expect(voiceStore.getState().localShareRev).toBe(2);
  });

  it("writes a share-denied verdict only when it changes", () => {
    const initial = voiceStore.getState();
    setShareDenied(false);
    expect(voiceStore.getState()).toBe(initial);
    setShareDenied(true);
    expect(voiceStore.getState().shareDenied).toBe(true);
    const denied = voiceStore.getState();
    setShareDenied(true);
    expect(voiceStore.getState()).toBe(denied);
    setShareDenied(false);
    expect(voiceStore.getState().shareDenied).toBe(false);
  });

  it("writes the moderator-deafen mark only when it changes", () => {
    const initial = voiceStore.getState();
    setModeratorDeafened(false);
    expect(voiceStore.getState()).toBe(initial);
    setModeratorDeafened(true);
    expect(voiceStore.getState().moderatorDeafened).toBe(true);
    const marked = voiceStore.getState();
    setModeratorDeafened(true);
    expect(voiceStore.getState()).toBe(marked);
  });

  it("records whether the member was muted before deafening", () => {
    setMutedBeforeDeafen(true);
    expect(voiceStore.getState().mutedBeforeDeafen).toBe(true);
    setMutedBeforeDeafen(false);
    expect(voiceStore.getState().mutedBeforeDeafen).toBe(false);
  });

  it("keeps a moderator's deafen across the member's own deafen and clears it on undeafen", () => {
    setLocalDeafened(true);
    expect(voiceStore.getState().moderatorDeafened).toBe(false);
    setModeratorDeafened(true);
    setLocalDeafened(true);
    expect(voiceStore.getState().moderatorDeafened).toBe(true);
    setLocalDeafened(false);
    expect(voiceStore.getState().moderatorDeafened).toBe(false);
    setLocalDeafened(false);
    expect(voiceStore.getState().moderatorDeafened).toBe(false);
  });
});

describe("saved mute and deafen", () => {
  it("saves the member's own mute, deafen and pre-deafen mute under their own keys", () => {
    setLocalMuted(true);
    setLocalDeafened(true);
    setMutedBeforeDeafen(true);
    saveSelfVoiceState();
    expect(loadPref<boolean>("localMuted", false)).toBe(true);
    expect(loadPref<boolean>("localDeafened", false)).toBe(true);
    expect(loadPref<boolean>("mutedBeforeDeafen", false)).toBe(true);

    setLocalMuted(false);
    setLocalDeafened(false);
    setMutedBeforeDeafen(false);
    saveSelfVoiceState();
    expect(loadPref<boolean>("localMuted", true)).toBe(false);
    expect(loadPref<boolean>("localDeafened", true)).toBe(false);
    expect(loadPref<boolean>("mutedBeforeDeafen", true)).toBe(false);
  });

  it("restores the saved state, and a deafen also mutes", () => {
    savePref("localMuted", false);
    savePref("localDeafened", true);
    savePref("mutedBeforeDeafen", true);
    setVoiceInSession(true);
    restoreSavedSelfVoiceState();
    const state = voiceStore.getState();
    expect(state.localDeafened).toBe(true);
    expect(state.localMuted).toBe(true);
    expect(state.mutedBeforeDeafen).toBe(true);
    expect(state.moderatorDeafened).toBe(false);
    expect(isVoiceDeafened()).toBe(true);
  });

  it("restores a plain saved mute, and starts clean with nothing saved", () => {
    savePref("localMuted", true);
    restoreSavedSelfVoiceState();
    expect(voiceStore.getState().localMuted).toBe(true);
    expect(voiceStore.getState().localDeafened).toBe(false);
    expect(voiceStore.getState().mutedBeforeDeafen).toBe(false);

    localStorage.clear();
    restoreSavedSelfVoiceState();
    expect(voiceStore.getState().localMuted).toBe(false);
    expect(voiceStore.getState().mutedBeforeDeafen).toBe(false);
  });
});

const selfSpeaking = (): boolean | undefined =>
  voiceStore.getState().voiceUsers.get(10)?.get(ME)?.speaking;

describe("input gate ring", () => {
  it("lights only while the gate is open and neither the mute nor push-to-talk silences the mic", () => {
    inChannel(ME);
    setLocalGateSpeaking(true);
    expect(selfSpeaking()).toBe(true);
    setPttGated(true);
    expect(selfSpeaking()).toBe(false);
    setPttGated(false);
    expect(selfSpeaking()).toBe(true);
    setLocalMuted(true);
    expect(selfSpeaking()).toBe(false);
    setLocalMuted(false);
    expect(selfSpeaking()).toBe(true);
    setLocalGateSpeaking(false);
    expect(selfSpeaking()).toBe(false);
  });

  it("leaves the roster untouched when the ring already shows the verdict", () => {
    inChannel(ME);
    setLocalGateSpeaking(true);
    const users = voiceStore.getState().voiceUsers;
    setLocalMuted(false);
    expect(voiceStore.getState().voiceUsers).toBe(users);
  });

  it("ignores a gate verdict repeated as it stands", () => {
    inChannel(ME);
    setLocalGateSpeaking(true);
    const state = voiceStore.getState();
    setLocalGateSpeaking(true);
    expect(voiceStore.getState()).toBe(state);
  });

  it("does not fail when the member has no roster entry or the channel has no roster", () => {
    inChannel(2);
    expect(() => setLocalGateSpeaking(true)).not.toThrow();
    expect(() => setLocalMuted(true)).not.toThrow();
    expect(voiceStore.getState().voiceUsers.get(10)?.has(ME)).toBe(false);

    resetVoiceStore();
    joinVoiceChannel(20);
    expect(() => setLocalGateSpeaking(true)).not.toThrow();
    expect(() => setPttGated(true)).not.toThrow();
  });
});

describe("peer lists", () => {
  it("drops a peer's decode list, and leaves the state alone for one it never had", () => {
    setPeerVideoDecode(2, ["vp9"]);
    expect(voiceStore.getState().peerVideoDecode?.get(2)).toEqual(["vp9"]);
    const withEntry = voiceStore.getState();
    setPeerVideoDecode(3, undefined);
    expect(voiceStore.getState()).toBe(withEntry);
    setPeerVideoDecode(2, undefined);
    expect(voiceStore.getState().peerVideoDecode?.has(2)).toBe(false);
  });

  it("forgets every watch set at once, and leaves an empty set alone", () => {
    inChannel(2, 3);
    const before = voiceStore.getState();
    clearPeerWatching();
    expect(voiceStore.getState()).toBe(before);
    setPeerWatching(2, [3]);
    expect(voiceStore.getState().peerWatching?.size).toBe(1);
    clearPeerWatching();
    expect(voiceStore.getState().peerWatching?.size).toBe(0);
  });

  it("changes a watch set only when it differs", () => {
    inChannel(2, 3);
    setPeerWatching(2, [3, 4]);
    const state = voiceStore.getState();
    setPeerWatching(2, [3, 4]);
    expect(voiceStore.getState()).toBe(state);

    setPeerWatching(2, [3, 5]);
    expect(voiceStore.getState().peerWatching?.get(2)).toEqual([3, 5]);
    setPeerWatching(2, [3]);
    expect(voiceStore.getState().peerWatching?.get(2)).toEqual([3]);
    setPeerWatching(2, [3, 4]);
    expect(voiceStore.getState().peerWatching?.get(2)).toEqual([3, 4]);
  });

  it("leaves the state alone when an empty set arrives for a member who watched nothing", () => {
    inChannel(2);
    const state = voiceStore.getState();
    setPeerWatching(2, []);
    expect(voiceStore.getState()).toBe(state);
    setPeerWatching(2, [5]);
    setPeerWatching(2, []);
    expect(voiceStore.getState().peerWatching?.has(2)).toBe(false);
  });
});

describe("restating the member's own state", () => {
  it("sends nothing without a signed-in user", () => {
    inChannel(ME);
    setLocalMuted(true);
    signIn(null);
    const ws = { send: vi.fn() };
    restateSelfVoiceState(ws);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("does not restate a mute while a moderator's mute holds", () => {
    inChannel(ME);
    setLocalMuted(true);
    voiceStore.setState((prev) => ({ ...prev, localServerMuted: true }));
    const ws = { send: vi.fn() };
    restateSelfVoiceState(ws);
    expect(ws.send).not.toHaveBeenCalled();

    voiceStore.setState((prev) => ({ ...prev, localServerMuted: false }));
    restateSelfVoiceState(ws);
    expect(ws.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
  });
});
