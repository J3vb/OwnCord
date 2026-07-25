/**
 * Tests for src/lib/livekitDiagnostics.ts (was 30.4% statements, no test file).
 *
 * This module is what an operator reads when a voice call fails to connect, so
 * a diagnostic that silently returns nothing — or worse, throws while poking at
 * LiveKit's private `engine` field — makes a hard bug harder. Every function
 * here reaches through `room as unknown as Record<string, unknown>` into
 * internals that can disappear on a LiveKit upgrade, so the defensive paths
 * matter more than the happy path.
 */

import { describe, expect, it, vi } from "vitest";
import { RoomEvent } from "livekit-client";
import type { Room } from "livekit-client";

import {
  attachDiagnosticListeners,
  buildSessionDebugInfo,
  getIceConnectionState,
  logIceConnectionInfo,
} from "@lib/livekitDiagnostics";
import type { SessionDebugDeps } from "@lib/livekitDiagnostics";
import type { AudioPipeline } from "@lib/audioPipeline";
import type { AudioElements } from "@lib/audioElements";

// ── fakes ──────────────────────────────────────────────────────────────────

/** A Room stub that records `on` registrations so they can be fired by name. */
function fakeRoom(extra: Record<string, unknown> = {}): {
  room: Room;
  handlers: Map<string, (...args: unknown[]) => void>;
} {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const room = {
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, cb);
      return this;
    },
    ...extra,
  } as unknown as Room;
  return { room, handlers };
}

function fakePeerConnection(over: Partial<RTCPeerConnection> = {}): RTCPeerConnection {
  return {
    iceConnectionState: "connected",
    iceGatheringState: "complete",
    connectionState: "connected",
    signalingState: "stable",
    getStats: vi.fn().mockResolvedValue(new Map()),
    ...over,
  } as unknown as RTCPeerConnection;
}

/** Builds an engine object shaped the way the module expects to find it. */
function withEngine(subscriberPc?: RTCPeerConnection, publisherPc?: RTCPeerConnection): Room {
  return {
    engine: {
      ...(subscriberPc !== undefined ? { subscriber: { pc: subscriberPc } } : {}),
      ...(publisherPc !== undefined ? { publisher: { pc: publisherPc } } : {}),
    },
  } as unknown as Room;
}

function fakePipeline(over: Partial<AudioPipeline> = {}): AudioPipeline {
  return {
    isActive: true,
    gainValue: 1,
    ctxState: "running",
    isVadGated: false,
    inputGain: 1,
    ...over,
  } as unknown as AudioPipeline;
}

function fakeElements(effectiveVolume = 1): AudioElements {
  return { getEffectiveVolume: () => effectiveVolume } as unknown as AudioElements;
}

// ── attachDiagnosticListeners ──────────────────────────────────────────────

describe("attachDiagnosticListeners", () => {
  it("registers every diagnostic room event", () => {
    const { room, handlers } = fakeRoom();

    attachDiagnosticListeners(room);

    for (const event of [
      RoomEvent.Reconnecting,
      RoomEvent.Reconnected,
      RoomEvent.SignalReconnecting,
      RoomEvent.MediaDevicesError,
      RoomEvent.ConnectionQualityChanged,
    ]) {
      expect(handlers.has(event), `missing handler for ${event}`).toBe(true);
    }
  });

  it("handlers run without throwing", () => {
    const { room, handlers } = fakeRoom();
    attachDiagnosticListeners(room);

    expect(() => {
      handlers.get(RoomEvent.Reconnecting)?.();
      handlers.get(RoomEvent.Reconnected)?.();
      handlers.get(RoomEvent.SignalReconnecting)?.();
      handlers.get(RoomEvent.MediaDevicesError)?.(new Error("no mic"));
      handlers.get(RoomEvent.ConnectionQualityChanged)?.("excellent", { isLocal: true });
      handlers.get(RoomEvent.ConnectionQualityChanged)?.("poor", { isLocal: false });
    }).not.toThrow();
  });
});

// ── logIceConnectionInfo ───────────────────────────────────────────────────

