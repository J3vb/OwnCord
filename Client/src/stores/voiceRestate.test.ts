import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  voiceStore,
  resetVoiceStore,
  joinVoiceChannel,
  leaveVoiceChannel,
  restateSelfVoiceState,
  setLocalDeafened,
  setLocalMuted,
  setModeratorDeafened,
  updateVoiceState,
} from "./voice.store";
import { authStore } from "./auth.store";
import type { VoiceUser } from "./voice.store";
import { isVoiceDeafened } from "@lib/voice/voiceDeafened";

const ME = 9;
const CHANNEL = 4;

function socketStub() {
  return { send: vi.fn() };
}

function selfRow(overrides: Partial<VoiceUser> = {}): VoiceUser {
  return {
    userId: ME,
    username: "me",
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
    serverMuted: false,
    serverDeafened: false,
    ...overrides,
  };
}

function setSelfRow(row: VoiceUser | null): void {
  voiceStore.setState((prev) => ({
    ...prev,
    voiceUsers: row === null ? new Map() : new Map([[CHANNEL, new Map([[ME, row]])]]),
  }));
}

beforeEach(() => {
  resetVoiceStore();
  authStore.setState((prev) => ({
    ...prev,
    user: { id: ME, username: "me", avatar: null, role: "member" },
  }));
  joinVoiceChannel(CHANNEL);
});

