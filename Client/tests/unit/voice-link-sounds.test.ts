/**
 * The voice sounds that follow your own session's link: the connection lost
 * sound after its grace time and the join sound when the session is back, and
 * the push-to-talk ticks (off by default). Edge logic in
 * features/voice/connectionSounds.ts, gates in features/voice/uiSounds.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetVoiceState } from "../helpers/storeSeeds";

const { prefs, playVoiceSound } = vi.hoisted(() => ({
  prefs: new Map<string, unknown>(),
  playVoiceSound: vi.fn(),
}));

vi.mock("../../src/lib/prefs/preferences", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => prefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => prefs.set(key, value),
}));
vi.mock("../../src/lib/media/notificationSound", () => ({ playVoiceSound }));

import {
  voiceStore,
  setVoiceStatus,
  setPttGated,
  setPttPollingLive,
  setLocalDeafened,
  setLocalMuted,
  leaveVoiceChannel,
  joinVoiceChannel,
} from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { startVoiceUiSounds } from "../../src/features/voice/uiSounds";
import { LOST_GRACE_MS } from "../../src/features/voice/connectionSounds";
import { sendUserJoin } from "../../src/features/voice/joinClick";
import type { VoiceStatus } from "@stores/voice.store";

const sounds = (): string[] => playVoiceSound.mock.calls.map(([kind]) => kind as string);

function apply(change: () => void): void {
  change();
  voiceStore.flush();
}

const status = (s: VoiceStatus): void => apply(() => setVoiceStatus(s));

function signIn(signedIn: boolean): void {
  authStore.setState((prev) => ({ ...prev, token: "t", isAuthenticated: signedIn }));
}

let stop: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  prefs.clear();
  signIn(true);
  // In channel 10 for real: connected, with its join already announced.
  resetVoiceState({ currentChannelId: 10, voiceStatus: "connected" });
  voiceStore.flush();
  stop = startVoiceUiSounds();
  playVoiceSound.mockClear();
});

afterEach(() => {
  stop();
  setPttPollingLive(false);
  vi.useRealTimers();
});

describe("connection lost", () => {
  it("plays once the drop outlasts the grace time, and the join sound when it is back", () => {
    status("reconnecting");
    vi.advanceTimersByTime(LOST_GRACE_MS - 1);
    expect(sounds()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sounds()).toEqual(["connectionLost"]);

    status("connected");
    expect(sounds()).toEqual(["connectionLost", "join"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is back through a rejoin too, with the join sound once", () => {
    status("reconnecting");
    vi.advanceTimersByTime(LOST_GRACE_MS);
    status("joining");
    status("securing");
    status("connected");
    status("connected");
    expect(sounds()).toEqual(["connectionLost", "join"]);
  });

  it("keeps a hiccup shorter than the grace time silent, its return too", () => {
    status("reconnecting");
    vi.advanceTimersByTime(LOST_GRACE_MS - 100);
    status("connected");
    vi.advanceTimersByTime(10_000);
    expect(sounds()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plays the leave sound, not the lost one, when the session ends", () => {
    status("reconnecting");
    vi.advanceTimersByTime(LOST_GRACE_MS);
    apply(() => leaveVoiceChannel());
    vi.advanceTimersByTime(1_000);
    expect(sounds()).toEqual(["connectionLost", "leave"]);
  });

  it("does not play for a session that only reached reconnecting from a join", () => {
    apply(() => leaveVoiceChannel());
    vi.advanceTimersByTime(1_000);
    playVoiceSound.mockClear();
    apply(() => {
      joinVoiceChannel(10);
      setVoiceStatus("securing");
    });
    status("reconnecting");
    vi.advanceTimersByTime(LOST_GRACE_MS * 2);
    expect(sounds()).toEqual([]);
  });

  it("does not play for a drop while a switch out of the call waits for the server", () => {
    sendUserJoin({ send: vi.fn(() => "join-id") }, 11);
    voiceStore.flush();
    expect(voiceStore.getState()).toMatchObject({ currentChannelId: 10, switchingTo: 11 });

    status("reconnecting");
    vi.advanceTimersByTime(LOST_GRACE_MS * 2);
    expect(sounds()).toEqual([]);
  });

  describe("a drop superseded while its grace time runs", () => {
    const supersede: ReadonlyArray<readonly [string, () => void]> = [
      ["the session ends", () => apply(() => leaveVoiceChannel())],
      ["you switch channel", () => apply(() => joinVoiceChannel(11))],
      [
        "you sign out",
        () =>
          apply(() => {
            signIn(false);
            resetVoiceState();
          }),
      ],
      ["the page tears down", () => stop()],
    ];

    it.each(supersede)("plays nothing later and leaves no timer when %s", (_, end) => {
      status("reconnecting");
      vi.advanceTimersByTime(LOST_GRACE_MS / 2);
      end();
      // The leave sound of an ended session has its own short grace.
      vi.advanceTimersByTime(LOST_GRACE_MS * 4);
      expect(sounds()).not.toContain("connectionLost");
      expect(sounds()).not.toContain("join");
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("is silent", () => {
    const silencers: ReadonlyArray<readonly [string, () => void]> = [
      ["under Do Not Disturb", () => prefs.set("userStatus", "dnd")],
      ["with Voice sounds off", () => prefs.set("voiceSounds", false)],
      ["with its own switch off", () => prefs.set("soundConnection", false)],
      ["while deafened", () => apply(() => setLocalDeafened(true))],
    ];

    it.each(silencers)("%s, and so is the return", (_, silence) => {
      silence();
      playVoiceSound.mockClear();
      status("reconnecting");
      vi.advanceTimersByTime(LOST_GRACE_MS);
      prefs.clear();
      apply(() => setLocalDeafened(false));
      playVoiceSound.mockClear();
      status("connected");
      expect(sounds()).toEqual([]);
    });
  });
});

describe("push-to-talk ticks", () => {
  /** Push-to-talk mode with a live key, the gate closed as a call has it. */
  function pttCall(soundOn = true): void {
    prefs.set("inputMode", "ptt");
    if (soundOn) prefs.set("soundPtt", true);
    setPttPollingLive(true);
    apply(() => setPttGated(true));
    playVoiceSound.mockClear();
  }

  const press = (): void => apply(() => setPttGated(false));
  const release = (): void => apply(() => setPttGated(true));

  it("ticks on and off for a press and a release", () => {
    pttCall();
    press();
    release();
    expect(sounds()).toEqual(["pttOn", "pttOff"]);
  });

  it("is off by default", () => {
    pttCall(false);
    press();
    release();
    expect(sounds()).toEqual([]);
  });

  it("does not tick as a call starts with the gate closing, nor as it ends", () => {
    prefs.set("inputMode", "ptt");
    prefs.set("soundPtt", true);
    setPttPollingLive(true);
    apply(() => {
      leaveVoiceChannel();
      setVoiceStatus("idle");
    });
    vi.advanceTimersByTime(1_000);
    playVoiceSound.mockClear();

    apply(() => {
      joinVoiceChannel(10);
      setVoiceStatus("joining");
    });
    release();
    status("connected");
    press();
    apply(() => leaveVoiceChannel());
    vi.advanceTimersByTime(1_000);
    expect(sounds()).toEqual(["join", "pttOn", "leave"]);
  });

  it("does not tick when the input mode switches either way", () => {
    prefs.set("soundPtt", true);
    // Voice activity to push-to-talk: the gate closes with no press before it.
    prefs.set("inputMode", "ptt");
    setPttPollingLive(true);
    release();
    // Push-to-talk to Voice activity: the press source goes, then the gate opens.
    prefs.set("inputMode", "vad");
    setPttPollingLive(false);
    press();
    expect(sounds()).toEqual([]);
  });

  it("does not tick for a gate edge while the session is reconnecting", () => {
    pttCall();
    status("reconnecting");
    press();
    release();
    expect(sounds()).toEqual([]);
  });

  describe("while the mic is not yours to open", () => {
    const closers: ReadonlyArray<readonly [string, () => void]> = [
      ["muted", () => apply(() => setLocalMuted(true))],
      [
        "muted by a moderator",
        () => apply(() => voiceStore.setState((p) => ({ ...p, localServerMuted: true }))),
      ],
      ["listen-only", () => apply(() => voiceStore.setState((p) => ({ ...p, listenOnly: true })))],
      [
        "in the AFK channel",
        () => apply(() => voiceStore.setState((p) => ({ ...p, inAfkChannel: true }))),
      ],
      [
        "on a phone call's hold",
        () => apply(() => voiceStore.setState((p) => ({ ...p, phoneCallHold: true }))),
      ],
    ];

    it.each(closers)("a press and its release make no tick when %s", (_, close) => {
      pttCall();
      close();
      playVoiceSound.mockClear();
      press();
      release();
      expect(sounds()).toEqual([]);
    });
  });

  it("unmuting with the key held ticks only from the next press", () => {
    pttCall();
    apply(() => setLocalMuted(true));
    press();
    apply(() => setLocalMuted(false));
    release();
    press();
    expect(sounds()).toEqual(["mute", "unmute", "pttOn"]);
  });

  it("muting with the key held forgets the open, so the release makes no tick", () => {
    pttCall();
    press();
    apply(() => setLocalMuted(true));
    release();
    expect(sounds()).toEqual(["pttOn", "mute"]);
  });

  it("is silent under Do Not Disturb and while deafened", () => {
    pttCall();
    prefs.set("userStatus", "dnd");
    press();
    release();
    prefs.delete("userStatus");
    apply(() => setLocalDeafened(true));
    playVoiceSound.mockClear();
    press();
    release();
    expect(sounds()).toEqual([]);
  });
});
