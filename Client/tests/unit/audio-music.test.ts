// Music shares on the listener side: a `ScreenShareAudio` track named `music`
// plays as music (own volume, own mute, silenced by deafen) and never as a
// screen share's sound, whichever order the two arrive in.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as logMock from "../helpers/loggerMock";
import * as voiceSession from "../helpers/voiceSessionMock";

const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, unknown>() }));

vi.mock("@lib/prefs/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/prefs/preferences")>()),
  loadPref: (key: string, def: unknown) => (prefs.has(key) ? prefs.get(key) : def),
  savePref: (key: string, val: unknown) => void prefs.set(key, val),
}));
vi.mock("@lib/logger", () => logMock.loggerMock());
vi.mock("livekit-client", () => ({
  RoomEvent: {},
  Track: { Source: { Microphone: "microphone", ScreenShareAudio: "screen_share_audio" } },
}));

const voice = { localDeafened: false, currentChannelId: null as number | null };
vi.mock("@stores/voice.store", () => ({ voiceStore: { getState: () => voice } }));
vi.mock("../../src/features/voice/livekitSession", () =>
  voiceSession.withOverrides({
    parseUserId: (identity: string) => Number(/^user-(\d+)$/.exec(identity)?.[1] ?? 0),
  }),
);

import { AudioElements } from "../../src/features/voice/audioElements";

function track(sid: string) {
  const el = document.createElement("audio");
  return { track: { kind: "audio", sid, detach: vi.fn(() => [el]), attach: vi.fn(() => el) }, el };
}
const participant = { identity: "user-42", setVolume: vi.fn() };
const publication = (trackName?: string) => ({
  source: "screen_share_audio",
  ...(trackName === undefined ? {} : { trackName }),
  setSubscribed: vi.fn(),
});

let elements: AudioElements;
beforeEach(() => {
  prefs.clear();
  voice.localDeafened = false;
  elements = new AudioElements();
  // Music plays only for the sharer listened to; these cases listen to 42.
  elements.setListenedMusicUser(42);
});

describe("listening", () => {
  it("plays only the listened-to sharer's music, at 0 for everyone else", () => {
    expect(elements.getMusicGain(7)).toBe(0);
    elements.setListenedMusicUser(7);
    expect(elements.getMusicGain(7)).toBe(1);
    expect(elements.getMusicGain(42)).toBe(0);
    elements.setListenedMusicUser(null);
    expect(elements.getMusicGain(7)).toBe(0);
  });

  it("tells a native mixer when the listened-to sharer changes", () => {
    const listener = vi.fn();
    elements.setMusicGainListener(listener);
    elements.setListenedMusicUser(7);
    expect(listener).toHaveBeenCalledTimes(1);
    elements.setListenedMusicUser(7);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("music volume and mute", () => {
  it("defaults to full volume, unmuted", () => {
    expect(elements.getMusicVolume(42)).toBe(100);
    expect(elements.getMusicMuted(42)).toBe(false);
    expect(elements.getMusicGain(42)).toBe(1);
  });

  it("keeps the volume to 0-100 and scales it by the output volume", () => {
    elements.setMusicVolume(42, 250);
    expect(elements.getMusicVolume(42)).toBe(100);
    elements.setMusicVolume(42, 50);
    elements.setOutputVolume(50);
    expect(elements.getMusicGain(42)).toBe(0.25);
  });

  it("is silent while Mute music is on, and comes back at the saved volume", () => {
    elements.setMusicVolume(42, 60);
    elements.setMusicMuted(42, true);
    expect(elements.getMusicGain(42)).toBe(0);
    elements.setMusicMuted(42, false);
    expect(elements.getMusicGain(42)).toBe(0.6);
  });

  it("is silent while deafened without touching the remembered mute", () => {
    voice.localDeafened = true;
    expect(elements.getMusicGain(42)).toBe(0);
    expect(elements.getMusicMuted(42)).toBe(false);
    voice.localDeafened = false;
    expect(elements.getMusicGain(42)).toBe(1);
  });

  it("announces a Music volume moving to or from 0, which reads as muted", () => {
    const seen: unknown[] = [];
    const onChange = (e: Event): void => void seen.push((e as CustomEvent).detail);
    window.addEventListener("owncord:user-local-mute-changed", onChange);
    elements.setMusicVolume(42, 50);
    elements.setMusicVolume(42, 0);
    elements.setMusicVolume(42, 0);
    elements.setMusicVolume(42, 30);
    window.removeEventListener("owncord:user-local-mute-changed", onChange);
    expect(seen).toEqual([{ userId: 42 }, { userId: 42 }]);
  });

  it("tells a native room when a music setting changes", () => {
    const listener = vi.fn();
    elements.setMusicGainListener(listener);
    elements.setMusicVolume(42, 30);
    elements.setMusicMuted(42, true);
    expect(listener).toHaveBeenCalledTimes(2);
    elements.setMusicGainListener(null);
    elements.setMusicVolume(42, 40);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

type Played = {
  musicAudioElements: Map<number, Set<HTMLAudioElement>>;
  screenshareAudioElements: Map<number, Set<HTMLAudioElement>>;
};

/** Subscribe `track` for user 42 under the given track name. */
function subscribe(
  played: ReturnType<typeof track>,
  trackName?: string,
  how: "handleTrackSubscribedAudio" | "handleTrackUnsubscribedAudio" = "handleTrackSubscribedAudio",
): void {
  elements[how](played.track as never, publication(trackName) as never, participant as never);
}

describe("routing by track name", () => {
  it("plays a music track as music and a nameless one as stream audio", () => {
    const music = track("TR_m");
    const stream = track("TR_s");
    subscribe(music, "music");
    subscribe(stream);
    const state = elements as unknown as Played;
    expect([...state.musicAudioElements.get(42)!]).toEqual([music.el]);
    expect([...state.screenshareAudioElements.get(42)!]).toEqual([stream.el]);
  });

  it("starts a track muted when the listener is deafened and restores it on undeafen", () => {
    voice.localDeafened = true;
    const music = track("TR_m");
    subscribe(music, "music");
    expect(music.el.muted).toBe(true);
    voice.localDeafened = false;
    elements.setMusicMuted(42, false);
    expect(music.el.muted).toBe(false);
  });

  it("removes a music element when its track goes away, leaving stream audio", () => {
    const music = track("TR_m");
    subscribe(music, "music");
    subscribe(track("TR_s"));
    subscribe(music, "music", "handleTrackUnsubscribedAudio");
    const state = elements as unknown as Played;
    expect(state.musicAudioElements.get(42)?.size ?? 0).toBe(0);
    expect(state.screenshareAudioElements.get(42)?.size).toBe(1);
  });
});

describe("Music volume announcement", () => {
  it("announces every level change, so the tile slider and the panel bar follow", () => {
    const seen = vi.fn();
    window.addEventListener("owncord:user-volume-changed", seen, { once: true });

    elements.setMusicVolume(42, 55);

    expect(seen).toHaveBeenCalledTimes(1);
    expect((seen.mock.calls[0]![0] as CustomEvent<{ userId: number }>).detail.userId).toBe(42);
  });
});
