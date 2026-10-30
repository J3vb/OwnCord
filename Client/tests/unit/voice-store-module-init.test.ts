import { describe, expect, it } from "vitest";
import { listSessionResets } from "../../src/lib/sessionRegistry";
import { isVoiceDeafened, setVoiceDeafened, setVoiceInSession } from "../../src/lib/voiceDeafened";
import { channelsStore, setChannels, updateChannel } from "../../src/stores/channels.store";
import { loadPref } from "../../src/lib/prefs/preferences";

// The voice store is imported inside the test body on purpose: its module-level
// setup (initial state, session-reset entry, channel subscriptions) is only
// observable on a first load.
describe("voice store first load", () => {
  it("starts clean, registers a voice-phase reset and follows the AFK flag of the channel in use", async () => {
    const voice = await import("../../src/stores/voice.store");
    const initial = voice.voiceStore.getState();
    expect(initial.moderatorDeafened).toBe(false);
    expect(initial.mutedBeforeDeafen).toBe(false);
    expect(initial.inAfkChannel).toBeUndefined();

    // The reset runs in the voice phase, ahead of every domain reset.
    const resets = listSessionResets();
    expect(resets).toContain("voice:store");
    expect(resets.indexOf("voice:store")).toBeLessThan(resets.indexOf("channels:store"));

    // Channel 6 is an ordinary voice channel, channel 5 the AFK one.
    setChannels([
      { id: 5, name: "parking", type: "voice", category: "Voice", position: 0, afk: true },
      { id: 6, name: "lounge", type: "voice", category: "Voice", position: 1 },
    ]);
    channelsStore.flush();
    voice.joinVoiceChannel(6);
    voice.voiceStore.flush();
    expect(voice.voiceStore.getState().inAfkChannel).toBeUndefined();

    // Moving into the AFK channel sets the flag, leaving it clears it.
    voice.joinVoiceChannel(5);
    voice.voiceStore.flush();
    expect(voice.voiceStore.getState().inAfkChannel).toBe(true);
    voice.joinVoiceChannel(6);
    voice.voiceStore.flush();
    expect(voice.voiceStore.getState().inAfkChannel).toBe(false);

    // A channel row changing while the member is inside takes effect too.
    updateChannel({ id: 6, afk: true });
    channelsStore.flush();
    voice.voiceStore.flush();
    expect(voice.voiceStore.getState().inAfkChannel).toBe(true);
    updateChannel({ id: 6, afk: false });
    channelsStore.flush();
    voice.voiceStore.flush();
    expect(voice.voiceStore.getState().inAfkChannel).toBe(false);

    // The member's own mute, deafen and pre-deafen mute are saved under their own names.
    voice.setLocalMuted(true);
    voice.setLocalDeafened(true);
    voice.setMutedBeforeDeafen(true);
    voice.saveSelfVoiceState();
    expect(loadPref<boolean>("localMuted", false)).toBe(true);
    expect(loadPref<boolean>("localDeafened", false)).toBe(true);
    expect(loadPref<boolean>("mutedBeforeDeafen", false)).toBe(true);
    voice.setLocalMuted(false);
    voice.setLocalDeafened(false);
    voice.setMutedBeforeDeafen(false);
    voice.saveSelfVoiceState();
    expect(loadPref<boolean>("localMuted", true)).toBe(false);
    expect(loadPref<boolean>("localDeafened", true)).toBe(false);
    expect(loadPref<boolean>("mutedBeforeDeafen", true)).toBe(false);
  });

  it("clears the AFK flag and both sound flags on reset", async () => {
    const voice = await import("../../src/stores/voice.store");
    voice.voiceStore.setState((prev) => ({
      ...prev,
      inAfkChannel: true,
      moderatorDeafened: true,
      mutedBeforeDeafen: true,
    }));
    setVoiceDeafened(true);
    setVoiceInSession(true);
    expect(isVoiceDeafened()).toBe(true);

    voice.resetVoiceStore();
    const state = voice.voiceStore.getState();
    expect(state.inAfkChannel).toBe(false);
    expect(state.moderatorDeafened).toBe(false);
    expect(state.mutedBeforeDeafen).toBe(false);

    // Each leaf flag was cleared on its own: raising one alone stays silent.
    setVoiceDeafened(true);
    expect(isVoiceDeafened()).toBe(false);
    setVoiceDeafened(false);

    setVoiceDeafened(true);
    setVoiceInSession(true);
    voice.resetVoiceStore();
    setVoiceInSession(true);
    expect(isVoiceDeafened()).toBe(false);
    setVoiceInSession(false);
  });
});
