// LiveKit diagnostics — ICE connection logging and session debug info
import type { Room } from "livekit-client";
import { RoomEvent, Track } from "livekit-client";
import { createLogger } from "@lib/logger";
import { parseUserId } from "@lib/livekitSession";
import type { AudioPipeline } from "@lib/audioPipeline";
import type { AudioElements } from "@lib/audioElements";

const log = createLogger("livekitDiagnostics");

/** Attach lightweight diagnostic-only event listeners to a Room. */
export function attachDiagnosticListeners(room: Room): void {
  room.on(RoomEvent.Reconnecting, () => {
    log.warn("LiveKit room reconnecting");
  });
  room.on(RoomEvent.Reconnected, () => {
    log.info("LiveKit room reconnected");
  });
  room.on(RoomEvent.SignalReconnecting, () => {
    log.debug("LiveKit signal reconnecting");
  });
  room.on(RoomEvent.MediaDevicesError, (error: Error) => {
    log.error("LiveKit media device error", { error: error.message });
  });
  room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
    if (participant.isLocal) {
      log.debug("Local connection quality changed", { quality });
    }
  });
}

// --- ICE helpers (no instance state) ---

/** Log ICE connection details for debugging cross-network voice issues. */
export function logIceConnectionInfo(room: Room | null): void {
  if (room === null) return;
  // Access the underlying RTCPeerConnection via LiveKit's engine.
  // LiveKit exposes the PeerConnection via room.engine.subscriber/publisher.
  try {
    const engine = (room as unknown as Record<string, unknown>).engine as
      | Record<string, unknown>
      | undefined;
    if (!engine) return;

    const subscriber = engine.subscriber as Record<string, unknown> | undefined;
    const publisher = engine.publisher as Record<string, unknown> | undefined;
    const pcs: Array<{ label: string; pc: RTCPeerConnection }> = [];
    if (subscriber?.pc) pcs.push({ label: "subscriber", pc: subscriber.pc as RTCPeerConnection });
    if (publisher?.pc) pcs.push({ label: "publisher", pc: publisher.pc as RTCPeerConnection });

    for (const { label, pc } of pcs) {
      log.info(`ICE ${label} connection state`, {
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        connectionState: pc.connectionState,
        signalingState: pc.signalingState,
      });

      // Log selected candidate pair
      pc.getStats()
        .then((stats) => {
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.state === "succeeded") {
              const localId = report.localCandidateId;
              const remoteId = report.remoteCandidateId;
              let localType = "unknown";
              let remoteType = "unknown";
              let localProtocol = "unknown";

              stats.forEach((s) => {
                if (s.id === localId && s.type === "local-candidate") {
                  localType = s.candidateType ?? "unknown";
                  localProtocol = s.protocol ?? "unknown";
                }
                if (s.id === remoteId && s.type === "remote-candidate") {
                  remoteType = s.candidateType ?? "unknown";
                }
              });

              log.info(`ICE ${label} selected candidate pair`, {
                localType,
                remoteType,
                localProtocol,
              });
            }
          });
        })
        .catch((err) => {
          log.debug("Failed to get ICE stats", { error: String(err) });
        });
    }
  } catch (err) {
    log.debug("Failed to access ICE connection info", { error: String(err) });
  }
}

/** Get ICE connection state summary for debug panel. */
export function getIceConnectionState(room: Room | null): Record<string, unknown> | null {
  if (room === null) return null;
  try {
    const engine = (room as unknown as Record<string, unknown>).engine as
      | Record<string, unknown>
      | undefined;
    if (!engine) return null;
    const subscriber = engine.subscriber as Record<string, unknown> | undefined;
    const publisher = engine.publisher as Record<string, unknown> | undefined;
    const result: Record<string, unknown> = {};
    if (subscriber?.pc) {
      const pc = subscriber.pc as RTCPeerConnection;
      result.subscriber = {
        iceConnectionState: pc.iceConnectionState,
        connectionState: pc.connectionState,
      };
    }
    if (publisher?.pc) {
      const pc = publisher.pc as RTCPeerConnection;
      result.publisher = {
        iceConnectionState: pc.iceConnectionState,
        connectionState: pc.connectionState,
      };
    }
    return result;
  } catch {
    return null;
  }
}

// --- Debug info ---

export interface SessionDebugDeps {
  readonly room: Room | null;
  readonly currentChannelId: number | null;
  readonly outputVolumeMultiplier: number;
  readonly audioPipeline: AudioPipeline;
  readonly audioElements: AudioElements;
}

export function buildSessionDebugInfo(deps: SessionDebugDeps): Record<string, unknown> {
  const { room, currentChannelId, outputVolumeMultiplier, audioPipeline, audioElements } = deps;
  if (room === null) {
    return { hasRoom: false, hasRNNoiseProcessor: false, currentChannelId };
  }
  const remoteParticipants = [...room.remoteParticipants.values()].map((p) => {
    const userId = parseUserId(p.identity);
    return {
      identity: p.identity,
      userId,
      volume: p.getVolume(),
      effectiveVolume: audioElements.getEffectiveVolume(userId),
      tracks: [...p.trackPublications.values()].map((pub) => ({
        sid: pub.trackSid,
        source: pub.source,
        kind: pub.kind,
        subscribed: pub.isSubscribed,
        enabled: pub.isEnabled,
      })),
    };
  });
  const localTracks = [...room.localParticipant.trackPublications.values()].map((pub) => ({
    sid: pub.trackSid,
    source: pub.source,
    kind: pub.kind,
    isMuted: pub.isMuted,
  }));
  return {
    hasRoom: true,
    roomName: room.name,
    roomState: room.state,
    hasRNNoiseProcessor:
      room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.getProcessor() !==
      undefined,
    currentChannelId,
    outputVolumeMultiplier,
    audioPipelineActive: audioPipeline.isActive,
    audioPipelineGain: audioPipeline.gainValue,
    audioPipelineCtxState: audioPipeline.ctxState,
    vadGated: audioPipeline.isVadGated,
    currentInputGain: audioPipeline.inputGain,
    localParticipant: room.localParticipant.identity,
    localTracks,
    remoteParticipants,
    iceConnectionState: getIceConnectionState(room),
  };
}
