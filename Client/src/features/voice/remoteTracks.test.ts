import { describe, it, expect, vi, afterEach } from "vitest";
import { Encryption_Type, VideoQuality, type Room } from "livekit-client";

vi.mock("./screenShare", () => ({
  getLocalCameraStream: vi.fn(() => "camera"),
  getLocalScreenshareStream: vi.fn(() => "screen"),
}));

import { getLocalCameraStream, getLocalScreenshareStream } from "./screenShare";
import { RemoteTracks, LISTEN_GRACE_MS } from "./remoteTracks";

function roomWith(identity: string, source: string, track: unknown): Room {
  return {
    remoteParticipants: new Map([
      [
        identity,
        {
          identity,
          getTrackPublication: (s: string) => (s === source ? { track } : undefined),
        },
      ],
    ]),
  } as unknown as Room;
}

function roomWithPublication(identity: string, source: string, publication: unknown): Room {
  return {
    remoteParticipants: new Map([
      [
        identity,
        {
          identity,
          getTrackPublication: (s: string) => (s === source ? publication : undefined),
        },
      ],
    ]),
  } as unknown as Room;
}

/** A room whose user has these sources published, each with a setSubscribed spy. */
function roomWithSources(identity: string, sources: string[]) {
  const pubs = new Map(sources.map((source) => [source, { setSubscribed: vi.fn() }]));
  const room = {
    remoteParticipants: new Map([
      [identity, { identity, getTrackPublication: (s: string) => pubs.get(s) }],
    ]),
  } as unknown as Room;
  return { room, pub: (source: string) => pubs.get(source)!.setSubscribed };
}

/** A room whose user publishes a music track and, maybe, a screen share's sound,
 *  both on the screen-share-audio source. */
function roomWithMusicAndStreamAudio(withStreamAudio: boolean) {
  const music = { source: "screen_share_audio", trackName: "music", setSubscribed: vi.fn() };
  const stream = { source: "screen_share_audio", setSubscribed: vi.fn() };
  const all = withStreamAudio ? [music, stream] : [music];
  const room = {
    remoteParticipants: new Map([
      [
        "user-7",
        {
          identity: "user-7",
          getTrackPublication: () => music,
          trackPublications: new Map(all.map((p, i) => [String(i), p])),
        },
      ],
    ]),
  } as unknown as Room;
  return { room, music: music.setSubscribed, stream: stream.setSubscribed };
}

describe("RemoteTracks with music running", () => {
  it("subscribes the screen share's sound, not the music track, on a watch", () => {
    const { room, music, stream } = roomWithMusicAndStreamAudio(true);
    new RemoteTracks(() => room).watch(7, "screenshare", true);
    expect(stream).toHaveBeenLastCalledWith(true);
    expect(music).not.toHaveBeenCalled();
  });

  it("finds no screen share sound when only the music track is published", () => {
    const { room, music } = roomWithMusicAndStreamAudio(false);
    new RemoteTracks(() => room).watch(7, "screenshare", true);
    expect(music).not.toHaveBeenCalled();
  });
});

