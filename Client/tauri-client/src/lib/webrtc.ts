// =============================================================================
// WebRTC Service — peer connection management for voice communication
// =============================================================================

import { createLogger } from "@lib/logger";

const log = createLogger("webrtc");

export interface WebRtcConfig {
  readonly iceServers: readonly RTCIceServer[];
  readonly opusBitrate?: number;
}

export interface WebRtcService {
  createConnection(config: WebRtcConfig): void;
  handleOffer(sdp: string): Promise<string>;
  handleAnswer(sdp: string): Promise<void>;
  handleServerOffer(sdp: string): Promise<string>;
  createOffer(iceRestart?: boolean): Promise<string>;
  handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  /** Add a video track to the PeerConnection. Returns the sender for removal. */
  addVideoTrack(stream: MediaStream): RTCRtpSender | null;
  /** Remove the video track sender from the PeerConnection. */
  removeVideoTrack(sender: RTCRtpSender): void;
  setLocalStream(stream: MediaStream): void;
  /** Swap the media track on existing senders without SDP renegotiation. */
  replaceTrack(stream: MediaStream): Promise<void>;
  getRemoteStreams(): readonly MediaStream[];
  setMuted(muted: boolean): void;
  setSilenced(silenced: boolean): void;
  onIceCandidate(callback: (candidate: RTCIceCandidateInit) => void): () => void;
  onRemoteTrack(callback: (stream: MediaStream) => void): () => void;
  onStateChange(callback: (state: RTCPeerConnectionState) => void): () => void;
  onIceStateChange(callback: (state: RTCIceConnectionState) => void): () => void;
  destroy(): void;
}

type IceCandidateCallback = (candidate: RTCIceCandidateInit) => void;
type RemoteTrackCallback = (stream: MediaStream) => void;
type StateChangeCallback = (state: RTCPeerConnectionState) => void;
type IceStateCallback = (state: RTCIceConnectionState) => void;

/** Apply Opus bitrate and FEC constraints via SDP munging. */
function applyOpusSettings(sdp: string, bitrate: number | undefined): string {
  const lines = sdp.split("\r\n");
  const result: string[] = [];
  let inAudioSection = false;
  let bitrateInserted = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line === undefined) continue;

    // Track which media section we're in
    if (line.startsWith("m=audio")) {
      inAudioSection = true;
      bitrateInserted = false;
    } else if (line.startsWith("m=")) {
      inAudioSection = false;
    }

    // Enable Opus in-band FEC for packet loss resilience
    if (line.startsWith("a=fmtp:111 ")) {
      if (!line.includes("useinbandfec=")) {
        line += ";useinbandfec=1";
      }
    }

    result.push(line);

    // Insert b=AS after m=audio line (always present, unlike c= which may
    // only exist at session level)
    if (inAudioSection && !bitrateInserted && bitrate !== undefined && line.startsWith("m=audio")) {
      result.push(`b=AS:${Math.round(bitrate / 1000)}`);
      bitrateInserted = true;
    }
  }
  return result.join("\r\n");
}

