/**
 * Tests for src/lib/voice/roomEventHandlers.ts (was 57.1% statements / 62.5%
 * functions, no test file).
 *
 * These handlers are the whole reaction surface of a live voice call: audio and
 * video attach/detach, speaker highlighting, autoplay unlocking, and the
 * disconnect path that decides between "reconnect silently" and "drop the user
 * out of voice". The disconnect branch matters most — getting it wrong either
 * strands the user in a dead call or tears down a call that was only blipping.
 */
import { describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/roomEventHandlersMocks";
import { Track } from "livekit-client";
import type { LocalTrackPublication, RemoteTrackPublication, Room } from "livekit-client";
import { voiceStore } from "@stores/voice.store";
import { expectConsole } from "../../helpers/console";
import {
  build,
  audioTrack,
  videoTrack,
  pub,
  participant,
  remotePub,
  unknownTrack,
  useRoomEventHandlersHarness,
} from "../../helpers/roomEventHandlersHarness";

vi.mock("@stores/voice.store", (importOriginal) => mocks.voiceStoreMock(importOriginal));

useRoomEventHandlersHarness();

// ── handleLocalTrackPublished ──────────────────────────────────────────────

describe("handleLocalTrackPublished", () => {
  it("re-applies mute when the local user is muted", () => {
    const h = build();
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));

    h.handlers.handleLocalTrackPublished({
      source: Track.Source.Microphone,
    } as LocalTrackPublication);

    expect(h.spies.applyMicMuteState).toHaveBeenCalledWith(true);
  });

  it("re-applies mute when the local user is deafened", () => {
    const h = build();
    voiceStore.setState((prev) => ({ ...prev, localDeafened: true }));

    h.handlers.handleLocalTrackPublished({
      source: Track.Source.Microphone,
    } as LocalTrackPublication);

    expect(h.spies.applyMicMuteState).toHaveBeenCalledWith(true);
  });

  it("does nothing when neither muted nor deafened", () => {
    const h = build();

    h.handlers.handleLocalTrackPublished({
      source: Track.Source.Microphone,
    } as LocalTrackPublication);

    expect(h.spies.applyMicMuteState).not.toHaveBeenCalled();
  });

  it("ignores non-microphone publications", () => {
    const h = build();
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));

    h.handlers.handleLocalTrackPublished({
      source: Track.Source.ScreenShare,
    } as LocalTrackPublication);

    expect(h.spies.applyMicMuteState).not.toHaveBeenCalled();
  });

  it("swallows a rejected applyMicMuteState", async () => {
    const applyMicMuteState = vi.fn().mockRejectedValue(new Error("no track"));
    const h = build({ applyMicMuteState });
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));

    expect(() => {
      h.handlers.handleLocalTrackPublished({
        source: Track.Source.Microphone,
      } as LocalTrackPublication);
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(applyMicMuteState).toHaveBeenCalled();
    });
    expectConsole("warn", /\[roomEventHandlers\] applyMicMuteState failed/);
  });

  // livekit-client republishes every local track after a full reconnect, and
  // restarts the mic track itself when its device ends. Both put the raw
  // capture track on the sender, past the input-volume and sensitivity chain.
  it("rebuilds the audio pipeline when the microphone is (re)published", () => {
    const h = build();

    h.handlers.handleLocalTrackPublished({
      source: Track.Source.Microphone,
    } as LocalTrackPublication);

    expect(h.spies.setupAudioPipeline).toHaveBeenCalledTimes(1);
  });

  // Deleted "rebuilds on TrackEvent.Restarted": the processor now survives SDK restarts, so the handler no longer subscribes.

  it("leaves the pipeline alone for a published camera or screen share", () => {
    const h = build();

    h.handlers.handleLocalTrackPublished({
      source: Track.Source.ScreenShare,
    } as LocalTrackPublication);

    expect(h.spies.setupAudioPipeline).not.toHaveBeenCalled();
  });
});

// ── handleTrackSubscribed / Unsubscribed ───────────────────────────────────