describe("restateSelfVoiceState", () => {
  it("restates a local mute the server row does not carry", () => {
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
    setSelfRow(selfRow());
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
  });

  it("restates mute and deafen when the join has no row yet", () => {
    voiceStore.setState((prev) => ({ ...prev, localMuted: true, localDeafened: true }));
    setSelfRow(null);
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
    expect(socket.send).toHaveBeenCalledWith({
      type: "voice_deafen",
      payload: { deafened: true },
    });
  });

  it("sends nothing when the server row already agrees", () => {
    voiceStore.setState((prev) => ({ ...prev, localMuted: true, localDeafened: true }));
    setSelfRow(selfRow({ muted: true, deafened: true }));
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("sends nothing for a user who is neither muted nor deafened", () => {
    setSelfRow(null);
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("clears a server-side mute the user lifted while the socket was down", () => {
    setSelfRow(selfRow({ muted: true }));
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: false } });
  });

  it("leaves a moderator-imposed mute and deafen alone", () => {
    voiceStore.setState((prev) => ({
      ...prev,
      localMuted: true,
      localDeafened: true,
      localServerMuted: true,
      localServerDeafened: true,
    }));
    setSelfRow(selfRow());
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("leaves a deafen a moderator applied alone", () => {
    voiceStore.setState((prev) => ({
      ...prev,
      localMuted: true,
      localDeafened: true,
      moderatorDeafened: true,
    }));
    setSelfRow(selfRow({ muted: true }));
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("honours the caller's skip flags", () => {
    voiceStore.setState((prev) => ({ ...prev, localMuted: true, localDeafened: true }));
    setSelfRow(selfRow());
    const socket = socketStub();

    restateSelfVoiceState(socket, true, true);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("does nothing outside a voice channel", () => {
    resetVoiceStore();
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("skips only the flag the caller names", () => {
    voiceStore.setState((prev) => ({ ...prev, localMuted: true, localDeafened: true }));
    setSelfRow(selfRow());

    const skipMute = socketStub();
    restateSelfVoiceState(skipMute, true, false);
    expect(skipMute.send.mock.calls).toEqual([
      [{ type: "voice_deafen", payload: { deafened: true } }],
    ]);

    const skipDeafen = socketStub();
    restateSelfVoiceState(skipDeafen, false, true);
    expect(skipDeafen.send.mock.calls).toEqual([
      [{ type: "voice_mute", payload: { muted: true } }],
    ]);
  });

  it("sends the mute before the deafen", () => {
    voiceStore.setState((prev) => ({ ...prev, localMuted: true, localDeafened: true }));
    setSelfRow(selfRow());
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send.mock.calls.map(([frame]) => frame.type)).toEqual([
      "voice_mute",
      "voice_deafen",
    ]);
  });

  it("still restates the deafen when only a moderator's mute holds", () => {
    voiceStore.setState((prev) => ({
      ...prev,
      localMuted: true,
      localDeafened: true,
      localServerMuted: true,
    }));
    setSelfRow(selfRow());
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send.mock.calls).toEqual([
      [{ type: "voice_deafen", payload: { deafened: true } }],
    ]);
  });

  it("restates a deafen that the server row lost, with no mute change", () => {
    voiceStore.setState((prev) => ({ ...prev, localDeafened: true }));
    setSelfRow(selfRow());
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send.mock.calls).toEqual([
      [{ type: "voice_deafen", payload: { deafened: true } }],
    ]);
  });

  it("does nothing when nobody is signed in", () => {
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
    authStore.setState((prev) => ({ ...prev, user: null }));
    const socket = socketStub();

    restateSelfVoiceState(socket);

    expect(socket.send).not.toHaveBeenCalled();
  });
});

/** The member's own row as the server sends it, moderator flags included. */
function ownRow(flags: { server_muted?: boolean; server_deafened?: boolean }): void {
  updateVoiceState({
    channel_id: CHANNEL,
    user_id: ME,
    username: "me",
    muted: flags.server_muted === true,
    deafened: flags.server_deafened === true,
    speaking: false,
    camera: false,
    screenshare: false,
    ...flags,
  });
}

/** What enforcing the moderator's mute does to the store. */
function moderatorMutes(): void {
  ownRow({ server_muted: true });
  setLocalMuted(true);
}

describe("a moderator's mute or deafen at the end of a call", () => {
  it("drops a moderator's mute with the leave, so the next call starts open and restates nothing", () => {
    moderatorMutes();
    expect(voiceStore.getState().moderatorMuted).toBe(true);

    leaveVoiceChannel();

    expect(voiceStore.getState()).toMatchObject({ localMuted: false, moderatorMuted: false });
    joinVoiceChannel(CHANNEL);
    const socket = socketStub();
    restateSelfVoiceState(socket);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("keeps a mute the member had before the moderator's, and restates it on the next join", () => {
    setLocalMuted(true);
    ownRow({ server_muted: true });
    expect(voiceStore.getState().moderatorMuted).toBe(false);

    leaveVoiceChannel();

    expect(voiceStore.getState().localMuted).toBe(true);
    joinVoiceChannel(CHANNEL);
    const socket = socketStub();
    restateSelfVoiceState(socket);
    expect(socket.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
  });

  it("drops a moderator's mute laid over the member's own deafen, once they undeafen and leave", () => {
    setLocalDeafened(true);
    setLocalMuted(true);
    ownRow({ server_muted: true });
    expect(voiceStore.getState().moderatorMuted).toBe(true);
    // Undeafening under the moderator's mute keeps the mic muted.
    setLocalDeafened(false);

    leaveVoiceChannel();

    expect(voiceStore.getState()).toMatchObject({ localMuted: false, localDeafened: false });
  });

  it("keeps a mute the member had before deafening when a moderator mutes them too", () => {
    voiceStore.setState((prev) => ({ ...prev, mutedBeforeDeafen: true }));
    setLocalMuted(true);
    setLocalDeafened(true);
    ownRow({ server_muted: true });

    expect(voiceStore.getState().moderatorMuted).toBe(false);
  });

  it("keeps a deafen the member chose during the moderator's mute, and the mute that comes with it", () => {
    moderatorMutes();
    setLocalDeafened(true);

    leaveVoiceChannel();

    expect(voiceStore.getState()).toMatchObject({
      localMuted: true,
      localDeafened: true,
      moderatorMuted: false,
    });
  });

  it("drops a moderator's deafen with the leave, and the sound mirror with it", () => {
    ownRow({ server_deafened: true });
    setModeratorDeafened(true);
    setLocalDeafened(true);

    leaveVoiceChannel();

    expect(voiceStore.getState()).toMatchObject({
      localDeafened: false,
      moderatorDeafened: false,
      localMuted: false,
    });
    joinVoiceChannel(CHANNEL);
    expect(isVoiceDeafened()).toBe(false);
  });

  it("marks the mute again when the server re-sends it on the next join", () => {
    moderatorMutes();
    leaveVoiceChannel();
    joinVoiceChannel(CHANNEL);

    ownRow({ server_muted: true });

    expect(voiceStore.getState()).toMatchObject({ localServerMuted: true, moderatorMuted: true });
    ownRow({});
    expect(voiceStore.getState().moderatorMuted).toBe(false);
  });
});
