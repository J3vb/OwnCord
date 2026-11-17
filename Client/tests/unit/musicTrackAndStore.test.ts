// What marks a publication as music, and the store reducers that track who
// shares music in the current voice channel.
import { describe, expect, it } from "vitest";
import {
  isMusicPublication,
  isStreamAudioPublication,
  MUSIC_TRACK_NAME,
} from "../../src/lib/voice/musicTrack";
import {
  withLocalMusic,
  withMusicSharer,
  withRemoteMusicSharers,
} from "../../src/stores/voicePeers";
import type { VoiceState } from "../../src/stores/voiceModel";

const state = (over: Partial<VoiceState> = {}): VoiceState => ({ ...over }) as VoiceState;

describe("music track naming", () => {
  it("tells music from a share's sound by the track name alone", () => {
    const music = { source: "screen_share_audio", trackName: MUSIC_TRACK_NAME };
    const stream = { source: "screen_share_audio", trackName: "" };
    const unnamed = { source: "screen_share_audio" };
    expect(isMusicPublication(music)).toBe(true);
    expect(isStreamAudioPublication(music)).toBe(false);
    expect(isMusicPublication(stream)).toBe(false);
    expect(isStreamAudioPublication(stream)).toBe(true);
    expect(isStreamAudioPublication(unnamed)).toBe(true);
  });

  it("never calls another source music, whatever its name", () => {
    const mic = { source: "microphone", trackName: MUSIC_TRACK_NAME };
    expect(isMusicPublication(mic)).toBe(false);
    expect(isStreamAudioPublication(mic)).toBe(false);
  });
});

describe("music sharer reducers", () => {
  it("adds and removes a sharer, and keeps the state when nothing changes", () => {
    const base = state();
    const added = withMusicSharer(base, 4, true);
    expect([...added.musicSharers!]).toEqual([4]);
    expect(withMusicSharer(added, 4, true)).toBe(added);
    expect(withMusicSharer(added, 4, false).musicSharers!.size).toBe(0);
    expect(withMusicSharer(base, 4, false)).toBe(base);
  });

  it("replaces the remote sharers but keeps you while you share", () => {
    const sharing = state({ localMusic: true, musicSharers: new Set([1, 2]) });
    const next = withRemoteMusicSharers(sharing, [2, 3], 1);
    expect([...next.musicSharers!].sort()).toEqual([1, 2, 3]);
    const idle = state({ musicSharers: new Set([5]) });
    expect(withRemoteMusicSharers(idle, [5], 1)).toBe(idle);
    const unsigned = state({ localMusic: true });
    expect(withRemoteMusicSharers(unsigned, [], 0)).toBe(unsigned);
  });

  it("records your own share in the flag and the sharer set", () => {
    const on = withLocalMusic(state(), true, 9);
    expect(on.localMusic).toBe(true);
    expect(on.musicSharers!.has(9)).toBe(true);
    const off = withLocalMusic(on, false, 9);
    expect(off.localMusic).toBe(false);
    expect(off.musicSharers!.has(9)).toBe(false);
    expect(withLocalMusic(state(), true, 0).musicSharers!.size).toBe(0);
  });
});