describe("handleTrackSubscribed", () => {
  it("routes audio tracks to the audio elements manager", () => {
    const h = build();
    const track = audioTrack();
    const publication = pub(Track.Source.Microphone);
    const p = participant("user-7:tok");

    h.handlers.handleTrackSubscribed(track, publication, p);

    expect(h.audioElements.handleTrackSubscribedAudio).toHaveBeenCalledWith(track, publication, p);
    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
  });

  it("unsubscribes and ignores screen-share audio that is no longer watched", () => {
    const h = build();
    const setSubscribed = vi.fn();
    const p = {
      source: Track.Source.ScreenShareAudio,
      setSubscribed,
    } as unknown as RemoteTrackPublication;

    h.handlers.handleTrackSubscribed(audioTrack(), p, participant("user-7:tok"));

    expect(h.audioElements.handleTrackSubscribedAudio).not.toHaveBeenCalled();
    expect(setSubscribed).toHaveBeenCalledWith(false);
  });

  it("hands watched screen-share audio to the audio elements", () => {
    const h = build();
    h.spies.isWatched.mockImplementation((_u: number, isScreenshare: boolean) => isScreenshare);
    const track = audioTrack();
    const publication = pub(Track.Source.ScreenShareAudio);
    const p = participant("user-7:tok");

    h.handlers.handleTrackSubscribed(track, publication, p);

    expect(h.spies.isWatched).toHaveBeenCalledWith(7, true);
    expect(h.audioElements.handleTrackSubscribedAudio).toHaveBeenCalledWith(track, publication, p);
  });

  it("hands camera video to the remote-video callback", () => {
    const h = build();
    h.spies.isWatched.mockReturnValue(true);

    h.handlers.handleTrackSubscribed(
      videoTrack(),
      pub(Track.Source.Camera),
      participant("user-7:tok"),
    );

    expect(h.spies.onRemoteVideo).toHaveBeenCalledTimes(1);
    const [userId, , isScreenshare] = h.spies.onRemoteVideo.mock.calls[0] as [
      number,
      MediaStream,
      boolean,
    ];
    expect(userId).toBe(7);
    expect(isScreenshare).toBe(false);
  });

  it("unsubscribes and ignores video that is no longer watched", () => {
    const h = build();
    const setSubscribed = vi.fn();
    const p = { source: Track.Source.Camera, setSubscribed } as unknown as RemoteTrackPublication;

    h.handlers.handleTrackSubscribed(videoTrack(), p, participant("user-7:tok"));

    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
    expect(setSubscribed).toHaveBeenCalledWith(false);
  });

  it("flags screenshare video as such", () => {
    const h = build();
    h.spies.isWatched.mockReturnValue(true);

    h.handlers.handleTrackSubscribed(
      videoTrack(),
      pub(Track.Source.ScreenShare),
      participant("user-7:tok"),
    );

    expect(h.spies.onRemoteVideo.mock.calls[0]?.[2]).toBe(true);
  });

  it("skips video with an unparseable identity", () => {
    const h = build();

    h.handlers.handleTrackSubscribed(
      videoTrack(),
      pub(Track.Source.Camera),
      participant("garbage"),
    );

    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
  });

  it("skips video when no callback is registered", () => {
    const h = build({ getOnRemoteVideoCallback: () => null });
    h.spies.isWatched.mockReturnValue(true);

    expect(() => {
      h.handlers.handleTrackSubscribed(
        videoTrack(),
        pub(Track.Source.Camera),
        participant("user-7:tok"),
      );
    }).not.toThrow();
  });
});

