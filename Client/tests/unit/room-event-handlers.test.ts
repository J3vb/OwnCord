/**
 * Tests for src/lib/roomEventHandlers.ts (was 57.1% statements / 62.5%
 * functions, no test file).
 *
 * These handlers are the whole reaction surface of a live voice call: audio and
 * video attach/detach, speaker highlighting, autoplay unlocking, and the
 * disconnect path that decides between "reconnect silently" and "drop the user
 * out of voice". The disconnect branch matters most — getting it wrong either
 * strands the user in a dead call or tears down a call that was only blipping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisconnectReason, RoomEvent, Track } from "livekit-client";
import type {
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
} from "livekit-client";

import { createRoomEventHandlers } from "@lib/roomEventHandlers";
import { onRoom } from "../../src/features/voice/releaseRoom";
import { voiceJoinSnapshot } from "@lib/voiceJoinTrace";
import type { RoomEventDeps } from "@lib/roomEventHandlers";
import { voiceStore, setEncryptionDegraded } from "@stores/voice.store";
import type { VoiceUser } from "@stores/voice.store";
import type { AudioElements } from "@lib/audioElements";
import { expectConsole } from "../helpers/console";

// ── fakes ──────────────────────────────────────────────────────────────────

function fakeAudioElements(): AudioElements & {
  handleTrackSubscribedAudio: ReturnType<typeof vi.fn>;
  handleTrackUnsubscribedAudio: ReturnType<typeof vi.fn>;
  cleanupAllAudioElements: ReturnType<typeof vi.fn>;
} {
  return {
    handleTrackSubscribedAudio: vi.fn(),
    handleTrackUnsubscribedAudio: vi.fn(),
    cleanupAllAudioElements: vi.fn(),
    getEffectiveVolume: vi.fn().mockReturnValue(1),
  } as unknown as AudioElements & {
    handleTrackSubscribedAudio: ReturnType<typeof vi.fn>;
    handleTrackUnsubscribedAudio: ReturnType<typeof vi.fn>;
    cleanupAllAudioElements: ReturnType<typeof vi.fn>;
  };
}

interface Harness {
  deps: RoomEventDeps;
  handlers: ReturnType<typeof createRoomEventHandlers>;
  audioElements: ReturnType<typeof fakeAudioElements>;
  room: {
    canPlaybackAudio: boolean;
    startAudio: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  spies: {
    applyMicMuteState: ReturnType<typeof vi.fn>;
    setupAudioPipeline: ReturnType<typeof vi.fn>;
    attemptAutoReconnect: ReturnType<typeof vi.fn>;
    teardownForReconnect: ReturnType<typeof vi.fn>;
    leaveVoice: ReturnType<typeof vi.fn>;
    setRoom: ReturnType<typeof vi.fn>;
    setReconnectAc: ReturnType<typeof vi.fn>;
    syncModuleRooms: ReturnType<typeof vi.fn>;
    onRemoteVideo: ReturnType<typeof vi.fn>;
    onRemoteVideoRemoved: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    isWatched: ReturnType<typeof vi.fn>;
  };
}

function build(over: Partial<RoomEventDeps> = {}): Harness {
  const audioElements = fakeAudioElements();
  const room = {
    canPlaybackAudio: true,
    startAudio: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const spies = {
    applyMicMuteState: vi.fn().mockResolvedValue(undefined),
    setupAudioPipeline: vi.fn(),
    attemptAutoReconnect: vi.fn().mockResolvedValue(undefined),
    teardownForReconnect: vi.fn(),
    leaveVoice: vi.fn(),
    setRoom: vi.fn(),
    setReconnectAc: vi.fn(),
    syncModuleRooms: vi.fn(),
    onRemoteVideo: vi.fn(),
    onRemoteVideoRemoved: vi.fn(),
    onError: vi.fn(),
    isWatched: vi.fn((_userId: number, _isScreenshare: boolean) => false),
  };

  const deps: RoomEventDeps = {
    getRoom: () => room as unknown as Room,
    setRoom: spies.setRoom,
    getCurrentChannelId: () => 12,
    getAudioElements: () => audioElements,
    getOnRemoteVideoCallback: () => spies.onRemoteVideo,
    getOnRemoteVideoRemovedCallback: () => spies.onRemoteVideoRemoved,
    isWatched: spies.isWatched,
    getOnErrorCallback: () => spies.onError,
    isConnecting: () => false,
    isReconnecting: () => false,
    getLatestToken: () => "tok",
    getLastUrl: () => "wss://lk.example",
    getLastDirectUrl: () => undefined,
    setReconnectAc: spies.setReconnectAc,
    syncModuleRooms: spies.syncModuleRooms,
    teardownForReconnect: spies.teardownForReconnect,
    leaveVoice: spies.leaveVoice,
    applyMicMuteState: spies.applyMicMuteState,
    setupAudioPipeline: spies.setupAudioPipeline,
    isNativeRoom: () => false,
    attemptAutoReconnect: spies.attemptAutoReconnect,
    ...over,
  };

  return { deps, handlers: createRoomEventHandlers(deps), audioElements, room, spies };
}

function audioTrack(): RemoteTrack {
  return {
    kind: Track.Kind.Audio,
    sid: "AT_1",
    detach: vi.fn(),
    mediaStreamTrack: {} as MediaStreamTrack,
  } as unknown as RemoteTrack;
}

function videoTrack(): RemoteTrack & { detach: ReturnType<typeof vi.fn> } {
  return {
    kind: Track.Kind.Video,
    sid: "VT_1",
    detach: vi.fn(),
    mediaStreamTrack: { id: "mst" } as MediaStreamTrack,
  } as unknown as RemoteTrack & { detach: ReturnType<typeof vi.fn> };
}

function pub(source: Track.Source): RemoteTrackPublication {
  return { source } as unknown as RemoteTrackPublication;
}

function participant(identity: string): RemoteParticipant {
  return { identity } as unknown as RemoteParticipant;
}

beforeEach(() => {
  voiceStore.setState((prev) => ({
    ...prev,
    localMuted: false,
    localDeafened: false,
    encryptionDegraded: false,
  }));
  vi.stubGlobal(
    "MediaStream",
    class {
      tracks: unknown[];
      constructor(tracks: unknown[] = []) {
        this.tracks = tracks;
      }
    },
  );
});

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

  it("hands camera video to the remote-video callback", () => {
    const h = build();

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

  it("flags screenshare video as such", () => {
    const h = build();

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

// ── opt-in watching: what is subscribed ────────────────────────────────────

/** A remote publication whose subscription the handlers set. */
function remotePub(
  source: Track.Source,
): RemoteTrackPublication & { setSubscribed: ReturnType<typeof vi.fn> } {
  const kind =
    source === Track.Source.Camera || source === Track.Source.ScreenShare
      ? Track.Kind.Video
      : Track.Kind.Audio;
  return {
    source,
    kind,
    trackSid: `TR_${source}`,
    setSubscribed: vi.fn(),
  } as unknown as RemoteTrackPublication & { setSubscribed: ReturnType<typeof vi.fn> };
}

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

