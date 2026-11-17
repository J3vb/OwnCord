// Delivery of stream audio and music is paused separately: a music track is
// answered by the music callback only, a stream's sound by the stream one.
import { describe, expect, it, vi } from "vitest";

vi.mock("livekit-client", () => ({
  Track: { Source: { ScreenShareAudio: "screen_share_audio", Microphone: "microphone" } },
}));

import { syncScreenshareDelivery } from "./screenshareDelivery";
import type { VoiceRoom } from "./voiceRoom";

function pub(source: string, trackName: string | undefined, subscribed = true) {
  return { source, trackName, isSubscribed: subscribed, setEnabled: vi.fn() };
}

function roomOf(...pubs: ReturnType<typeof pub>[]): VoiceRoom {
  return {
    remoteParticipants: new Map([
      [
        "a",
        { identity: "user-1", audioTrackPublications: new Map(pubs.map((p, i) => [String(i), p])) },
      ],
    ]),
  } as unknown as VoiceRoom;
}

describe("syncScreenshareDelivery", () => {
  it("answers a music track with the music callback and a stream's sound with the other", () => {
    const stream = pub("screen_share_audio", undefined);
    const music = pub("screen_share_audio", "music");
    syncScreenshareDelivery(
      roomOf(stream, music),
      () => true,
      () => false,
    );
    expect(stream.setEnabled).toHaveBeenCalledWith(true);
    expect(music.setEnabled).toHaveBeenCalledWith(false);
  });

  it("leaves music alone when no music callback is given", () => {
    const music = pub("screen_share_audio", "music");
    syncScreenshareDelivery(roomOf(music), () => false);
    expect(music.setEnabled).not.toHaveBeenCalled();
  });

  it("leaves a participant alone when its callback answers null", () => {
    const stream = pub("screen_share_audio", undefined);
    const music = pub("screen_share_audio", "music");
    syncScreenshareDelivery(
      roomOf(stream, music),
      () => null,
      () => null,
    );
    expect(stream.setEnabled).not.toHaveBeenCalled();
    expect(music.setEnabled).not.toHaveBeenCalled();
  });

  it("skips tracks that are not subscribed and other sources", () => {
    const pending = pub("screen_share_audio", "music", false);
    const mic = pub("microphone", "music");
    syncScreenshareDelivery(
      roomOf(pending, mic),
      () => false,
      () => false,
    );
    expect(pending.setEnabled).not.toHaveBeenCalled();
    expect(mic.setEnabled).not.toHaveBeenCalled();
  });

  it("does nothing without a room", () => {
    expect(() => syncScreenshareDelivery(null, () => true)).not.toThrow();
  });
});
