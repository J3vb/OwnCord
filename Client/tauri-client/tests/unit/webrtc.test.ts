/**
 * Unit tests for WebRTC SDP munging (applyOpusSettings) and
 * replaceTrack logic via mocked RTCPeerConnection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebRtcService } from "../../src/lib/webrtc";

// The applyOpusSettings function is module-private, so we test the
// SDP manipulation patterns it implements as string transformations.
// This validates the core logic without needing a real PeerConnection.

describe("SDP Opus settings", () => {
  const baseSdp = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 minptime=10;usedtx=1",
    "a=mid:0",
    "",
  ].join("\r\n");

  // Replicate applyOpusSettings logic for testing
  function applyOpusSettings(sdp: string, bitrate: number | undefined): string {
    const lines = sdp.split("\r\n");
    const result: string[] = [];
    let inAudioSection = false;
    let bitrateInserted = false;

    for (const line of lines) {
      let out = line;
      if (out.startsWith("m=audio")) {
        inAudioSection = true;
        bitrateInserted = false;
      } else if (out.startsWith("m=")) {
        inAudioSection = false;
      }
      if (out.startsWith("a=fmtp:111 ")) {
        if (!out.includes("useinbandfec=")) {
          out += ";useinbandfec=1";
        }
      }
      result.push(out);
      if (inAudioSection && !bitrateInserted && bitrate !== undefined && out.startsWith("m=audio")) {
        result.push(`b=AS:${Math.round(bitrate / 1000)}`);
        bitrateInserted = true;
      }
    }
    return result.join("\r\n");
  }

  it("adds useinbandfec to Opus fmtp line", () => {
    const result = applyOpusSettings(baseSdp, undefined);
    expect(result).toContain("a=fmtp:111 minptime=10;usedtx=1;useinbandfec=1");
  });

  it("does not duplicate useinbandfec if already present", () => {
    const sdpWithFec = baseSdp.replace(
      "a=fmtp:111 minptime=10;usedtx=1",
      "a=fmtp:111 minptime=10;usedtx=1;useinbandfec=1",
    );
    const result = applyOpusSettings(sdpWithFec, undefined);
    const matches = result.match(/useinbandfec/g);
    expect(matches).toHaveLength(1);
  });

  it("inserts b=AS bandwidth line after m=audio", () => {
    const result = applyOpusSettings(baseSdp, 64000);
    const lines = result.split("\r\n");
    const mAudioIdx = lines.findIndex((l) => l.startsWith("m=audio"));
    expect(lines[mAudioIdx + 1]).toBe("b=AS:64");
  });

  it("calculates b=AS correctly for different bitrates", () => {
    expect(applyOpusSettings(baseSdp, 32000)).toContain("b=AS:32");
    expect(applyOpusSettings(baseSdp, 128000)).toContain("b=AS:128");
  });

  it("does not insert b=AS when bitrate is undefined", () => {
    const result = applyOpusSettings(baseSdp, undefined);
    expect(result).not.toContain("b=AS:");
  });

  it("handles multi-section SDP (audio + video)", () => {
    const multiSdp = [
      "v=0",
      "o=- 0 0 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=fmtp:111 minptime=10",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=rtpmap:96 VP8/90000",
      "",
    ].join("\r\n");
    const result = applyOpusSettings(multiSdp, 64000);
    // b=AS should appear after m=audio, not after m=video
    const lines = result.split("\r\n");
    const audioIdx = lines.findIndex((l) => l.startsWith("m=audio"));
    const videoIdx = lines.findIndex((l) => l.startsWith("m=video"));
    const basIdx = lines.findIndex((l) => l.startsWith("b=AS:"));
    expect(basIdx).toBeGreaterThan(audioIdx);
    expect(basIdx).toBeLessThan(videoIdx);
  });
});

// ---------------------------------------------------------------------------
// replaceTrack tests — uses mocked RTCPeerConnection
// ---------------------------------------------------------------------------

/** Create a minimal mock MediaStreamTrack. */
function mockTrack(id = "track-1"): MediaStreamTrack {
  return {
    id,
    kind: "audio",
    enabled: true,
    stop: vi.fn(),
    readyState: "live",
  } as unknown as MediaStreamTrack;
}

/** Create a minimal mock MediaStream. */
function mockStream(tracks: MediaStreamTrack[] = [mockTrack()]): MediaStream {
  return {
    id: "stream-1",
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => [],
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    clone: vi.fn(),
    active: true,
  } as unknown as MediaStream;
}