// ── handleActiveSpeakersChanged ────────────────────────────────────────────

describe("handleActiveSpeakersChanged", () => {
  function speaker(identity: string): Participant {
    return { identity } as unknown as Participant;
  }

  function seedVoiceUsers(channelId: number, userIds: number[]): void {
    voiceStore.setState((prev) => {
      const users = new Map<number, VoiceUser>(
        userIds.map((id) => [
          id,
          {
            userId: id,
            username: `u${id}`,
            muted: false,
            deafened: false,
            speaking: false,
            camera: false,
            screenshare: false,
          },
        ]),
      );
      return { ...prev, voiceUsers: new Map([[channelId, users]]) };
    });
  }

  it("marks the reported users as speaking", () => {
    seedVoiceUsers(12, [3, 7]);
    const h = build();

    h.handlers.handleActiveSpeakersChanged([speaker("user-7:tok")]);

    const users = voiceStore.getState().voiceUsers.get(12);
    expect(users?.get(7)?.speaking).toBe(true);
    expect(users?.get(3)?.speaking).toBe(false);
  });

  it("clears speaking when the list empties", () => {
    seedVoiceUsers(12, [7]);
    const h = build();
    h.handlers.handleActiveSpeakersChanged([speaker("user-7:tok")]);

    h.handlers.handleActiveSpeakersChanged([]);

    expect(voiceStore.getState().voiceUsers.get(12)?.get(7)?.speaking).toBe(false);
  });

  it("ignores participants with an unparseable identity", () => {
    seedVoiceUsers(12, [7]);
    const h = build();

    h.handlers.handleActiveSpeakersChanged([speaker("garbage"), speaker("user-7:tok")]);

    expect(voiceStore.getState().voiceUsers.get(12)?.get(7)?.speaking).toBe(true);
  });

  it("does nothing when not in a channel", () => {
    seedVoiceUsers(12, [7]);
    const h = build({ getCurrentChannelId: () => null });

    h.handlers.handleActiveSpeakersChanged([speaker("user-7:tok")]);

    expect(voiceStore.getState().voiceUsers.get(12)?.get(7)?.speaking).toBe(false);
  });
});

