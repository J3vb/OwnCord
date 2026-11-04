import type { NativeVoiceStats } from "../../src/platform/contracts/nativeVoice";

export const audio = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  enhancedNoiseSuppression: false,
};

/** A host stats reply with a healthy audio call whose round trip is `rttSeconds`; `over` wins. */
export const nativeStatsSample = (
  rttSeconds = 0.042,
  over: Partial<NativeVoiceStats> = {},
): NativeVoiceStats => ({
  atMs: 1000,
  publisher: [
    {
      type: "candidate-pair",
      id: "CP1",
      currentRoundTripTime: rttSeconds,
      bytesSent: 900,
      bytesReceived: 1200,
    },
    { type: "outbound-rtp", id: "OA1", kind: "audio", packetsSent: 100, bytesSent: 4000 },
    {
      type: "inbound-rtp",
      id: "IA1",
      kind: "audio",
      packetsReceived: 100,
      bytesReceived: 3000,
      packetsLost: 0,
      jitter: 0.004,
    },
  ],
  subscriber: [],
  remoteVideo: {},
  localVideo: {},
  ...over,
});
