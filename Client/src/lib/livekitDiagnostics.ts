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

/**
 * Resolve the publisher/subscriber PCTransports LiveKit's engine currently
 * has. In livekit-client 2.x these live on `engine.pcManager`, not directly
 * on `engine` (PCTransportManager.d.ts) — see connectionStats.ts, which reads
 * the same transports the same way.
 *
 * Deliberately typed through inference rather than `Record<string, unknown>`
 * casts: PCTransport is `@internal` and not exported from the package root,
 * so it can't be named, but its public getters (used below) still make an
 * SDK shape change a build error instead of a silent no-op. This also keeps
 * us off `PCTransport.pc` — a private getter that *creates* a peer
 * connection on first read when none exists yet, a side effect a passive
 * diagnostic must never trigger.
 */
function getIceTransports(room: Room): Array<{
  label: "subscriber" | "publisher";
  transport: NonNullable<NonNullable<Room["engine"]>["pcManager"]>["publisher"];
}> {
  const pcManager = room.engine?.pcManager;
  const transports: Array<{
    label: "subscriber" | "publisher";
    transport: NonNullable<NonNullable<Room["engine"]>["pcManager"]>["publisher"];
  }> = [];
  if (!pcManager) return transports;
  if (pcManager.subscriber)
    transports.push({ label: "subscriber", transport: pcManager.subscriber });
  if (pcManager.publisher) transports.push({ label: "publisher", transport: pcManager.publisher });
  return transports;
}

/** Log ICE connection details for debugging cross-network voice issues. */
export function logIceConnectionInfo(room: Room | null): void {
  if (room === null) return;
  try {
    for (const { label, transport } of getIceTransports(room)) {
      log.info(`ICE ${label} connection state`, {
        iceConnectionState: transport.getICEConnectionState(),
        connectionState: transport.getConnectionState(),
        signalingState: transport.getSignallingState(),
      });

      // Log selected candidate pair
      transport
        .getStats()
        ?.then((stats) => {
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
    if (!room.engine) return null;
    const result: Record<string, unknown> = {};
    for (const { label, transport } of getIceTransports(room)) {
      result[label] = {
        iceConnectionState: transport.getICEConnectionState(),
        connectionState: transport.getConnectionState(),
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