// ── handleAudioPlaybackChanged ─────────────────────────────────────────────

describe("handleAudioPlaybackChanged", () => {
  it("does nothing without a room", () => {
    const h = build({ getRoom: () => null });

    expect(() => {
      h.handlers.handleAudioPlaybackChanged();
    }).not.toThrow();
  });

  it("registers a click-to-unlock listener when playback is blocked", async () => {
    const h = build();
    h.room.canPlaybackAudio = false;

    h.handlers.handleAudioPlaybackChanged();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    // The browser blocks autoplay until a user gesture; without this the user
    // joins a call and hears nothing at all.
    await vi.waitFor(() => {
      expect(h.room.startAudio).toHaveBeenCalled();
    });
  });

  it("does not register a listener when playback is allowed", () => {
    const h = build();
    h.room.canPlaybackAudio = true;

    h.handlers.handleAudioPlaybackChanged();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(h.room.startAudio).not.toHaveBeenCalled();
  });

  it("replaces a previous unlock listener rather than stacking them", async () => {
    const h = build();
    h.room.canPlaybackAudio = false;

    h.handlers.handleAudioPlaybackChanged();
    h.handlers.handleAudioPlaybackChanged();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await vi.waitFor(() => {
      expect(h.room.startAudio).toHaveBeenCalledTimes(1);
    });
    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
  });

  it("removeAutoplayUnlock drops the pending listener", () => {
    const h = build();
    h.room.canPlaybackAudio = false;
    h.handlers.handleAudioPlaybackChanged();

    h.handlers.removeAutoplayUnlock();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    expect(h.room.startAudio).not.toHaveBeenCalled();
  });

  it("removeAutoplayUnlock is safe with nothing registered", () => {
    const h = build();

    expect(() => {
      h.handlers.removeAutoplayUnlock();
      h.handlers.removeAutoplayUnlock();
    }).not.toThrow();
  });

  it("a later allowed-playback event clears the pending listener", () => {
    const h = build();
    h.room.canPlaybackAudio = false;
    h.handlers.handleAudioPlaybackChanged();

    h.room.canPlaybackAudio = true;
    h.handlers.handleAudioPlaybackChanged();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    expect(h.room.startAudio).not.toHaveBeenCalled();
  });

  it("the unlock handler tolerates the room disappearing first", () => {
    let room: Room | null = { canPlaybackAudio: false } as unknown as Room;
    const h = build({ getRoom: () => room });

    h.handlers.handleAudioPlaybackChanged();
    expectConsole("warn", /\[roomEventHandlers\] Audio playback blocked by browser/);
    room = null; // user left voice before clicking

    expect(() => {
      document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }).not.toThrow();
  });
});

// ── handleEncryptionError (OC-0002) ────────────────────────────────────────
//
// livekit-client's E2eeManager emits RoomEvent.EncryptionError when the
// per-room E2EE worker dies (onWorkerError) — the ECDH/HKDF key exchange can
// still succeed while the worker that actually encrypts frames is dead. With
// nothing subscribed to this event, that failure was invisible: voiceStatus
// still reaches "connected" and the widget's Secured badge lit up regardless.

