import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  voiceStore,
  resetVoiceStore,
  joinVoiceChannel,
  restateSelfVoiceState,
} from "./voice.store";
import { authStore } from "./auth.store";
import type { VoiceUser } from "./voice.store";

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
});
