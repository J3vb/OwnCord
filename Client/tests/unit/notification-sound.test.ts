/**
 * DP-40: the app's notification and voice sounds ignore the deafen state, and
 * they play on the system default output regardless of the device chosen in
 * settings. These pin both: a deafened player stays silent, and the shared
 * AudioContext's sink is the saved output and follows a device change.
 *
 * The voice-edge subscriber that decides *when* a sound plays is
 * voice-ui-sounds.test.ts's.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  cleanupNotificationAudio,
  playNotificationSound,
  startRingback,
} from "@lib/media/notificationSound";
import {
  setLocalDeafened,
  joinVoiceChannel,
  leaveVoiceChannel,
  voiceStore,
} from "@stores/voice.store";
import { expectConsole } from "../helpers/console";
import { soundSpec } from "@lib/media/soundTables";
import { RecordingAudioContext } from "../helpers/audioContextMock";

const MESSAGE_NOTES = soundSpec("modern", "message").length;

/** A recording context with the `setSinkId` Chromium and WebView2 have. */
class SinkAudioContext extends RecordingAudioContext {
  readonly setSinkId = vi.fn((id: string) => sinkState.impl(id));
}

/** The context the n-th `new AudioContext()` built. */
const context = (n = 0): SinkAudioContext => RecordingAudioContext.instances[n] as SinkAudioContext;

const { testPrefs, sinkState } = vi.hoisted(() => ({
  testPrefs: new Map<string, unknown>(),
  sinkState: { impl: async (_id: string): Promise<void> => {} },
}));

vi.mock("../../src/lib/prefs/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/prefs/preferences")>()),
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));

beforeEach(() => {
  testPrefs.clear();
  sinkState.impl = async () => {};
  RecordingAudioContext.instances = [];
  vi.stubGlobal("AudioContext", SinkAudioContext);
  leaveVoiceChannel();
  voiceStore.flush();
  setLocalDeafened(false);
  voiceStore.flush();
});

afterEach(() => {
  cleanupNotificationAudio();
  vi.unstubAllGlobals();
});

describe("playNotificationSound and deafen", () => {
  it("produces no oscillator while locally deafened in a voice session", () => {
    joinVoiceChannel(4);
    voiceStore.flush();
    setLocalDeafened(true);
    voiceStore.flush();

    playNotificationSound();

    expect(RecordingAudioContext.instances).toHaveLength(0);
  });

  it("plays again after leaving voice, though the stored deafen persists", () => {
    joinVoiceChannel(4);
    voiceStore.flush();
    setLocalDeafened(true);
    voiceStore.flush();
    playNotificationSound();
    expect(RecordingAudioContext.instances).toHaveLength(0);

    leaveVoiceChannel();
    voiceStore.flush();

    playNotificationSound();

    expect(RecordingAudioContext.instances).toHaveLength(1);
    expect(RecordingAudioContext.instances[0]!.oscillators).toHaveLength(MESSAGE_NOTES);
  });

  it("plays normally once undeafened", () => {
    playNotificationSound();

    expect(RecordingAudioContext.instances).toHaveLength(1);
    expect(RecordingAudioContext.instances[0]!.oscillators).toHaveLength(MESSAGE_NOTES);
  });
});

describe("the outgoing ringback and deafen", () => {
  it("stays silent while locally deafened in a voice session", () => {
    joinVoiceChannel(4);
    voiceStore.flush();
    setLocalDeafened(true);
    voiceStore.flush();

    startRingback();

    expect(RecordingAudioContext.instances).toHaveLength(0);
  });
});

describe("the shared AudioContext sink", () => {
  it("is set to the saved output device when the context is created", () => {
    testPrefs.set("audioOutputDevice", "speakers-a");

    playNotificationSound();

    const ctx = context();
    expect(ctx.setSinkId).toHaveBeenCalledWith("speakers-a");
  });

  it("stays on the default when no output device is saved", () => {
    playNotificationSound();

    expect(context().setSinkId).not.toHaveBeenCalled();
  });

  it("follows a device change", () => {
    testPrefs.set("audioOutputDevice", "speakers-a");
    playNotificationSound();
    const ctx = context();

    testPrefs.set("audioOutputDevice", "headphones-b");
    playNotificationSound();

    expect(ctx.setSinkId).toHaveBeenLastCalledWith("headphones-b");
  });

  it("does not re-issue setSinkId for an unchanged device", () => {
    testPrefs.set("audioOutputDevice", "speakers-a");
    playNotificationSound();
    playNotificationSound();

    expect(context().setSinkId).toHaveBeenCalledTimes(1);
  });

  it("retries setSinkId on the next play after a failed apply", async () => {
    testPrefs.set("audioOutputDevice", "speakers-a");
    sinkState.impl = async () => {
      throw new Error("device not ready");
    };

    playNotificationSound();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectConsole("warn", "Failed to set output device on notification audio");

    sinkState.impl = async () => {};
    playNotificationSound();

    expect(context().setSinkId).toHaveBeenCalledTimes(2);
  });
});
