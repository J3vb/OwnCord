import { vi } from "vitest";
import type {
  NativeVoiceEnvelope,
  NativeVoiceStats,
} from "../../src/platform/contracts/nativeVoice";
import { createNativeRoom } from "../../src/features/voice/native/nativeRoom";
import { desktop } from "../../src/platform/desktop";
import { NativeScreenAudioTrack } from "../../src/features/voice/native/screenAudioTrack";
import type { NativeScreenTrack } from "../../src/features/voice/native/screenTrack";
import { host, track } from "./nativeRoomMocks";

export const audio = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  enhancedNoiseSuppression: false,
};

export const emit = (envelope: NativeVoiceEnvelope) => {
  for (const h of host.handlers) h(envelope);
};

export const micCalls = () => host.calls.filter(([name]) => name === "setMicrophone");

export const gateCalls = () => host.calls.filter(([name]) => name === "setPttGated");

export const video = (sid: string, source: "camera" | "screen_share" = "camera") => ({
  sid,
  kind: "video" as const,
  source,
  muted: false,
  encrypted: true,
});

export const views = () => host.calls.filter(([n]) => n === "setVideoView").map(([, a]) => a);

export const settle = () => new Promise<void>((r) => setTimeout(r, 0));

export const cameraOptions = {
  source: "camera",
  simulcast: true,
  videoEncoding: { maxBitrate: 1_700_000, maxFramerate: 30 },
};

/** Start a native camera capture as the shared enableCamera does, then
 *  publish it, returning the track. */
export const startCamera = async (room: ReturnType<typeof createNativeRoom>) =>
  (await room.localParticipant.createCameraTracks(cameraOptions))[0]!;

export function track2() {
  return track("TR_a", "microphone");
}

export const screenOptions = {
  source: "screen_share",
  simulcast: false,
  videoEncoding: { maxBitrate: 6_000_000, maxFramerate: 30 },
};

export const share = async (room: ReturnType<typeof createNativeRoom>) => {
  const [screen] = await room.localParticipant.createScreenTracks();
  return screen as NativeScreenTrack;
};

export const audioOptions = { source: "screen_share_audio", simulcast: false };

/** A share whose pick asked for audio: the video track and the audio track. */
export const shareWithAudio = async (room: ReturnType<typeof createNativeRoom>) => {
  const pick = host.pick;
  host.pick = () => pick().then((p) => ({ ...(p as object), audio: true }));
  const [screen, audioTrack] = await room.localParticipant.createScreenTracks();
  return { screen: screen as NativeScreenTrack, audioTrack: audioTrack as NativeScreenAudioTrack };
};

export const publishedCamera = async () => {
  const room = createNativeRoom(audio);
  await room.connect("u", "t");
  const cam = await startCamera(room);
  await room.localParticipant.publishTrack(cam, cameraOptions);
  host.calls.length = 0;
  return { room, cam };
};

export const names = () => host.calls.map(([n]) => n);

export const sample = (over: Partial<NativeVoiceStats> = {}): NativeVoiceStats => ({
  atMs: 1000,
  publisher: [
    {
      type: "candidate-pair",
      id: "CP1",
      currentRoundTripTime: 0.042,
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

export const getStatsCalls = () => host.calls.filter(([n]) => n === "getStats");

export const transports = (room: ReturnType<typeof createNativeRoom>) =>
  room.engine.pcManager as unknown as {
    publisher: { getStats(): Promise<ReadonlyMap<string, unknown> | undefined> };
    subscriber: { getStats(): Promise<ReadonlyMap<string, unknown> | undefined> };
  };

export const tile = async (room: ReturnType<typeof createNativeRoom>) => {
  emit({
    session: 1,
    event: { type: "trackSubscribed", identity: "user-2", track: video("TR_v") },
  });
  return room.remoteParticipants.get("user-2")!.getTrackPublication("camera")!.track!;
};

export const remote = (bytesReceived: number) => ({
  frameWidth: 1280,
  frameHeight: 720,
  framesDecoded: 60,
  bytesReceived,
  packetsLost: 2,
  packetsReceived: 300,
  mimeType: "video/VP8",
});

export const layer = (fps: number) => ({
  framesPerSecond: fps,
  frameWidth: 1920,
  frameHeight: 1080,
  qualityLimitationReason: "cpu",
  encoderImplementation: "libvpx",
  active: true,
});

// --- Surface, command failures and publication bookkeeping ---

export const nativeVoice = desktop.nativeVoice;

export type GateCommand =
  | "setPttGated"
  | "setVoiceGate"
  | "setInputGain"
  | "setAudioProcessing"
  | "setSubscribed"
  | "setVideoView"
  | "setVolume"
  | "setScreenshareVolume";

export const rejectOnce = (command: GateCommand, err: unknown) =>
  vi.spyOn(nativeVoice, command).mockRejectedValueOnce(err);

export const connected = async () => {
  const room = createNativeRoom(audio);
  await room.connect("u", "t");
  host.calls.length = 0;
  return room;
};

export const reportEncryption = (identity: string, encrypted: boolean): void =>
  emit({ session: 1, event: { type: "encryptionStatus", identity, encrypted } });
