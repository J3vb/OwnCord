// Ending a screen share must not take a running music share with it: both are
// ScreenShareAudio tracks, and `setScreenShareEnabled(false)` unpublishes the
// first one it finds.
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ localMusic: false }));
vi.mock("@stores/voice.store", () => ({ voiceStore: { getState: () => store } }));
vi.mock("./shareHostLinks", () => ({ setLocalScreenshare: vi.fn() }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock("@lib/diagnostics/eventSink", () => ({ recordEvent: vi.fn() }));

import { disableScreenshare } from "./screenTrackStop";
import type { ScreenTrackState, VideoTrackDeps } from "./videoTrackState";

function pub(source: string, trackName: string | undefined, id: string) {
  return { source, trackName, track: { mediaStreamTrack: id } };
}

function setup(pubs: Array<ReturnType<typeof pub>>, music = false) {
  store.localMusic = music;
  const local = {
    trackPublications: new Map(pubs.map((p, i) => [String(i), p])),
    setScreenShareEnabled: vi.fn(() => Promise.resolve()),
    unpublishTrack: vi.fn(() => Promise.resolve()),
  };
  const room = { localParticipant: local };
  const deps = { getRoom: () => room, getWs: () => null } as unknown as VideoTrackDeps;
  const state = { manualScreenTracks: [] } as ScreenTrackState;
  return { local, run: () => disableScreenshare(state, deps) };
}

describe("disableScreenshare with music running", () => {
  it("lets the room end the share when no music is published", async () => {
    const { local, run } = setup([
      pub("screen_share", undefined, "v"),
      pub("screen_share_audio", undefined, "a"),
    ]);
    await run();
    expect(local.setScreenShareEnabled).toHaveBeenCalledWith(false);
    expect(local.unpublishTrack).not.toHaveBeenCalled();
  });

  it("unpublishes the share's own tracks and leaves the music one", async () => {
    const { local, run } = setup(
      [
        pub("screen_share_audio", "music", "m"),
        pub("screen_share", undefined, "v"),
        pub("screen_share_audio", undefined, "a"),
        pub("microphone", undefined, "mic"),
      ],
      true,
    );
    await run();
    expect(local.setScreenShareEnabled).not.toHaveBeenCalled();
    expect(local.unpublishTrack.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["v", "a"]);
  });
});