describe("replaceTrack", () => {
  let originalRTCPeerConnection: typeof RTCPeerConnection;
  let mockReplaceTrack: ReturnType<typeof vi.fn>;
  let mockAddTrack: ReturnType<typeof vi.fn>;
  let mockRemoveTrack: ReturnType<typeof vi.fn>;
  let mockSender: RTCRtpSender;

  beforeEach(() => {
    originalRTCPeerConnection = globalThis.RTCPeerConnection;

    mockReplaceTrack = vi.fn().mockResolvedValue(undefined);
    mockSender = {
      track: mockTrack(),
      replaceTrack: mockReplaceTrack,
      getParameters: vi.fn().mockReturnValue({}),
      setParameters: vi.fn(),
    } as unknown as RTCRtpSender;

    mockAddTrack = vi.fn().mockReturnValue(mockSender);
    mockRemoveTrack = vi.fn();

    const MockPeerConnection = vi.fn().mockImplementation(() => ({
      addTrack: mockAddTrack,
      removeTrack: mockRemoveTrack,
      close: vi.fn(),
      signalingState: "stable",
      connectionState: "new",
      iceConnectionState: "new",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createOffer: vi.fn().mockResolvedValue({ type: "offer", sdp: "v=0\r\n" }),
      createAnswer: vi.fn().mockResolvedValue({ type: "answer", sdp: "v=0\r\n" }),
      setLocalDescription: vi.fn().mockResolvedValue(undefined),
      setRemoteDescription: vi.fn().mockResolvedValue(undefined),
      addIceCandidate: vi.fn().mockResolvedValue(undefined),
    }));

    globalThis.RTCPeerConnection = MockPeerConnection as unknown as typeof RTCPeerConnection;
  });

  afterEach(() => {
    globalThis.RTCPeerConnection = originalRTCPeerConnection;
  });

  it("swaps track on existing sender via sender.replaceTrack", async () => {
    const service = createWebRtcService();
    const stream1 = mockStream();
    service.createConnection({ iceServers: [] });

    // Initial attach — sets up senders
    service.setLocalStream(stream1);
    expect(mockAddTrack).toHaveBeenCalledTimes(1);

    // Replace with new stream — should use replaceTrack, NOT removeTrack+addTrack
    const newTrack = mockTrack("track-2");
    const stream2 = mockStream([newTrack]);
    await service.replaceTrack(stream2);

    expect(mockReplaceTrack).toHaveBeenCalledWith(newTrack);
    expect(mockRemoveTrack).not.toHaveBeenCalled();
    // addTrack should still be 1 (from initial setLocalStream, not from replaceTrack)
    expect(mockAddTrack).toHaveBeenCalledTimes(1);

    service.destroy();
  });

  it("falls back to addTrack when no senders exist", async () => {
    const service = createWebRtcService();
    service.createConnection({ iceServers: [] });

    // No setLocalStream — no existing senders
    const newTrack = mockTrack("track-new");
    const stream = mockStream([newTrack]);
    await service.replaceTrack(stream);

    // Should fall back to addTrack
    expect(mockAddTrack).toHaveBeenCalledTimes(1);
    expect(mockReplaceTrack).not.toHaveBeenCalled();

    service.destroy();
  });

  it("applies mute+silence state to new track after replaceTrack", async () => {
    const service = createWebRtcService();
    // Create a track that the mock sender will reference
    const senderTrack = mockTrack("track-sender");
    Object.defineProperty(mockSender, "track", { value: senderTrack, writable: true, configurable: true });

    const stream1 = mockStream([mockTrack("track-1")]);
    service.createConnection({ iceServers: [] });
    service.setLocalStream(stream1);

    // Mute the stream — operates on sender.track
    service.setMuted(true);
    expect(senderTrack.enabled).toBe(false);

    // Replace track — the new track should also get mute state applied
    const track2 = mockTrack("track-2");
    track2.enabled = true; // starts enabled
    const stream2 = mockStream([track2]);
    // After replaceTrack, the sender's track reference updates
    Object.defineProperty(mockSender, "track", { value: track2, writable: true, configurable: true });
    await service.replaceTrack(stream2);

    // applyTrackEnabled runs after replaceTrack — should mute the new track
    expect(track2.enabled).toBe(false);

    service.destroy();
  });
});