describe("handleTrackUnsubscribed", () => {
  it("routes audio tracks to the audio elements manager", () => {
    const h = build();
    const track = audioTrack();
    const publication = pub(Track.Source.Microphone);
    const p = participant("user-7:tok");

    h.handlers.handleTrackUnsubscribed(track, publication, p);

    expect(h.audioElements.handleTrackUnsubscribedAudio).toHaveBeenCalledWith(
      track,
      publication,
      p,
    );
  });

  it("detaches the video element and puts its tile back to Watch", () => {
    const h = build();
    const track = videoTrack();

    h.handlers.handleTrackUnsubscribed(track, pub(Track.Source.Camera), participant("user-9:tok"));

    // Without detach the <video> keeps the old MediaStream and the tile freezes
    // on the last frame instead of clearing. The stream is still published, so
    // its tile stays to be watched again; only the unpublish removes it.
    expect(track.detach).toHaveBeenCalled();
    expect(h.spies.onRemoteVideo).toHaveBeenCalledWith(9, null, false);
    expect(h.spies.onRemoteVideoRemoved).not.toHaveBeenCalled();
  });

  it("flags a screenshare's placeholder as such", () => {
    const h = build();

    h.handlers.handleTrackUnsubscribed(
      videoTrack(),
      pub(Track.Source.ScreenShare),
      participant("user-9:tok"),
    );

    expect(h.spies.onRemoteVideo).toHaveBeenCalledWith(9, null, true);
  });

  it("still detaches when the identity is unparseable", () => {
    const h = build();
    const track = videoTrack();

    h.handlers.handleTrackUnsubscribed(track, pub(Track.Source.Camera), participant("garbage"));

    expect(track.detach).toHaveBeenCalled();
    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
  });

  it("tolerates a missing video callback", () => {
    const h = build({ getOnRemoteVideoCallback: () => null });

    expect(() => {
      h.handlers.handleTrackUnsubscribed(
        videoTrack(),
        pub(Track.Source.Camera),
        participant("user-9:tok"),
      );
    }).not.toThrow();
  });
});

describe("handleTrackPublished (opt-in watching)", () => {
  it("does not subscribe a new camera, and offers it as a tile to watch", () => {
    const h = build();
    const camera = remotePub(Track.Source.Camera);

    h.handlers.handleTrackPublished(camera, participant("user-7:tok"));

    expect(h.spies.isWatched).toHaveBeenCalledWith(7, false);
    expect(camera.setSubscribed).toHaveBeenCalledWith(false);
    expect(h.spies.onRemoteVideo).toHaveBeenCalledWith(7, null, false);
  });

  it("does not subscribe a new screen share or its audio", () => {
    const h = build();
    const screen = remotePub(Track.Source.ScreenShare);
    const audio = remotePub(Track.Source.ScreenShareAudio);

    h.handlers.handleTrackPublished(screen, participant("user-7:tok"));
    h.handlers.handleTrackPublished(audio, participant("user-7:tok"));

    expect(h.spies.isWatched).toHaveBeenCalledWith(7, true);
    expect(screen.setSubscribed).toHaveBeenCalledWith(false);
    expect(audio.setSubscribed).toHaveBeenCalledWith(false);
    expect(h.spies.onRemoteVideo).toHaveBeenCalledTimes(1);
    expect(h.spies.onRemoteVideo).toHaveBeenCalledWith(7, null, true);
  });

  it("subscribes a stream the viewer is watching (a republish), with no placeholder", () => {
    const h = build();
    h.spies.isWatched.mockReturnValue(true);
    const screen = remotePub(Track.Source.ScreenShare);
    const audio = remotePub(Track.Source.ScreenShareAudio);

    h.handlers.handleTrackPublished(screen, participant("user-7:tok"));
    h.handlers.handleTrackPublished(audio, participant("user-7:tok"));

    expect(screen.setSubscribed).toHaveBeenCalledWith(true);
    expect(audio.setSubscribed).toHaveBeenCalledWith(true);
    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
  });

  it("subscribes a voice, unless deafened", () => {
    const h = build();
    const mic = remotePub(Track.Source.Microphone);
    h.handlers.handleTrackPublished(mic, participant("user-7:tok"));
    expect(mic.setSubscribed).toHaveBeenLastCalledWith(true);

    voiceStore.setState((prev) => ({ ...prev, localDeafened: true }));
    h.handlers.handleTrackPublished(mic, participant("user-7:tok"));
    expect(mic.setSubscribed).toHaveBeenLastCalledWith(false);
    expect(h.spies.isWatched).not.toHaveBeenCalled();
  });

  it("offers no tile for an unparseable identity", () => {
    const h = build();
    const camera = remotePub(Track.Source.Camera);

    h.handlers.handleTrackPublished(camera, participant("garbage"));

    expect(camera.setSubscribed).toHaveBeenCalledWith(false);
    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
  });

  it("applies the same rule to everyone already in the room on connect", () => {
    const h = build();
    const camera = remotePub(Track.Source.Camera);
    const mic = remotePub(Track.Source.Microphone);
    const room = {
      remoteParticipants: new Map([
        [
          "user-7:tok",
          {
            identity: "user-7:tok",
            trackPublications: new Map([
              ["c", camera],
              ["m", mic],
            ]),
          },
        ],
      ]),
    } as unknown as Room;

    h.handlers.handleConnected(room);

    expect(camera.setSubscribed).toHaveBeenCalledWith(false);
    expect(mic.setSubscribed).toHaveBeenCalledWith(true);
    expect(h.spies.onRemoteVideo).toHaveBeenCalledWith(7, null, false);
  });
});

