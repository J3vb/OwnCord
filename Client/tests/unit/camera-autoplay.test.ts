/**
 * WP 1B-3: remote cameras auto-play. The room event handlers ask the real
 * RemoteTracks whether a stream is watched: a camera is, unless the viewer
 * stopped it or turned "Automatically play cameras" off; a screen share keeps
 * its Watch stream card.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Track } from "livekit-client";
import type { RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room } from "livekit-client";

import { createRoomEventHandlers, type RoomEventDeps } from "@lib/roomEventHandlers";
import { savePref } from "@lib/preferences";
import { voiceStore } from "@stores/voice.store";
import type { AudioElements } from "@lib/audioElements";
import { RemoteTracks } from "../../src/features/voice/remoteTracks";
import { AUTO_PLAY_CAMERAS_PREF } from "../../src/features/voice/autoPlayCameras";

type Pub = RemoteTrackPublication & { setSubscribed: ReturnType<typeof vi.fn> };

function remotePub(source: Track.Source): Pub {
  const kind =
    source === Track.Source.Camera || source === Track.Source.ScreenShare
      ? Track.Kind.Video
      : Track.Kind.Audio;
  return { source, kind, trackSid: `TR_${source}`, setSubscribed: vi.fn() } as unknown as Pub;
}

function videoTrack(): RemoteTrack {
  return {
    kind: Track.Kind.Video,
    sid: "VT_1",
    detach: vi.fn(),
    mediaStreamTrack: { id: "mst" } as MediaStreamTrack,
  } as unknown as RemoteTrack;
}

/** One remote user (id 7) publishing these sources, the handlers, and the
 *  RemoteTracks they consult. */
function build(sources: Track.Source[]) {
  const pubs = new Map(sources.map((s) => [s, remotePub(s)]));
  const participant = {
    identity: "user-7:tok",
    getTrackPublication: (s: Track.Source) => pubs.get(s),
  } as unknown as RemoteParticipant;
  const room = { remoteParticipants: new Map([[participant.identity, participant]]) };
  const tracks = new RemoteTracks(() => room as unknown as Room);
  const onRemoteVideo = vi.fn();
  const deps = {
    getAudioElements: () => ({ handleTrackSubscribedAudio: vi.fn() }) as unknown as AudioElements,
    getOnRemoteVideoCallback: () => onRemoteVideo,
    getOnRemoteVideoRemovedCallback: () => null,
    isWatched: (userId: number, isScreenshare: boolean) =>
      tracks.isWatched(userId, isScreenshare ? "screenshare" : "camera"),
  } as unknown as RoomEventDeps;
  const handlers = createRoomEventHandlers(deps);
  const publish = (source: Track.Source): Pub => {
    const pub = pubs.get(source)!;
    handlers.handleTrackPublished(pub, participant);
    return pub;
  };
  const subscribe = (source: Track.Source): void =>
    handlers.handleTrackSubscribed(videoTrack(), pubs.get(source)!, participant);
  return { tracks, onRemoteVideo, publish, subscribe, pub: (s: Track.Source) => pubs.get(s)! };
}

beforeEach(() => {
  localStorage.clear();
  voiceStore.setState((prev) => ({ ...prev, localDeafened: false }));
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(readonly tracks: unknown[] = []) {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cameras auto-play", () => {
  it("subscribes a published camera and hands the grid a real stream, no Watch card", () => {
    const h = build([Track.Source.Camera]);

    const camera = h.publish(Track.Source.Camera);
    expect(camera.setSubscribed).toHaveBeenCalledWith(true);
    expect(h.onRemoteVideo).not.toHaveBeenCalled();

    h.subscribe(Track.Source.Camera);
    expect(h.onRemoteVideo).toHaveBeenCalledTimes(1);
    const [userId, stream, isScreenshare] = h.onRemoteVideo.mock.calls[0]!;
    expect(userId).toBe(7);
    expect(stream).not.toBeNull();
    expect(isScreenshare).toBe(false);
  });

  it("keeps a screen share and its audio behind Watch stream", () => {
    const h = build([Track.Source.ScreenShare, Track.Source.ScreenShareAudio]);

    const screen = h.publish(Track.Source.ScreenShare);
    const audio = h.publish(Track.Source.ScreenShareAudio);

    expect(screen.setSubscribed).toHaveBeenCalledWith(false);
    expect(audio.setSubscribed).toHaveBeenCalledWith(false);
    expect(h.onRemoteVideo).toHaveBeenCalledWith(7, null, true);
  });

  it("with the setting off, a camera waits behind Watch stream as before", () => {
    savePref(AUTO_PLAY_CAMERAS_PREF, false);
    const h = build([Track.Source.Camera]);

    const camera = h.publish(Track.Source.Camera);

    expect(camera.setSubscribed).toHaveBeenCalledWith(false);
    expect(h.onRemoteVideo).toHaveBeenCalledWith(7, null, false);

    h.tracks.watch(7, "camera", true);
    expect(camera.setSubscribed).toHaveBeenLastCalledWith(true);
  });

  it("Stop watching a camera unsubscribes it, and it stays stopped until leave", () => {
    const h = build([Track.Source.Camera]);
    const camera = h.publish(Track.Source.Camera);

    h.tracks.watch(7, "camera", false);
    expect(camera.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(h.tracks.isWatched(7, "camera")).toBe(false);

    // The camera goes off and on again: the grid forgets its tile, the
    // reconnect sweep runs, and the republish stays unsubscribed.
    h.tracks.forgetWatch(7, "camera");
    h.tracks.dropUnpublishedWatches();
    camera.setSubscribed.mockClear();
    h.publish(Track.Source.Camera);
    expect(camera.setSubscribed).toHaveBeenCalledWith(false);
    expect(h.onRemoteVideo).toHaveBeenLastCalledWith(7, null, false);

    // A subscription already on its way when Stop was clicked is dropped.
    h.onRemoteVideo.mockClear();
    h.subscribe(Track.Source.Camera);
    expect(h.onRemoteVideo).not.toHaveBeenCalled();

    // Leaving voice clears it: the next call plays the camera again.
    h.tracks.clearWatched();
    camera.setSubscribed.mockClear();
    h.publish(Track.Source.Camera);
    expect(camera.setSubscribed).toHaveBeenCalledWith(true);
  });

  it("Watch stream on a stopped camera plays it again", () => {
    const h = build([Track.Source.Camera]);
    const camera = h.publish(Track.Source.Camera);

    h.tracks.watch(7, "camera", false);
    h.tracks.watch(7, "camera", true);

    expect(camera.setSubscribed).toHaveBeenLastCalledWith(true);
    expect(h.tracks.isWatched(7, "camera")).toBe(true);
  });

  it("a camera that ends is forgotten, not stopped: the next one plays", () => {
    const h = build([Track.Source.Camera]);
    h.publish(Track.Source.Camera);

    h.tracks.forgetWatch(7, "camera");

    expect(h.tracks.isWatched(7, "camera")).toBe(true);
  });

  it("a screen share that ends is unwatched, its audio included", () => {
    const h = build([Track.Source.ScreenShare, Track.Source.ScreenShareAudio]);
    h.tracks.watch(7, "screenshare", true);

    h.tracks.forgetWatch(7, "screenshare");

    expect(h.tracks.isWatched(7, "screenshare")).toBe(false);
    expect(h.pub(Track.Source.ScreenShare).setSubscribed).toHaveBeenLastCalledWith(false);
    expect(h.pub(Track.Source.ScreenShareAudio).setSubscribed).toHaveBeenLastCalledWith(false);
  });
});
