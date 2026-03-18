// =============================================================================
// WebRTC Service — peer connection management for voice communication
// =============================================================================

export interface WebRtcConfig {
  readonly iceServers: readonly RTCIceServer[];
  readonly opusBitrate?: number;
}

export interface WebRtcService {
  createConnection(config: WebRtcConfig): void;
  handleOffer(sdp: string): Promise<string>;
  handleAnswer(sdp: string): Promise<void>;
  handleServerOffer(sdp: string): Promise<string>;
  createOffer(): Promise<string>;
  handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  setLocalStream(stream: MediaStream): void;
  getRemoteStreams(): readonly MediaStream[];
  setMuted(muted: boolean): void;
  onIceCandidate(callback: (candidate: RTCIceCandidateInit) => void): () => void;
  onRemoteTrack(callback: (stream: MediaStream) => void): () => void;
  onStateChange(callback: (state: RTCPeerConnectionState) => void): () => void;
  destroy(): void;
}

type IceCandidateCallback = (candidate: RTCIceCandidateInit) => void;
type RemoteTrackCallback = (stream: MediaStream) => void;
type StateChangeCallback = (state: RTCPeerConnectionState) => void;

/** Apply Opus bitrate constraint via SDP munging. */
function applyOpusBitrate(sdp: string, bitrate: number): string {
  const lines = sdp.split("\r\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    result.push(line);
    if (line.startsWith("a=fmtp:111 ")) {
      result.push(`b=AS:${Math.round(bitrate / 1000)}`);
    }
  }
  return result.join("\r\n");
}

export function createWebRtcService(): WebRtcService {
  let pc: RTCPeerConnection | null = null;
  let localSenders: readonly RTCRtpSender[] = [];
  /** Original tracks stored so we can restore them after unmute. */
  const mutedTracks = new Map<RTCRtpSender, MediaStreamTrack>();
  let remoteStreams: readonly MediaStream[] = [];
  let opusBitrate: number | undefined;
  let destroyed = false;

  const iceCandidateCallbacks = new Set<IceCandidateCallback>();
  const remoteTrackCallbacks = new Set<RemoteTrackCallback>();
  const stateChangeCallbacks = new Set<StateChangeCallback>();

  function assertConnection(): RTCPeerConnection {
    if (destroyed) throw new Error("WebRTC service has been destroyed");
    if (pc === null) throw new Error("No peer connection created");
    return pc;
  }

  function handleIceCandidateEvent(event: RTCPeerConnectionIceEvent): void {
    if (event.candidate === null) return;
    const init: RTCIceCandidateInit = {
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
    };
    for (const cb of iceCandidateCallbacks) {
      cb(init);
    }
  }

  function handleTrackEvent(event: RTCTrackEvent): void {
    const stream = event.streams[0];
    if (stream === undefined) return;
    // Only add if not already tracked
    if (remoteStreams.some((s) => s.id === stream.id)) return;
    remoteStreams = [...remoteStreams, stream];
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

  function mungeIfNeeded(sdp: string | undefined): string {
    if (sdp === undefined) return "";
    return opusBitrate !== undefined ? applyOpusBitrate(sdp, opusBitrate) : sdp;
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

      pc = new RTCPeerConnection({
        iceServers: [...config.iceServers],
      });
      pc.addEventListener("icecandidate", handleIceCandidateEvent);
      pc.addEventListener("track", handleTrackEvent);
      pc.addEventListener("connectionstatechange", handleConnectionStateChange);
    },

    async handleOffer(sdp: string): Promise<string> {
      const conn = assertConnection();
      await conn.setRemoteDescription({ type: "offer", sdp });
      const answer = await conn.createAnswer();
      const mungedSdp = mungeIfNeeded(answer.sdp);
      const finalAnswer: RTCSessionDescriptionInit = { type: "answer", sdp: mungedSdp };
      await conn.setLocalDescription(finalAnswer);
      return mungedSdp;
    },

    async handleAnswer(sdp: string): Promise<void> {
      const conn = assertConnection();
      await conn.setRemoteDescription({ type: "answer", sdp });
    },

    async handleServerOffer(sdp: string): Promise<string> {
      const conn = assertConnection();
      // Perfect Negotiation: client is "polite" peer.
      // If we have a pending local offer, rollback first.
      if (conn.signalingState === "have-local-offer") {
        await conn.setLocalDescription({ type: "rollback" });
      }
      await conn.setRemoteDescription({ type: "offer", sdp });
      const answer = await conn.createAnswer();
      const mungedSdp = mungeIfNeeded(answer.sdp);
      const finalAnswer: RTCSessionDescriptionInit = { type: "answer", sdp: mungedSdp };
      await conn.setLocalDescription(finalAnswer);
      return mungedSdp;
    },

    async createOffer(): Promise<string> {
      const conn = assertConnection();
      const offer = await conn.createOffer();
      const mungedSdp = mungeIfNeeded(offer.sdp);
      const finalOffer: RTCSessionDescriptionInit = { type: "offer", sdp: mungedSdp };
      await conn.setLocalDescription(finalOffer);
      return mungedSdp;
    },

    async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
      const conn = assertConnection();
      await conn.addIceCandidate(candidate);
    },

    setLocalStream(stream: MediaStream): void {
      const conn = assertConnection();
      // Remove existing senders
      for (const sender of localSenders) {
        conn.removeTrack(sender);
      }
      mutedTracks.clear();
      // Add all tracks from the new stream
      const newSenders = stream.getTracks().map((track) => conn.addTrack(track, stream));
      localSenders = newSenders;
    },

    getRemoteStreams(): readonly MediaStream[] {
      return remoteStreams;
    },

    setMuted(muted: boolean): void {
      for (const sender of localSenders) {
        if (muted) {
          // Store original track and replace with null to fully stop sending audio
          const track = sender.track;
          if (track !== null) {
            track.enabled = false;
            mutedTracks.set(sender, track);
            void sender.replaceTrack(null);
          }
        } else {
          // Restore the original track
          const track = mutedTracks.get(sender);
          if (track !== undefined) {
            track.enabled = true;
            void sender.replaceTrack(track);
            mutedTracks.delete(sender);
          }
        }
      }
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

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (pc !== null) {
        pc.removeEventListener("icecandidate", handleIceCandidateEvent);
        pc.removeEventListener("track", handleTrackEvent);
        pc.removeEventListener("connectionstatechange", handleConnectionStateChange);
        pc.close();
        pc = null;
      }
      localSenders = [];
      mutedTracks.clear();
      remoteStreams = [];
      iceCandidateCallbacks.clear();
      remoteTrackCallbacks.clear();
      stateChangeCallbacks.clear();
    },
  };
}
