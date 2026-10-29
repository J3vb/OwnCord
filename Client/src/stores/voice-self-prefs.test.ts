import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  voiceStore,
  resetVoiceStore,
  joinVoiceChannel,
  restateSelfVoiceState,
  saveSelfVoiceState,
  restoreSavedSelfVoiceState,
} from "./voice.store";
import { authStore } from "./auth.store";

const ME = 9;
const CHANNEL = 4;

/** What a restart does to the voice store: a fresh store, then the page's
 *  session start loads the saved state. */
function restart(): void {
  resetVoiceStore();
  restoreSavedSelfVoiceState();
}

function setLocal(patch: Partial<ReturnType<typeof voiceStore.getState>>): void {
  voiceStore.setState((prev) => ({ ...prev, ...patch }));
}

beforeEach(() => {
  localStorage.clear();
  resetVoiceStore();
  authStore.setState((prev) => ({
    ...prev,
    user: { id: ME, username: "me", avatar: null, role: "member" },
  }));
});

describe("saved mute and deafen", () => {
  it("starts unmuted and undeafened when nothing was saved", () => {
    restart();

    const s = voiceStore.getState();
    expect(s.localMuted).toBe(false);
    expect(s.localDeafened).toBe(false);
  });

  it("brings a mute and a deafen back after a restart", () => {
    setLocal({ localMuted: true, localDeafened: true, mutedBeforeDeafen: true });
    saveSelfVoiceState();

    restart();

    const s = voiceStore.getState();
    expect(s.localMuted).toBe(true);
    expect(s.localDeafened).toBe(true);
    expect(s.mutedBeforeDeafen).toBe(true);
  });

  it("joins muted after a restart, and the server is told", () => {
    setLocal({ localMuted: true });
    saveSelfVoiceState();
    restart();

    joinVoiceChannel(CHANNEL);
    const socket = { send: vi.fn() };
    restateSelfVoiceState(socket);

    expect(socket.send).toHaveBeenCalledWith({ type: "voice_mute", payload: { muted: true } });
  });

  it("does not save a moderator's deafen as the member's own", () => {
    setLocal({ localMuted: false, localDeafened: true, moderatorDeafened: true });
    saveSelfVoiceState();

    restart();

    expect(voiceStore.getState().localDeafened).toBe(false);
  });

  it("keeps the last saved mute while a moderator's mute holds", () => {
    setLocal({ localMuted: false });
    saveSelfVoiceState();
    setLocal({ localMuted: true, localServerMuted: true });
    saveSelfVoiceState();

    restart();

    expect(voiceStore.getState().localMuted).toBe(false);
  });

  it("restores a deafen as muted too, even when the saved mute is older", () => {
    setLocal({ localMuted: false });
    saveSelfVoiceState();
    // Deafening under a moderator's mute keeps the older saved mute.
    setLocal({ localMuted: true, localServerMuted: true, localDeafened: true });
    saveSelfVoiceState();

    restart();

    expect(voiceStore.getState().localDeafened).toBe(true);
    expect(voiceStore.getState().localMuted).toBe(true);
  });

  it("leaves a live call's state alone", () => {
    setLocal({ localMuted: true });
    saveSelfVoiceState();
    resetVoiceStore();
    joinVoiceChannel(CHANNEL);

    restoreSavedSelfVoiceState();

    expect(voiceStore.getState().localMuted).toBe(false);
  });
});