describe("handleEncryptionError", () => {
  it("marks encryption degraded in the voice store so the Secured badge can react", () => {
    const h = build();
    expect(voiceStore.getState().encryptionDegraded).toBe(false);

    h.handlers.handleEncryptionError(new Error("worker crashed"));

    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  it("SRE-M2: counts every receive-side decrypt failure, tolerated or not", () => {
    const h = build();
    const bob = { identity: "bob", isLocal: false } as Participant;
    const before = voiceJoinSnapshot().decryptErrorCount;

    h.handlers.handleEncryptionError(
      new Error("InvalidKey: Decryption failed: operation-specific"),
      bob,
    );

    expectConsole("warn", /receive-side decrypt failure/);
    expect(voiceJoinSnapshot().decryptErrorCount).toBe(before + 1);
  });

  it("SRE-M2: counts a native decrypt failure from a remote participant", () => {
    const h = build();
    const bob = { identity: "bob", isLocal: false } as Participant;
    const before = voiceJoinSnapshot().decryptErrorCount;

    h.handlers.handleEncryptionError(new Error("native decrypt failure"), bob);

    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expect(voiceJoinSnapshot().decryptErrorCount).toBe(before + 1);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  it("SRE-M2: does not count an error with no remote participant as a decrypt failure", () => {
    const h = build();
    const before = voiceJoinSnapshot().decryptErrorCount;

    h.handlers.handleEncryptionError(new Error("worker crashed"));
    h.handlers.handleEncryptionError(new Error("InvalidKey: local"), {
      identity: "me",
      isLocal: true,
    } as Participant);

    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expect(voiceJoinSnapshot().decryptErrorCount).toBe(before);
  });

  it("marks encryption degraded even when no participant is attributed", () => {
    const h = build();

    h.handlers.handleEncryptionError(new Error("worker crashed"), undefined);

    expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
    expect(voiceStore.getState().encryptionDegraded).toBe(true);
  });

  // OC-0452: every key rotation installs the new room key at index 0 before
  // the peer has it, so for a moment one side's frames fail AES-GCM with a
  // key present — the worker reports `InvalidKey: Decryption failed` for the
  // REMOTE sender. Those frames are dropped, never played in clear, and the
  // failures stop once the offer lands. Only a streak that outlasts the grace
  // window is a real failure.
  describe("receive-side decrypt failures (OC-0452)", () => {
    const bob = { identity: "bob", isLocal: false } as Participant;
    const decryptFailed = () =>
      new Error(
        "InvalidKey: Decryption failed: The operation failed for an operation-specific reason",
      );

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not degrade on a transient InvalidKey from a remote participant at join", () => {
      const h = build();

      h.handlers.handleEncryptionError(decryptFailed(), bob);
      vi.advanceTimersByTime(1000);
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("degrades when decrypt failures from the same participant persist past the grace window", () => {
      const h = build();

      // The worker throttles to one error per second: a key that never lands
      // keeps reporting at that cadence.
      for (let i = 0; i < 3; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        expectConsole("warn", /receive-side decrypt failure/);
        vi.advanceTimersByTime(1000);
      }
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("clears the degraded badge again once a stalled peer's decrypts resume", () => {
      const h = build();

      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);

      // The key finally lands: the worker stops reporting, so a quiet gap
      // longer than livekit's 60 s error-rate window clears the latch instead
      // of leaving "Unsecured" for the rest of the call.
      vi.advanceTimersByTime(30_000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
      vi.advanceTimersByTime(40_000);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("clears a native room's stall as soon as its unthrottled reports stop", () => {
      // The native room re-reports every second until the peer decrypts
      // again, so a gap past the streak reset already means recovery.
      const h = build({ isNativeRoom: () => true });

      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);

      vi.advanceTimersByTime(3000);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("stays degraded while a failing peer's reports are held back by livekit's rate limiter", () => {
      const h = build();
      // livekit-client's ErrorRateLimiter: one report a second, at most 5 per
      // window, and a new window only once 60 s have passed since the last
      // report, so a peer that never decrypts again reports in bursts about
      // 66 s apart with just over 60 s of silence between them.
      const reportFor = (seconds: number): void => {
        for (let s = 0; s < seconds; s++) {
          if (s % 66 <= 5) h.handlers.handleEncryptionError(decryptFailed(), bob);
          vi.advanceTimersByTime(1000);
          expect(voiceStore.getState().encryptionDegraded).toBe(s >= 3);
        }
      };

      reportFor(180);
      // Three bursts, one streak: no key install between them, so only the
      // first burst's first 3 reports are tolerated.
      for (let i = 0; i < 3; i++) expectConsole("warn", /receive-side decrypt failure/);
      for (let i = 0; i < 15; i++) {
        expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      }
    });

    it("keeps the badge degraded when the worker dies while a decrypt recovery is pending", () => {
      const h = build();

      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      // The worker dies: no more decrypt reports arrive, and the quiet gap
      // that follows must not read as the peer's decrypts resuming.
      h.handlers.handleEncryptionError(new Error("E2EE worker crashed"));
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      vi.advanceTimersByTime(5000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);

      // A later decrypt streak (after a fresh key install) and its quiet gap
      // do not clear it either.
      h.handlers.noteRoomKeyInstalled();
      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      vi.advanceTimersByTime(5000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("does not let a pending recovery from a left call touch the next one", () => {
      const h = build();

      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      // Leave; the next call starts clean and is degraded by its own cause,
      // which the left call's quiet-gap timer must not clear.
      h.handlers.resetEncryptionRecovery();
      setEncryptionDegraded(false);
      setEncryptionDegraded(true);
      vi.advanceTimersByTime(5000);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("tolerates separate transient races a few seconds apart", () => {
      const h = build();

      h.handlers.handleEncryptionError(decryptFailed(), bob);
      vi.advanceTimersByTime(5000);
      // Each rotation race comes with its own key install.
      h.handlers.noteRoomKeyInstalled();
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("tolerates separate transient races that are far apart", () => {
      const h = build();

      h.handlers.handleEncryptionError(decryptFailed(), bob);
      vi.advanceTimersByTime(5 * 60_000);
      h.handlers.noteRoomKeyInstalled();
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("intermittent bursts with a wrong key degrade the call", () => {
      const h = build();

      // Bursts shorter than the grace window, separated by a quiet gap: the
      // gap is not evidence the peer's frames decrypt again.
      // Errors at t = 0, 1, 2 s, silence, then t = 5, 6 s.
      for (let i = 0; i < 3; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      for (let i = 0; i < 3; i++) expectConsole("warn", /receive-side decrypt failure/);
      vi.advanceTimersByTime(2000);
      h.handlers.handleEncryptionError(decryptFailed(), bob);
      vi.advanceTimersByTime(1000);
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("a key install starts a fresh grace window", () => {
      const h = build();

      for (let i = 0; i < 3; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      vi.advanceTimersByTime(7000);
      h.handlers.noteRoomKeyInstalled();
      for (let i = 0; i < 3; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }

      for (let i = 0; i < 6; i++) expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("a key install in the same millisecond as the last failure still starts a fresh window", () => {
      const h = build();

      // A streak already past the grace window.
      for (let i = 0; i < 4; i++) {
        h.handlers.handleEncryptionError(decryptFailed(), bob);
        vi.advanceTimersByTime(1000);
      }
      h.handlers.handleEncryptionError(decryptFailed(), bob);
      for (let i = 0; i < 3; i++) expectConsole("warn", /receive-side decrypt failure/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      setEncryptionDegraded(false);

      // The next rotation installs its key without the clock moving.
      h.handlers.noteRoomKeyInstalled();
      vi.advanceTimersByTime(1000);
      h.handlers.handleEncryptionError(decryptFailed(), bob);

      expectConsole("warn", /receive-side decrypt failure/);
      expect(voiceStore.getState().encryptionDegraded).toBe(false);
    });

    it("degrades immediately on a sender-side missing key, even with a participant attributed", () => {
      const h = build();
      const me = { identity: "me", isLocal: true } as Participant;

      h.handlers.handleEncryptionError(
        new Error("MissingKey: encryption key missing for encoding"),
        me,
      );

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("degrades immediately on an InvalidKey attributed to the local participant", () => {
      const h = build();
      const me = { identity: "me", isLocal: true } as Participant;

      h.handlers.handleEncryptionError(decryptFailed(), me);

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("degrades immediately on an InvalidKey with no participant attributed", () => {
      const h = build();

      h.handlers.handleEncryptionError(decryptFailed(), undefined);

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });

    it("degrades immediately on a native-backend encryption failure", () => {
      const h = build();

      h.handlers.handleEncryptionError(new Error("native E2EE not active"));

      expectConsole("error", /\[roomEventHandlers\] LiveKit E2EE encryption error/);
      expect(voiceStore.getState().encryptionDegraded).toBe(true);
    });
  });
});

// ── handleDisconnected ─────────────────────────────────────────────────────

describe("handleDisconnected", () => {
  it("defers to the retry loop while still connecting", () => {
    const h = build({ isConnecting: () => true });

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
  });

  // The bundled livekit-client emits RoomEvent.Disconnected (synchronously,
  // before rejecting) on EVERY failed reconnect attempt inside the retry
  // loop's own room.connect() call — including while the active reconnect
  // loop is still running with the attempt room's listeners attached. Without
  // this guard that re-entrant Disconnected starts a SECOND, uncancellable
  // attemptAutoReconnect loop whose AbortController is stored nowhere.
  it("defers to the active reconnect loop while already reconnecting", () => {
    const h = build({ isConnecting: () => false, isReconnecting: () => true });

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
    expect(h.spies.teardownForReconnect).not.toHaveBeenCalled();
  });

  it("auto-reconnects on an unexpected disconnect", () => {
    const h = build();
    onRoom(h.room as unknown as Room, RoomEvent.Disconnected, h.handlers.handleDisconnected);

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.teardownForReconnect).toHaveBeenCalled();
    expect(h.audioElements.cleanupAllAudioElements).toHaveBeenCalled();
    expect(h.spies.setRoom).toHaveBeenCalledWith(null);
    expect(h.spies.syncModuleRooms).toHaveBeenCalled();
    // Only the app's own listener goes; livekit's disconnect cleanups stay.
    expect(h.room.off).toHaveBeenCalledWith(RoomEvent.Disconnected, h.handlers.handleDisconnected);
    expect(h.room.disconnect).toHaveBeenCalled();
    expect(h.spies.setReconnectAc).toHaveBeenCalledWith(expect.any(AbortController));
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalledWith(
      "tok",
      "wss://lk.example",
      12,
      undefined,
      expect.any(AbortSignal),
    );
    // A reconnect must not surface an error toast or leave the channel.
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
    expect(h.spies.onError).not.toHaveBeenCalled();
  });

  it("passes the direct URL through to the reconnect attempt", () => {
    const h = build({ getLastDirectUrl: () => "wss://direct.example" });

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.attemptAutoReconnect).toHaveBeenCalledWith(
      "tok",
      "wss://lk.example",
      12,
      "wss://direct.example",
      expect.any(AbortSignal),
    );
  });

  it("leaves voice cleanly on a client-initiated disconnect", () => {
    const h = build();

    h.handlers.handleDisconnected(DisconnectReason.CLIENT_INITIATED);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).toHaveBeenCalledWith(false);
    // The user asked to leave, so no error is reported.
    expect(h.spies.onError).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", { getLatestToken: () => null }],
    ["no channel", { getCurrentChannelId: () => null }],
    ["no url", { getLastUrl: () => null }],
  ])("reports an error when it cannot reconnect (%s)", (_label, over) => {
    const h = build(over as Partial<RoomEventDeps>);

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).toHaveBeenCalledWith(false);
    expect(h.spies.onError).toHaveBeenCalledWith("Voice connection lost — disconnected");
  });

  it("treats an undefined reason as unexpected", () => {
    const h = build();

    h.handlers.handleDisconnected(undefined);

    expect(h.spies.attemptAutoReconnect).toHaveBeenCalled();
  });

  it("tolerates the room already being gone", () => {
    const h = build({ getRoom: () => null });

    expect(() => {
      h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);
    }).not.toThrow();
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalled();
  });

  it("swallows a failing disconnect on the stale room", async () => {
    const h = build();
    h.room.disconnect.mockRejectedValue(new Error("already closed"));

    expect(() => {
      h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(h.room.disconnect).toHaveBeenCalled();
    });
    expectConsole("warn", /\[roomEventHandlers\] Failed to disconnect stale room/);
  });

  it("tolerates a missing error callback", () => {
    const h = build({ getLatestToken: () => null, getOnErrorCallback: () => null });

    expect(() => {
      h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);
    }).not.toThrow();
  });
});

// ── handleSdkReconnecting / handleSdkReconnected (RT-9) ────────────────────

// livekit-client retries a dropped signal socket on its own before it ever
// emits Disconnected (an SFU restart spends most of its window here), so the
// widget must read "reconnecting" during that phase, not "connected".
describe("handleSdkReconnecting / handleSdkReconnected", () => {
  function setStatus(voiceStatus: "securing" | "connected" | "reconnecting"): void {
    voiceStore.setState((prev) => ({ ...prev, voiceStatus }));
  }

  it("shows reconnecting while the SDK retries a connected room, then connected once it recovers", () => {
    const h = build();
    setStatus("connected");

    h.handlers.handleSdkReconnecting();
    expect(voiceStore.getState().voiceStatus).toBe("reconnecting");

    h.handlers.handleSdkReconnected();
    expect(voiceStore.getState().voiceStatus).toBe("connected");
  });

  it("leaves a join that is still securing alone", () => {
    const h = build();
    setStatus("securing");

    h.handlers.handleSdkReconnecting();
    h.handlers.handleSdkReconnected();

    expect(voiceStore.getState().voiceStatus).toBe("securing");
  });

  it("ignores events from a room that is not the connected session room", () => {
    const h = build({ getRoom: () => null, isReconnecting: () => true });
    setStatus("reconnecting");

    h.handlers.handleSdkReconnected();

    expect(voiceStore.getState().voiceStatus).toBe("reconnecting");
  });
});

// ── stalled signal resume ──────────────────────────────────────────────────

// livekit-client resumes a cut signal socket up to 10 times, each allowed 15 s
// to open, before it emits Disconnected, so a cut the SFU never answers leaves
// the badge on "reconnecting" and every stream frozen for minutes while a
// manual rejoin takes ~150 ms. The widget gives the SDK a short budget, then
// abandons that room and runs its own reconnect loop.
describe("a stalled signal resume", () => {
  const BUDGET_MS = 10_000;

  beforeEach(() => {
    vi.useFakeTimers();
    voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected" }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the stuck room and starts the reconnect loop once the budget is spent", () => {
    const h = build();
    onRoom(h.room as unknown as Room, RoomEvent.Disconnected, h.handlers.handleDisconnected);

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS - 1);
    expect(h.room.disconnect).not.toHaveBeenCalled();
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expectConsole("warn", /LiveKit resume stalled/);
    expect(h.spies.teardownForReconnect).toHaveBeenCalled();
    expect(h.spies.setRoom).toHaveBeenCalledWith(null);
    expect(h.room.off).toHaveBeenCalledWith(RoomEvent.Disconnected, h.handlers.handleDisconnected);
    expect(h.room.disconnect).toHaveBeenCalled();
    expect(h.spies.setReconnectAc).toHaveBeenCalledWith(expect.any(AbortController));
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalledWith(
      "tok",
      "wss://lk.example",
      12,
      undefined,
      expect.any(AbortSignal),
    );
    // A recovery, not a leave: no error toast and the channel is kept.
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
    expect(h.spies.onError).not.toHaveBeenCalled();
  });

  it("does nothing when the SDK reconnects within the budget", () => {
    const h = build();

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS - 1);
    h.handlers.handleSdkReconnected();
    vi.advanceTimersByTime(BUDGET_MS);

    expect(h.room.disconnect).not.toHaveBeenCalled();
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
  });

  it("does nothing when the SDK gives up on its own within the budget", () => {
    const h = build();

    h.handlers.handleSdkReconnecting();
    h.handlers.handleDisconnected(DisconnectReason.CLIENT_INITIATED);
    vi.advanceTimersByTime(BUDGET_MS * 2);

    expect(h.room.disconnect).not.toHaveBeenCalled();
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
  });

  it("counts the budget from the first event when Reconnecting follows SignalReconnecting", () => {
    const h = build();

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS / 2);
    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS / 2);

    expectConsole("warn", /LiveKit resume stalled/);
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalledTimes(1);
  });

  it("leaves a room that is no longer the connected session room alone", () => {
    let current: Room | null = {} as Room;
    const h = build({ getRoom: () => current });

    h.handlers.handleSdkReconnecting();
    current = null; // the user left, or another attempt replaced the room
    vi.advanceTimersByTime(BUDGET_MS);

    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.spies.setRoom).not.toHaveBeenCalled();
  });

  it("re-arms for a rejoined room when a stale timer from the left room is pending", () => {
    let current: Room = {} as Room;
    const h = build({ getRoom: () => current });

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(3000);
    current = h.room as unknown as Room; // left, then rejoined into a new room
    vi.advanceTimersByTime(2000);
    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS - 1);
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expectConsole("warn", /LiveKit resume stalled/);
    expect(h.spies.attemptAutoReconnect).toHaveBeenCalled();
  });

  it("stays out of the way when there is no token to reconnect with", () => {
    const h = build({ getLatestToken: () => null });

    h.handlers.handleSdkReconnecting();
    vi.advanceTimersByTime(BUDGET_MS);

    expectConsole("warn", /LiveKit resume stalled/);
    expect(h.spies.attemptAutoReconnect).not.toHaveBeenCalled();
    expect(h.room.disconnect).not.toHaveBeenCalled();
    expect(h.spies.leaveVoice).not.toHaveBeenCalled();
  });
});