describe("RemoteTracks", () => {
  it("stores and clears both remote-video callbacks", () => {
    const tracks = new RemoteTracks(() => null);
    const onVideo = vi.fn();
    const onRemoved = vi.fn();
    tracks.setOnRemoteVideo(onVideo);
    tracks.setOnRemoteVideoRemoved(onRemoved);
    tracks.onRemoteVideoCallback?.(7, null, true);
    tracks.onRemoteVideoRemovedCallback?.(7, true);
    expect(onVideo).toHaveBeenCalledWith(7, null, true);
    expect(onRemoved).toHaveBeenCalledWith(7, true);
    tracks.clearOnRemoteVideo();
    expect(tracks.onRemoteVideoCallback).toBeNull();
    expect(tracks.onRemoteVideoRemovedCallback).toBeNull();
  });

  it("looks streams up on the room current at call time", () => {
    let room: Room | null = null;
    const tracks = new RemoteTracks(() => room);
    room = {} as Room;
    expect(tracks.getLocalCameraStream()).toBe("camera");
    expect(tracks.getLocalScreenshareStream()).toBe("screen");
    expect(getLocalCameraStream).toHaveBeenCalledWith(room);
    expect(getLocalScreenshareStream).toHaveBeenCalledWith(room);
  });

  describe("getRemoteVideoStats", () => {
    it("reads the receiver stats and bitrate of a user's screen share", async () => {
      const track = {
        currentBitrate: 5_800_000,
        getReceiverStats: vi.fn(async () => ({
          type: "video",
          frameWidth: 1920,
          frameHeight: 1080,
          framesDecoded: 600,
          timestamp: 1234,
          mimeType: "video/VP8",
          packetsLost: 1,
          packetsReceived: 999,
          framesDropped: 4,
          framesReceived: 604,
          decoderImplementation: "ExternalDecoder",
          jitterBufferDelay: 12.5,
        })),
      };
      const tracks = new RemoteTracks(() => roomWith("user-7:abc", "screen_share", track));

      await expect(tracks.getRemoteVideoStats(7, "screenshare")).resolves.toEqual({
        frameWidth: 1920,
        frameHeight: 1080,
        framesDecoded: 600,
        timestamp: 1234,
        bitrate: 5_800_000,
        codec: "video/VP8",
        packetsLost: 1,
        packetsReceived: 999,
        framesDropped: 4,
        framesReceived: 604,
        decoderImplementation: "ExternalDecoder",
        jitterBufferDelay: 12.5,
      });
    });

    it("is null without a room, a matching user, or receiver stats (the Linux native room)", async () => {
      await expect(
        new RemoteTracks(() => null).getRemoteVideoStats(7, "camera"),
      ).resolves.toBeNull();
      const other = new RemoteTracks(() =>
        roomWith("user-8", "camera", { getReceiverStats: vi.fn() }),
      );
      await expect(other.getRemoteVideoStats(7, "camera")).resolves.toBeNull();
      const native = new RemoteTracks(() => roomWith("user-7", "camera", {}));
      await expect(native.getRemoteVideoStats(7, "camera")).resolves.toBeNull();
    });
  });

  describe("setRemoteVideoView", () => {
    it("asks for the layer before enabling, and only disables a hidden tile", () => {
      const calls: string[] = [];
      const publication = {
        isSubscribed: true,
        setEnabled: (on: boolean) => calls.push(`enabled ${String(on)}`),
        setVideoQuality: (q: VideoQuality) => calls.push(`quality ${String(q)}`),
        setVideoDimensions: (d: { width: number; height: number }) =>
          calls.push(`size ${String(d.width)}x${String(d.height)}`),
      };
      const tracks = new RemoteTracks(() =>
        roomWithPublication("user-7", "screen_share", publication),
      );

      tracks.setRemoteVideoView(7, "screenshare", {
        enabled: true,
        size: { width: 160, height: 90 },
      });
      tracks.setRemoteVideoView(7, "screenshare", { enabled: true });
      tracks.setRemoteVideoView(7, "screenshare", { enabled: false });
      expect(calls).toEqual([
        "size 160x90",
        "enabled true",
        `quality ${String(VideoQuality.HIGH)}`,
        "enabled true",
        "enabled false",
      ]);
    });

    it("does nothing without a room or a matching user", () => {
      const view = { enabled: false };
      expect(() =>
        new RemoteTracks(() => null).setRemoteVideoView(7, "camera", view),
      ).not.toThrow();
      const setEnabled = vi.fn();
      new RemoteTracks(() =>
        roomWithPublication("user-8", "camera", { setEnabled }),
      ).setRemoteVideoView(7, "camera", view);
      expect(setEnabled).not.toHaveBeenCalled();
    });

    it("leaves a stream nobody watches alone: it is not subscribed", () => {
      const setEnabled = vi.fn();
      new RemoteTracks(() =>
        roomWithPublication("user-7", "camera", { isSubscribed: false, setEnabled }),
      ).setRemoteVideoView(7, "camera", { enabled: false });
      expect(setEnabled).not.toHaveBeenCalled();
    });
  });

  describe("watch (opt-in watching)", () => {
    it("watches nothing until asked", () => {
      const tracks = new RemoteTracks(
        () => null,
        () => false,
      );
      expect(tracks.isWatched(7, "camera")).toBe(false);
      expect(tracks.isWatched(7, "screenshare")).toBe(false);
    });

    it("subscribes a screen share and its audio on watch, and unsubscribes both on stop", () => {
      const { room, pub } = roomWithSources("user-7:tok", [
        "camera",
        "screen_share",
        "screen_share_audio",
      ]);
      const tracks = new RemoteTracks(
        () => room,
        () => false,
      );

      tracks.watch(7, "screenshare", true);
      expect(tracks.isWatched(7, "screenshare")).toBe(true);
      expect(tracks.isWatched(7, "camera")).toBe(false);
      expect(pub("screen_share")).toHaveBeenLastCalledWith(true);
      expect(pub("screen_share_audio")).toHaveBeenLastCalledWith(true);
      expect(pub("camera")).not.toHaveBeenCalled();

      tracks.watch(7, "screenshare", false);
      expect(tracks.isWatched(7, "screenshare")).toBe(false);
      expect(pub("screen_share")).toHaveBeenLastCalledWith(false);
      expect(pub("screen_share_audio")).toHaveBeenLastCalledWith(false);
    });

    it("subscribes only the camera for a camera watch", () => {
      const { room, pub } = roomWithSources("user-7", ["camera", "screen_share"]);
      const tracks = new RemoteTracks(() => room);
      tracks.watch(7, "camera", true);
      expect(pub("camera")).toHaveBeenCalledWith(true);
      expect(pub("screen_share")).not.toHaveBeenCalled();
    });

    it("never subscribes a stream published without end-to-end encryption", () => {
      const setSubscribed = vi.fn();
      const tracks = new RemoteTracks(() =>
        roomWithPublication("user-7", "camera", {
          setSubscribed,
          trackInfo: { encryption: Encryption_Type.NONE },
        }),
      );
      tracks.watch(7, "camera", true);
      expect(setSubscribed).not.toHaveBeenCalled();
      tracks.watch(7, "camera", false);
      expect(setSubscribed).toHaveBeenCalledWith(false);
    });

    it("remembers a watch made before the stream is published, with no room", () => {
      const tracks = new RemoteTracks(() => null);
      expect(() => tracks.watch(7, "camera", true)).not.toThrow();
      expect(tracks.isWatched(7, "camera")).toBe(true);
    });

    it("dropUnpublishedWatches forgets a watch the room has no publication for", () => {
      const tracks = new RemoteTracks(() => null);
      tracks.watch(7, "screenshare", true);
      tracks.dropUnpublishedWatches();
      expect(tracks.isWatched(7, "screenshare")).toBe(false);
    });

    it("auto-plays a camera by default; a screen share stays opt-in", () => {
      const tracks = new RemoteTracks(() => null);
      expect(tracks.isWatched(7, "camera")).toBe(true);
      expect(tracks.isWatched(7, "screenshare")).toBe(false);
    });

    it("Stop watching a camera unsubscribes it and keeps it stopped until leave", () => {
      const { room, pub } = roomWithSources("user-7", ["camera"]);
      const tracks = new RemoteTracks(
        () => room,
        () => true,
      );
      tracks.watch(7, "camera", false);
      expect(pub("camera")).toHaveBeenLastCalledWith(false);
      expect(tracks.isWatched(7, "camera")).toBe(false);

      tracks.forgetWatch(7, "camera");
      tracks.dropUnpublishedWatches();
      expect(tracks.isWatched(7, "camera")).toBe(false);

      tracks.clearWatched();
      expect(tracks.isWatched(7, "camera")).toBe(true);
    });

    it("Watch after Stop plays the camera again", () => {
      const tracks = new RemoteTracks(
        () => null,
        () => true,
      );
      tracks.watch(7, "camera", false);
      tracks.watch(7, "camera", true);
      expect(tracks.isWatched(7, "camera")).toBe(true);
    });

    it("forgetWatch never stops an auto-played camera", () => {
      const tracks = new RemoteTracks(
        () => null,
        () => true,
      );
      tracks.forgetWatch(7, "camera");
      expect(tracks.isWatched(7, "camera")).toBe(true);
    });

    it("forgetWatch unwatches a screen share and its audio", () => {
      const { room, pub } = roomWithSources("user-7", ["screen_share", "screen_share_audio"]);
      const tracks = new RemoteTracks(() => room);
      tracks.watch(7, "screenshare", true);
      tracks.forgetWatch(7, "screenshare");
      expect(tracks.isWatched(7, "screenshare")).toBe(false);
      expect(pub("screen_share")).toHaveBeenLastCalledWith(false);
      expect(pub("screen_share_audio")).toHaveBeenLastCalledWith(false);
    });

    it("with auto-play off, a camera is opt-in and forgetWatch drops its watch", () => {
      const tracks = new RemoteTracks(
        () => null,
        () => false,
      );
      expect(tracks.isWatched(7, "camera")).toBe(false);
      tracks.watch(7, "camera", true);
      expect(tracks.isWatched(7, "camera")).toBe(true);
      tracks.forgetWatch(7, "camera");
      expect(tracks.isWatched(7, "camera")).toBe(false);
    });

    it("clearWatched forgets every watch", () => {
      const tracks = new RemoteTracks(() => null);
      tracks.watch(7, "screenshare", true);
      tracks.clearWatched();
      expect(tracks.isWatched(7, "screenshare")).toBe(false);
    });
  });
  describe("onWatchingChange", () => {
    it("fires with the sorted screen-share ids only when the set changes", () => {
      const tracks = new RemoteTracks(
        () => null,
        () => false,
      );
      const cb = vi.fn();
      tracks.onWatchingChange = cb;
      tracks.watch(7, "screenshare", true);
      tracks.watch(3, "screenshare", true);
      expect(cb.mock.calls).toEqual([[[7]], [[3, 7]]]);
      // Watching the same stream again changes nothing.
      tracks.watch(3, "screenshare", true);
      expect(cb).toHaveBeenCalledTimes(2);
      tracks.watch(7, "screenshare", false);
      expect(cb).toHaveBeenLastCalledWith([3]);
    });

    it("never counts cameras", () => {
      const tracks = new RemoteTracks(
        () => null,
        () => false,
      );
      const cb = vi.fn();
      tracks.onWatchingChange = cb;
      tracks.watch(5, "camera", true);
      tracks.watch(5, "camera", false);
      tracks.forgetWatch(5, "camera");
      expect(cb).not.toHaveBeenCalled();
    });

    it("fires from forgetWatch, dropUnpublishedWatches and clearWatched", () => {
      const tracks = new RemoteTracks(
        () => null,
        () => false,
      );
      const cb = vi.fn();
      tracks.watch(4, "screenshare", true);
      tracks.watch(9, "screenshare", true);
      tracks.onWatchingChange = cb;
      tracks.forgetWatch(4, "screenshare");
      expect(cb).toHaveBeenLastCalledWith([9]);
      // No room: nothing is published, so the remaining watch is dropped.
      tracks.dropUnpublishedWatches();
      expect(cb).toHaveBeenLastCalledWith([]);
      tracks.watch(2, "screenshare", true);
      tracks.clearWatched();
      expect(cb).toHaveBeenLastCalledWith([]);
      expect(cb).toHaveBeenCalledTimes(4);
      // Clearing an already-empty set is silent.
      tracks.clearWatched();
      expect(cb).toHaveBeenCalledTimes(4);
    });
  });
});