describe("logIceConnectionInfo", () => {
  it("is a no-op for a null room", () => {
    expect(() => {
      logIceConnectionInfo(null);
    }).not.toThrow();
  });

  it("is a no-op when the engine is absent", () => {
    expect(() => {
      logIceConnectionInfo({} as unknown as Room);
    }).not.toThrow();
  });

  it("is a no-op when the engine has neither peer connection", () => {
    expect(() => {
      logIceConnectionInfo({ engine: {} } as unknown as Room);
    }).not.toThrow();
  });

  it("reads stats from both peer connections", () => {
    const sub = fakePeerConnection();
    const pub = fakePeerConnection();

    logIceConnectionInfo(withEngine(sub, pub));

    expect(sub.getStats).toHaveBeenCalled();
    expect(pub.getStats).toHaveBeenCalled();
  });

  it("resolves the selected candidate pair from the stats report", async () => {
    const stats = new Map<string, Record<string, unknown>>([
      [
        "pair1",
        {
          id: "pair1",
          type: "candidate-pair",
          state: "succeeded",
          localCandidateId: "lc1",
          remoteCandidateId: "rc1",
        },
      ],
      ["lc1", { id: "lc1", type: "local-candidate", candidateType: "srflx", protocol: "udp" }],
      ["rc1", { id: "rc1", type: "remote-candidate", candidateType: "relay" }],
    ]);
    const getStats = vi.fn().mockResolvedValue(stats);

    logIceConnectionInfo(withEngine(fakePeerConnection({ getStats } as never)));
    await vi.waitFor(() => {
      expect(getStats).toHaveBeenCalled();
    });
  });

  it("tolerates candidate ids that resolve to nothing", async () => {
    // A pair referencing candidates absent from the report leaves the types as
    // "unknown" rather than throwing.
    const stats = new Map<string, Record<string, unknown>>([
      [
        "pair1",
        {
          id: "pair1",
          type: "candidate-pair",
          state: "succeeded",
          localCandidateId: "missing",
          remoteCandidateId: "also-missing",
        },
      ],
    ]);
    const getStats = vi.fn().mockResolvedValue(stats);

    expect(() => {
      logIceConnectionInfo(withEngine(fakePeerConnection({ getStats } as never)));
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(getStats).toHaveBeenCalled();
    });
  });

  it("swallows a rejected getStats", async () => {
    const getStats = vi.fn().mockRejectedValue(new Error("pc closed"));

    expect(() => {
      logIceConnectionInfo(withEngine(fakePeerConnection({ getStats } as never)));
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(getStats).toHaveBeenCalled();
    });
  });

  it("swallows a throwing engine getter", () => {
    const room = {
      get engine(): unknown {
        throw new Error("internals moved");
      },
    } as unknown as Room;

    // The whole point of the try/catch: a LiveKit upgrade that renames or
    // guards `engine` must not take the voice session down with it.
    expect(() => {
      logIceConnectionInfo(room);
    }).not.toThrow();
  });
});

// ── getIceConnectionState ──────────────────────────────────────────────────

describe("getIceConnectionState", () => {
  it("returns null for a null room", () => {
    expect(getIceConnectionState(null)).toBeNull();
  });

  it("returns null when the engine is absent", () => {
    expect(getIceConnectionState({} as unknown as Room)).toBeNull();
  });

  it("returns an empty object when the engine has no peer connections", () => {
    expect(getIceConnectionState({ engine: {} } as unknown as Room)).toEqual({});
  });

  it("reports both peer connections", () => {
    const got = getIceConnectionState(
      withEngine(
        fakePeerConnection({ iceConnectionState: "checking", connectionState: "connecting" }),
        fakePeerConnection({ iceConnectionState: "connected", connectionState: "connected" }),
      ),
    );

    expect(got).toEqual({
      subscriber: { iceConnectionState: "checking", connectionState: "connecting" },
      publisher: { iceConnectionState: "connected", connectionState: "connected" },
    });
  });

  it("reports only the peer connection that exists", () => {
    const got = getIceConnectionState(withEngine(fakePeerConnection()));

    expect(got).toHaveProperty("subscriber");
    expect(got).not.toHaveProperty("publisher");
  });

  it("returns null when reaching into internals throws", () => {
    const room = {
      get engine(): unknown {
        throw new Error("internals moved");
      },
    } as unknown as Room;

    expect(getIceConnectionState(room)).toBeNull();
  });
});

// ── buildSessionDebugInfo ──────────────────────────────────────────────────

