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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DisconnectReason, Track } from "livekit-client";
import type {
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
} from "livekit-client";

import { createRoomEventHandlers } from "@lib/roomEventHandlers";
import type { RoomEventDeps } from "@lib/roomEventHandlers";
import { voiceStore } from "@stores/voice.store";
import type { VoiceUser } from "@stores/voice.store";
import type { AudioElements } from "@lib/audioElements";

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
    removeAllListeners: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  };
  spies: {
    applyMicMuteState: ReturnType<typeof vi.fn>;
    attemptAutoReconnect: ReturnType<typeof vi.fn>;
    teardownForReconnect: ReturnType<typeof vi.fn>;
    leaveVoice: ReturnType<typeof vi.fn>;
    setRoom: ReturnType<typeof vi.fn>;
    setReconnectAc: ReturnType<typeof vi.fn>;
    syncModuleRooms: ReturnType<typeof vi.fn>;
    onRemoteVideo: ReturnType<typeof vi.fn>;
    onRemoteVideoRemoved: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
  };
}

function build(over: Partial<RoomEventDeps> = {}): Harness {
  const audioElements = fakeAudioElements();
  const room = {
    canPlaybackAudio: true,
    startAudio: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  const spies = {
    applyMicMuteState: vi.fn().mockResolvedValue(undefined),
    attemptAutoReconnect: vi.fn().mockResolvedValue(undefined),
    teardownForReconnect: vi.fn(),
    leaveVoice: vi.fn(),
    setRoom: vi.fn(),
    setReconnectAc: vi.fn(),
    syncModuleRooms: vi.fn(),
    onRemoteVideo: vi.fn(),
    onRemoteVideoRemoved: vi.fn(),
    onError: vi.fn(),
  };

  const deps: RoomEventDeps = {
    getRoom: () => room as unknown as Room,
    setRoom: spies.setRoom,
    getCurrentChannelId: () => 12,
    getAudioElements: () => audioElements,
    getOnRemoteVideoCallback: () => spies.onRemoteVideo,
    getOnRemoteVideoRemovedCallback: () => spies.onRemoteVideoRemoved,
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
  voiceStore.setState((prev) => ({ ...prev, localMuted: false, localDeafened: false }));
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

  it("detaches the video element and notifies the removal callback", () => {
    const h = build();
    const track = videoTrack();

    h.handlers.handleTrackUnsubscribed(track, pub(Track.Source.Camera), participant("user-9:tok"));

    // Without detach the <video> keeps the old MediaStream and the tile freezes
    // on the last frame instead of clearing.
    expect(track.detach).toHaveBeenCalled();
    expect(h.spies.onRemoteVideoRemoved).toHaveBeenCalledWith(9, false);
  });

  it("flags screenshare removal as such", () => {
    const h = build();

    h.handlers.handleTrackUnsubscribed(
      videoTrack(),
      pub(Track.Source.ScreenShare),
      participant("user-9:tok"),
    );

    expect(h.spies.onRemoteVideoRemoved).toHaveBeenCalledWith(9, true);
  });

  it("still detaches when the identity is unparseable", () => {
    const h = build();
    const track = videoTrack();

    h.handlers.handleTrackUnsubscribed(track, pub(Track.Source.Camera), participant("garbage"));

    expect(track.detach).toHaveBeenCalled();
    expect(h.spies.onRemoteVideoRemoved).not.toHaveBeenCalled();
  });

  it("tolerates a missing removal callback", () => {
    const h = build({ getOnRemoteVideoRemovedCallback: () => null });

    expect(() => {
      h.handlers.handleTrackUnsubscribed(
        videoTrack(),
        pub(Track.Source.Camera),
        participant("user-9:tok"),
      );
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
  });

  it("removeAutoplayUnlock drops the pending listener", () => {
    const h = build();
    h.room.canPlaybackAudio = false;
    h.handlers.handleAudioPlaybackChanged();

    h.handlers.removeAutoplayUnlock();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true }));

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

    expect(h.room.startAudio).not.toHaveBeenCalled();
  });

  it("the unlock handler tolerates the room disappearing first", () => {
    let room: Room | null = { canPlaybackAudio: false } as unknown as Room;
    const h = build({ getRoom: () => room });

    h.handlers.handleAudioPlaybackChanged();
    room = null; // user left voice before clicking

    expect(() => {
      document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }).not.toThrow();
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

    h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);

    expect(h.spies.teardownForReconnect).toHaveBeenCalled();
    expect(h.audioElements.cleanupAllAudioElements).toHaveBeenCalled();
    expect(h.spies.setRoom).toHaveBeenCalledWith(null);
    expect(h.spies.syncModuleRooms).toHaveBeenCalled();
    expect(h.room.removeAllListeners).toHaveBeenCalled();
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
  });

  it("tolerates a missing error callback", () => {
    const h = build({ getLatestToken: () => null, getOnErrorCallback: () => null });

    expect(() => {
      h.handlers.handleDisconnected(DisconnectReason.SERVER_SHUTDOWN);
    }).not.toThrow();
  });
});