// A replaced room (voice reconnect or rejoin) is detached before it
// disconnects, so it raises no unpublish for a stream that ended or a user
// who left during the outage. The sweep over the new room removes the tiles
// for streams it no longer publishes.
/** A room whose users publish the given sources ("camera", "screen_share"). */
function roomOf(users: Record<number, string[]>): Room {
  const remoteParticipants = new Map(
    Object.entries(users).map(([id, sources]) => [
      `user-${id}:tok`,
      {
        identity: `user-${id}:tok`,
        getTrackPublication: (s: string) => (sources.includes(s) ? { source: s } : undefined),
      },
    ]),
  );
  return { remoteParticipants } as unknown as Room;
}

function buildSwap(first: Room) {
  let room: Room | null = first;
  const tracks = new RemoteTracks(() => room);
  const offered = vi.fn();
  const removed = vi.fn();
  tracks.setOnRemoteVideo(offered);
  tracks.setOnRemoteVideoRemoved(removed);
  return {
    tracks,
    offered,
    removed,
    swap: (next: Room | null) => {
      room = next;
    },
  };
}

describe("RemoteTracks.removeUnpublishedTiles", () => {
  it("removes a share that ended and a camera whose user left during the swap", () => {
    const { tracks, removed, swap } = buildSwap(roomOf({ 7: ["screen_share"], 8: ["camera"] }));
    tracks.onRemoteVideoCallback?.(7, null, true);
    tracks.onRemoteVideoCallback?.(8, null, false);

    swap(roomOf({ 7: [] }));
    tracks.removeUnpublishedTiles();

    expect(removed).toHaveBeenCalledWith(7, true);
    expect(removed).toHaveBeenCalledWith(8, false);
    expect(removed).toHaveBeenCalledTimes(2);
  });

  it("keeps the tiles the new room still publishes", () => {
    const { tracks, removed, swap } = buildSwap(roomOf({ 7: ["screen_share", "camera"] }));
    tracks.onRemoteVideoCallback?.(7, null, true);
    tracks.onRemoteVideoCallback?.(7, null, false);

    swap(roomOf({ 7: ["camera"] }));
    tracks.removeUnpublishedTiles();

    expect(removed).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledWith(7, true);
  });

  it("does not remove a tile twice once its unpublish already removed it", () => {
    const { tracks, removed, swap } = buildSwap(roomOf({ 7: ["screen_share"] }));
    tracks.onRemoteVideoCallback?.(7, null, true);
    tracks.onRemoteVideoRemovedCallback?.(7, true);
    removed.mockClear();

    swap(roomOf({}));
    tracks.removeUnpublishedTiles();

    expect(removed).not.toHaveBeenCalled();
  });

  it("forgets the offered tiles on leave", () => {
    const { tracks, removed, swap } = buildSwap(roomOf({ 7: ["camera"] }));
    tracks.onRemoteVideoCallback?.(7, null, false);

    tracks.clearWatched();
    swap(roomOf({}));
    tracks.removeUnpublishedTiles();

    expect(removed).not.toHaveBeenCalled();
  });
});