describe("buildSessionDebugInfo", () => {
  const baseDeps: Omit<SessionDebugDeps, "room"> = {
    currentChannelId: 12,
    outputVolumeMultiplier: 1.5,
    audioPipeline: fakePipeline(),
    audioElements: fakeElements(),
  };

  it("returns the minimal shape when there is no room", () => {
    const got = buildSessionDebugInfo({ ...baseDeps, room: null });

    expect(got).toEqual({ hasRoom: false, hasRNNoiseProcessor: false, currentChannelId: 12 });
  });

  it("summarises an active room", () => {
    const room = {
      name: "channel-12",
      state: "connected",
      remoteParticipants: new Map(),
      localParticipant: {
        identity: "user-1:tok",
        trackPublications: new Map(),
        getTrackPublication: () => undefined,
      },
      engine: {},
    } as unknown as Room;

    const got = buildSessionDebugInfo({ ...baseDeps, room });

    expect(got.hasRoom).toBe(true);
    expect(got.roomName).toBe("channel-12");
    expect(got.roomState).toBe("connected");
    expect(got.currentChannelId).toBe(12);
    expect(got.outputVolumeMultiplier).toBe(1.5);
    expect(got.localParticipant).toBe("user-1:tok");
    expect(got.audioPipelineActive).toBe(true);
    expect(got.audioPipelineGain).toBe(1);
    expect(got.audioPipelineCtxState).toBe("running");
    expect(got.vadGated).toBe(false);
    expect(got.currentInputGain).toBe(1);
    expect(got.hasRNNoiseProcessor).toBe(false);
  });

  it("reports hasRNNoiseProcessor when the mic track carries a processor", () => {
    const room = {
      name: "r",
      state: "connected",
      remoteParticipants: new Map(),
      localParticipant: {
        identity: "user-1",
        trackPublications: new Map(),
        getTrackPublication: () => ({ track: { getProcessor: () => ({ name: "rnnoise" }) } }),
      },
      engine: {},
    } as unknown as Room;

    expect(buildSessionDebugInfo({ ...baseDeps, room }).hasRNNoiseProcessor).toBe(true);
  });

  it("maps remote participants, their volumes and their tracks", () => {
    const room = {
      name: "r",
      state: "connected",
      remoteParticipants: new Map([
        [
          "user-7:tok",
          {
            identity: "user-7:tok",
            getVolume: () => 0.8,
            trackPublications: new Map([
              [
                "sid1",
                {
                  trackSid: "sid1",
                  source: "microphone",
                  kind: "audio",
                  isSubscribed: true,
                  isEnabled: true,
                },
              ],
            ]),
          },
        ],
      ]),
      localParticipant: {
        identity: "user-1",
        trackPublications: new Map(),
        getTrackPublication: () => undefined,
      },
      engine: {},
    } as unknown as Room;

    const got = buildSessionDebugInfo({ ...baseDeps, room, audioElements: fakeElements(0.6) });
    const remotes = got.remoteParticipants as Array<Record<string, unknown>>;

    expect(remotes).toHaveLength(1);
    // The identity must be decoded to a numeric user id — the debug panel keys
    // per-user volume off it.
    expect(remotes[0]?.userId).toBe(7);
    expect(remotes[0]?.volume).toBe(0.8);
    expect(remotes[0]?.effectiveVolume).toBe(0.6);
    expect(remotes[0]?.tracks).toEqual([
      { sid: "sid1", source: "microphone", kind: "audio", subscribed: true, enabled: true },
    ]);
  });

  it("maps local track publications", () => {
    const room = {
      name: "r",
      state: "connected",
      remoteParticipants: new Map(),
      localParticipant: {
        identity: "user-1",
        trackPublications: new Map([
          ["a", { trackSid: "a", source: "microphone", kind: "audio", isMuted: false }],
          ["b", { trackSid: "b", source: "screen_share", kind: "video", isMuted: true }],
        ]),
        getTrackPublication: () => undefined,
      },
      engine: {},
    } as unknown as Room;

    expect(buildSessionDebugInfo({ ...baseDeps, room }).localTracks).toEqual([
      { sid: "a", source: "microphone", kind: "audio", isMuted: false },
      { sid: "b", source: "screen_share", kind: "video", isMuted: true },
    ]);
  });

  it("embeds the ICE state", () => {
    const room = {
      name: "r",
      state: "connected",
      remoteParticipants: new Map(),
      localParticipant: {
        identity: "user-1",
        trackPublications: new Map(),
        getTrackPublication: () => undefined,
      },
      engine: { subscriber: { pc: fakePeerConnection({ iceConnectionState: "failed" }) } },
    } as unknown as Room;

    expect(buildSessionDebugInfo({ ...baseDeps, room }).iceConnectionState).toEqual({
      subscriber: { iceConnectionState: "failed", connectionState: "connected" },
    });
  });

  it("carries a null channel id through", () => {
    const got = buildSessionDebugInfo({ ...baseDeps, room: null, currentChannelId: null });

    expect(got.currentChannelId).toBeNull();
  });
});