export function createWebRtcService(): WebRtcService {
  let pc: RTCPeerConnection | null = null;
  let localSenders: readonly RTCRtpSender[] = [];
  let isMuted = false;
  let isSilenced = false;
  let remoteStreams: readonly MediaStream[] = [];
  let opusBitrate: number | undefined;
  let destroyed = false;
  /** True once setRemoteDescription has been called (ICE candidates are safe). */
  let hasRemoteDescription = false;
  /** Queue ICE candidates that arrive before the remote description is set. */
  const pendingIceCandidates: RTCIceCandidateInit[] = [];

  const iceCandidateCallbacks = new Set<IceCandidateCallback>();
  const remoteTrackCallbacks = new Set<RemoteTrackCallback>();
  const stateChangeCallbacks = new Set<StateChangeCallback>();
  const iceStateCallbacks = new Set<IceStateCallback>();

  function assertConnection(): RTCPeerConnection {
    if (destroyed) throw new Error("WebRTC service has been destroyed");
    if (pc === null) throw new Error("No peer connection created");
    return pc;
  }

  /** Flush queued ICE candidates now that the remote description is set. */
  async function flushIceCandidates(conn: RTCPeerConnection): Promise<void> {
    hasRemoteDescription = true;
    const queued = pendingIceCandidates.splice(0);
    if (queued.length > 0) {
      log.debug("Flushing queued ICE candidates", { count: queued.length });
    }
    for (const c of queued) {
      await conn.addIceCandidate(c);
    }
  }

  /** Apply track.enabled based on current mute + silence state. */
  function applyTrackEnabled(): void {
    for (const sender of localSenders) {
      const track = sender.track;
      if (track !== null) {
        track.enabled = !isMuted && !isSilenced;
      }
    }
  }

  function handleIceCandidateEvent(event: RTCPeerConnectionIceEvent): void {
    if (event.candidate === null) {
      log.debug("ICE gathering complete");
      return;
    }
    const c = event.candidate;
    log.debug("Local ICE candidate", {
      type: c.type,
      address: c.address,
      port: c.port,
      protocol: c.protocol,
      candidate: c.candidate,
    });
    const init: RTCIceCandidateInit = {
      candidate: c.candidate,
      sdpMid: c.sdpMid,
      sdpMLineIndex: c.sdpMLineIndex,
    };
    for (const cb of iceCandidateCallbacks) {
      cb(init);
    }
  }

  function handleTrackEvent(event: RTCTrackEvent): void {
    const stream = event.streams[0];
    if (stream === undefined) {
      log.warn("Remote track event with no stream");
      return;
    }
    const isNew = !remoteStreams.some((s) => s.id === stream.id);
    if (isNew) {
      remoteStreams = [...remoteStreams, stream];
    }
    log.info("Remote track received", {
      streamId: stream.id,
      trackId: event.track.id,
      kind: event.track.kind,
      isNew,
      totalStreams: remoteStreams.length,
    });
    // Always notify — renegotiation may add new tracks to existing
    // streams (e.g. after leave/rejoin with the same stream ID).
    for (const cb of remoteTrackCallbacks) {
      cb(stream);
    }
  }

  function handleConnectionStateChange(): void {
    if (pc === null) return;
    const state = pc.connectionState;
    for (const cb of stateChangeCallbacks) {
      cb(state);
    }
  }

  function handleIceConnectionStateChange(): void {
    if (pc === null) return;
    const state = pc.iceConnectionState;
    for (const cb of iceStateCallbacks) {
      cb(state);
    }
  }

  function handleNegotiationNeeded(): void {
    // Log canary — if this fires, something triggered SDP renegotiation
    // that our explicit offer/answer flow didn't handle. Upgrade to a
    // full handler (auto-create offer) if this shows up in production.
    log.warn("negotiationneeded fired unexpectedly", { signalingState: pc?.signalingState ?? "none" });
  }

  function mungeIfNeeded(sdp: string | undefined): string {
    if (sdp === undefined) return "";
    return applyOpusSettings(sdp, opusBitrate);
  }

  return {
    createConnection(config: WebRtcConfig): void {
      if (destroyed) throw new Error("WebRTC service has been destroyed");
      if (pc !== null) {
        pc.close();
      }
      opusBitrate = config.opusBitrate;
      remoteStreams = [];
      localSenders = [];
      isMuted = false;
      isSilenced = false;
      hasRemoteDescription = false;
      pendingIceCandidates.length = 0;

      pc = new RTCPeerConnection({
        iceServers: [...config.iceServers],
      });
      pc.addEventListener("icecandidate", handleIceCandidateEvent);
      pc.addEventListener("track", handleTrackEvent);
      pc.addEventListener("connectionstatechange", handleConnectionStateChange);
      pc.addEventListener("iceconnectionstatechange", handleIceConnectionStateChange);
      pc.addEventListener("negotiationneeded", handleNegotiationNeeded);
      log.info("PeerConnection created", {
        iceServerCount: config.iceServers.length,
        opusBitrate: config.opusBitrate,
      });
    },

    async handleOffer(sdp: string): Promise<string> {
      const conn = assertConnection();
      await conn.setRemoteDescription({ type: "offer", sdp });
      await flushIceCandidates(conn);
      const answer = await conn.createAnswer();
      const mungedSdp = mungeIfNeeded(answer.sdp);
      await conn.setLocalDescription({ type: "answer", sdp: mungedSdp });
      return mungedSdp;
    },

    async handleAnswer(sdp: string): Promise<void> {
      const conn = assertConnection();
      await conn.setRemoteDescription({ type: "answer", sdp });
      await flushIceCandidates(conn);
    },

    async handleServerOffer(sdp: string): Promise<string> {
      const conn = assertConnection();
      if (conn.signalingState === "have-local-offer") {
        log.info("Rolling back local offer for server renegotiation (glare)");
        await conn.setLocalDescription({ type: "rollback" });
      }
      await conn.setRemoteDescription({ type: "offer", sdp });
      await flushIceCandidates(conn);
      const answer = await conn.createAnswer();
      const mungedSdp = mungeIfNeeded(answer.sdp);
      await conn.setLocalDescription({ type: "answer", sdp: mungedSdp });
      return mungedSdp;
    },

    async createOffer(iceRestart = false): Promise<string> {
      const conn = assertConnection();
      const offer = await conn.createOffer({ iceRestart });
      const mungedSdp = mungeIfNeeded(offer.sdp);
      await conn.setLocalDescription({ type: "offer", sdp: mungedSdp });
      return mungedSdp;
    },

    async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
      const conn = assertConnection();
      if (!hasRemoteDescription) {
        pendingIceCandidates.push(candidate);
        log.debug("ICE candidate queued (no remote description yet)", { queueDepth: pendingIceCandidates.length });
        return;
      }
      await conn.addIceCandidate(candidate);
    },

    setLocalStream(stream: MediaStream): void {
      const conn = assertConnection();
      const removedCount = localSenders.length;
      for (const sender of localSenders) {
        conn.removeTrack(sender);
      }

      const newSenders = stream.getTracks().map((track) => conn.addTrack(track, stream));
      localSenders = newSenders;

      // Apply current mute/silence state to new tracks
      applyTrackEnabled();
      log.debug("Local stream set", { removedSenders: removedCount, addedTracks: newSenders.length });
    },

    async replaceTrack(stream: MediaStream): Promise<void> {
      assertConnection();
      const newTracks = stream.getAudioTracks();
      if (newTracks.length === 0) {
        log.warn("replaceTrack called with no audio tracks");
        return;
      }
      const newTrack = newTracks[0]!;

      if (localSenders.length > 0) {
        // Swap track on existing sender — no SDP renegotiation needed
        for (const sender of localSenders) {
          await sender.replaceTrack(newTrack);
        }
        log.debug("Track replaced on existing senders", { senderCount: localSenders.length, trackId: newTrack.id });
      } else {
        // No existing senders — fall back to addTrack (initial attach)
        log.debug("replaceTrack fallback: no senders, using addTrack");
        const conn = assertConnection();
        const newSenders = stream.getTracks().map((track) => conn.addTrack(track, stream));
        localSenders = newSenders;
      }

      // Apply current mute/silence state to the new track
      applyTrackEnabled();
    },

    addVideoTrack(stream: MediaStream): RTCRtpSender | null {
      const conn = assertConnection();
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack === undefined) {
        log.warn("addVideoTrack called with no video tracks");
        return null;
      }
      const sender = conn.addTrack(videoTrack, stream);
      log.info("Video track added to PeerConnection", { trackId: videoTrack.id });
      return sender;
    },

    removeVideoTrack(sender: RTCRtpSender): void {
      const conn = assertConnection();
      conn.removeTrack(sender);
      log.info("Video track removed from PeerConnection");
    },

    getRemoteStreams(): readonly MediaStream[] {
      return remoteStreams;
    },

    setMuted(muted: boolean): void {
      isMuted = muted;
      applyTrackEnabled();
    },

    setSilenced(silenced: boolean): void {
      isSilenced = silenced;
      applyTrackEnabled();
    },

    onIceCandidate(callback: IceCandidateCallback): () => void {
      iceCandidateCallbacks.add(callback);
      return () => { iceCandidateCallbacks.delete(callback); };
    },

    onRemoteTrack(callback: RemoteTrackCallback): () => void {
      remoteTrackCallbacks.add(callback);
      return () => { remoteTrackCallbacks.delete(callback); };
    },

    onStateChange(callback: StateChangeCallback): () => void {
      stateChangeCallbacks.add(callback);
      return () => { stateChangeCallbacks.delete(callback); };
    },

    onIceStateChange(callback: IceStateCallback): () => void {
      iceStateCallbacks.add(callback);
      return () => { iceStateCallbacks.delete(callback); };
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      log.debug("WebRTC service destroying", { remoteStreams: remoteStreams.length, localSenders: localSenders.length });
      if (pc !== null) {
        pc.removeEventListener("icecandidate", handleIceCandidateEvent);
        pc.removeEventListener("track", handleTrackEvent);
        pc.removeEventListener("connectionstatechange", handleConnectionStateChange);
        pc.removeEventListener("iceconnectionstatechange", handleIceConnectionStateChange);
        pc.removeEventListener("negotiationneeded", handleNegotiationNeeded);
        pc.close();
        pc = null;
      }
      localSenders = [];
      remoteStreams = [];
      pendingIceCandidates.length = 0;
      iceCandidateCallbacks.clear();
      remoteTrackCallbacks.clear();
      stateChangeCallbacks.clear();
      iceStateCallbacks.clear();
    },
  };
}