/** A room whose users each publish a music track, with a setSubscribed spy. */
function roomWithMusic(ids: number[]) {
  const spies = new Map(ids.map((id) => [id, vi.fn()]));
  const participants = new Map(
    ids.map((id) => {
      const pub = {
        source: "screen_share_audio",
        trackName: "music",
        setSubscribed: spies.get(id)!,
      };
      return [
        `user-${String(id)}`,
        { identity: `user-${String(id)}`, trackPublications: new Map([["m", pub]]) },
      ];
    }),
  );
  const room = { state: "connected", remoteParticipants: participants } as unknown as Room;
  return { room, participants, sub: (id: number) => spies.get(id)! };
}

describe("RemoteTracks listen (opt-in music)", () => {
  afterEach(() => vi.useRealTimers());

  it("subscribes the listened-to sharer's music and reports it", () => {
    const { room, sub } = roomWithMusic([7]);
    const tracks = new RemoteTracks(() => room);
    const onChange = vi.fn();
    tracks.onListeningChange = onChange;

    tracks.listen(7);

    expect(sub(7)).toHaveBeenLastCalledWith(true);
    expect(tracks.isListening(7)).toBe(true);
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it("listens to one sharer at a time: switching unsubscribes the old one first", () => {
    const { room, sub } = roomWithMusic([7, 8]);
    const tracks = new RemoteTracks(() => room);
    tracks.listen(7);

    tracks.listen(8);

    expect(sub(7)).toHaveBeenLastCalledWith(false);
    expect(sub(8)).toHaveBeenLastCalledWith(true);
    expect(tracks.isListening(7)).toBe(false);
    expect(tracks.isListening(8)).toBe(true);
  });

  it("stops listening on null, once, and reports it", () => {
    const { room, sub } = roomWithMusic([7]);
    const tracks = new RemoteTracks(() => room);
    tracks.listen(7);
    const onChange = vi.fn();
    tracks.onListeningChange = onChange;

    tracks.listen(null);
    tracks.listen(null);

    expect(sub(7)).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps the choice for a sharer whose music is not published yet", () => {
    const tracks = new RemoteTracks(() => null);
    tracks.listen(7);
    expect(tracks.isListening(7)).toBe(true);
  });

  it("does not subscribe music published without encryption", () => {
    const { room, participants, sub } = roomWithMusic([7]);
    const pub = participants.get("user-7")!.trackPublications.get("m") as unknown as {
      trackInfo: unknown;
    };
    pub.trackInfo = { encryption: Encryption_Type.NONE };
    const tracks = new RemoteTracks(() => room);
    const onChange = vi.fn();
    tracks.onListeningChange = onChange;
    tracks.listen(7);
    expect(sub(7)).not.toHaveBeenCalledWith(true);
    expect(tracks.isListening(7)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps listening when the music is unpublished and published again (their reconnect)", () => {
    vi.useFakeTimers();
    const { room, participants } = roomWithMusic([7]);
    const tracks = new RemoteTracks(() => room);
    const onChange = vi.fn();
    tracks.listen(7);
    tracks.onListeningChange = onChange;
    const stored = participants.get("user-7")!.trackPublications;
    const pub = stored.get("m")!;
    stored.delete("m");

    tracks.musicEnded(7);
    vi.advanceTimersByTime(LISTEN_GRACE_MS / 2);
    stored.set("m", pub);
    vi.advanceTimersByTime(LISTEN_GRACE_MS);

    expect(tracks.isListening(7)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("forgets the listen when the music stays gone past the grace", () => {
    vi.useFakeTimers();
    const { room, participants } = roomWithMusic([7]);
    const tracks = new RemoteTracks(() => room);
    tracks.listen(7);
    const onChange = vi.fn();
    tracks.onListeningChange = onChange;
    participants.get("user-7")!.trackPublications.clear();

    tracks.musicEnded(7);
    vi.advanceTimersByTime(LISTEN_GRACE_MS + 1);

    expect(tracks.isListening(7)).toBe(false);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("keeps listening across your own reconnect that outlasts the grace, and picks the music up in the new room", () => {
    vi.useFakeTimers();
    const first = roomWithMusic([7]);
    let room: Room | null = first.room;
    const tracks = new RemoteTracks(() => room);
    tracks.listen(7);
    // The full restart unpublishes the music and leaves no room for a while.
    room = null;
    tracks.musicEnded(7);
    vi.advanceTimersByTime(LISTEN_GRACE_MS * 3);
    expect(tracks.isListening(7)).toBe(true);

    const next = roomWithMusic([7]);
    room = next.room;
    tracks.reviewListening();
    vi.advanceTimersByTime(LISTEN_GRACE_MS * 3);

    // Still listening, so the new room's handleTrackPublished subscribes it.
    expect(tracks.isListening(7)).toBe(true);
    expect(next.sub(7)).not.toHaveBeenCalledWith(false);
  });

  it("drops a listen when a join goes to another channel, and keeps it for the same one", () => {
    const { room } = roomWithMusic([7]);
    let channel: number | null = 10;
    const tracks = new RemoteTracks(() => room);
    tracks.currentChannel = () => channel;
    tracks.listen(7);
    // A rejoin through idle: the session has no channel while it reconnects.
    channel = null;
    tracks.keepListenFor(10);
    expect(tracks.isListening(7)).toBe(true);
    tracks.keepListenFor(20);
    expect(tracks.isListening(7)).toBe(false);
  });

  it("forgets a listen whose music comes back without encryption", () => {
    vi.useFakeTimers();
    const { room, participants } = roomWithMusic([7]);
    const tracks = new RemoteTracks(() => room);
    tracks.listen(7);
    const pub = [...participants.get("user-7")!.trackPublications.values()][0]!;
    Object.assign(pub, { trackInfo: { encryption: 0 } });
    tracks.reviewListening();
    vi.advanceTimersByTime(LISTEN_GRACE_MS + 1);
    expect(tracks.isListening(7)).toBe(false);
  });

  it("forgets a pending listen once a live room still lacks the music for the grace", () => {
    vi.useFakeTimers();
    let room: Room | null = null;
    const tracks = new RemoteTracks(() => room);
    tracks.listen(7);
    tracks.musicEnded(7);
    vi.advanceTimersByTime(LISTEN_GRACE_MS * 2);
    room = roomWithMusic([]).room;

    tracks.reviewListening();
    vi.advanceTimersByTime(LISTEN_GRACE_MS + 1);

    expect(tracks.isListening(7)).toBe(false);
  });

  it("does not restart or cancel anything when told to listen to the same sharer again", () => {
    const { room, sub } = roomWithMusic([7]);
    const tracks = new RemoteTracks(() => room);
    const onChange = vi.fn();
    tracks.listen(7);
    tracks.onListeningChange = onChange;
    sub(7).mockClear();

    tracks.listen(7);

    expect(onChange).not.toHaveBeenCalled();
    expect(sub(7)).not.toHaveBeenCalled();
  });

  it("ignores another sharer's music ending", () => {
    vi.useFakeTimers();
    const { room, participants } = roomWithMusic([7, 8]);
    const tracks = new RemoteTracks(() => room);
    tracks.listen(7);
    participants.get("user-8")!.trackPublications.clear();

    tracks.musicEnded(8);
    vi.advanceTimersByTime(LISTEN_GRACE_MS + 1);

    expect(tracks.isListening(7)).toBe(true);
  });

  it("keeps the listen across a room swap that still has the music, and forgets it when it does not", () => {
    vi.useFakeTimers();
    const first = roomWithMusic([7]);
    let room: Room = first.room;
    const tracks = new RemoteTracks(() => room);
    tracks.listen(7);

    room = roomWithMusic([7]).room;
    tracks.reviewListening();
    vi.advanceTimersByTime(LISTEN_GRACE_MS + 1);
    expect(tracks.isListening(7)).toBe(true);

    room = roomWithMusic([]).room;
    tracks.reviewListening();
    vi.advanceTimersByTime(LISTEN_GRACE_MS + 1);
    expect(tracks.isListening(7)).toBe(false);
  });

  it("forgets the listen on leave, and a pending grace does nothing after", () => {
    vi.useFakeTimers();
    const { room, participants } = roomWithMusic([7]);
    const tracks = new RemoteTracks(() => room);
    tracks.listen(7);
    participants.get("user-7")!.trackPublications.clear();
    tracks.musicEnded(7);
    const onChange = vi.fn();
    tracks.onListeningChange = onChange;

    tracks.clearWatched();
    vi.advanceTimersByTime(LISTEN_GRACE_MS + 1);

    expect(tracks.isListening(7)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