describe("handleTrackUnpublished", () => {
  it("removes the stream's tile", () => {
    const h = build();

    h.handlers.handleTrackUnpublished(
      remotePub(Track.Source.ScreenShare),
      participant("user-9:tok"),
    );

    expect(h.spies.onRemoteVideoRemoved).toHaveBeenCalledWith(9, true);
  });

  it("ignores audio and unparseable identities", () => {
    const h = build();

    h.handlers.handleTrackUnpublished(
      remotePub(Track.Source.Microphone),
      participant("user-9:tok"),
    );
    h.handlers.handleTrackUnpublished(remotePub(Track.Source.Camera), participant("garbage"));

    expect(h.spies.onRemoteVideoRemoved).not.toHaveBeenCalled();
  });

  it("tolerates a missing removal callback", () => {
    const h = build({ getOnRemoteVideoRemovedCallback: () => null });

    expect(() => {
      h.handlers.handleTrackUnpublished(remotePub(Track.Source.Camera), participant("user-9:tok"));
    }).not.toThrow();
  });
});

describe("track routing edge cases", () => {
  it("plays screen-share audio from an unparseable identity instead of unsubscribing it", () => {
    const h = build();
    const audio = remotePub(Track.Source.ScreenShareAudio);

    h.handlers.handleTrackSubscribed(audioTrack(), audio, participant("garbage"));

    expect(audio.setSubscribed).not.toHaveBeenCalled();
    expect(h.audioElements.handleTrackSubscribedAudio).toHaveBeenCalledTimes(1);
  });

  it("builds the video stream from the subscribed track", () => {
    const h = build();
    h.spies.isWatched.mockReturnValue(true);
    const video = videoTrack();

    h.handlers.handleTrackSubscribed(
      video,
      remotePub(Track.Source.Camera),
      participant("user-7:tok"),
    );

    const stream = h.spies.onRemoteVideo.mock.calls[0]?.[1] as unknown as { tracks: unknown[] };
    expect(stream.tracks).toEqual([video.mediaStreamTrack]);
  });

  it("ignores a subscribed track that is neither audio nor video", () => {
    const h = build();
    const camera = remotePub(Track.Source.Camera);

    h.handlers.handleTrackSubscribed(unknownTrack(), camera, participant("user-7:tok"));

    expect(camera.setSubscribed).not.toHaveBeenCalled();
    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
    expect(h.audioElements.handleTrackSubscribedAudio).not.toHaveBeenCalled();
  });

  it("ignores an unsubscribed track that is neither audio nor video", () => {
    const h = build();
    const track = unknownTrack();

    h.handlers.handleTrackUnsubscribed(
      track,
      remotePub(Track.Source.Camera),
      participant("user-7:tok"),
    );

    expect(track.detach).not.toHaveBeenCalled();
    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
    expect(h.audioElements.handleTrackUnsubscribedAudio).not.toHaveBeenCalled();
  });

  it("never treats an unparseable identity as watched, even if the lookup says yes", () => {
    const h = build();
    h.spies.isWatched.mockReturnValue(true);
    const camera = remotePub(Track.Source.Camera);

    h.handlers.handleTrackPublished(camera, participant("garbage"));

    expect(camera.setSubscribed).toHaveBeenCalledWith(false);
    expect(camera.setSubscribed).not.toHaveBeenCalledWith(true);
    expect(h.spies.onRemoteVideo).not.toHaveBeenCalled();
  });

  it("reports a removed camera as not a screen share", () => {
    const h = build();

    h.handlers.handleTrackUnpublished(remotePub(Track.Source.Camera), participant("user-9:tok"));

    expect(h.spies.onRemoteVideoRemoved).toHaveBeenCalledWith(9, false);
  });
});
