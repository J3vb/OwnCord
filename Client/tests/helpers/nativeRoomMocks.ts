import { vi } from "vitest";
import type {
  NativeVoiceEnvelope,
  NativeVoiceStats,
} from "../../src/platform/contracts/nativeVoice";
import { loggerMock as sharedLoggerMock } from "./loggerMock";

export const log = {
  tags: [] as string[],
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

export interface FakeMedia {
  url: string;
  disposed: boolean;
  mediaStreamTrack?: { id: string; events: string[] };
  track?: unknown;
  maxFramerate?: number;
}

export const host = {
  calls: [] as Array<[string, unknown[]]>,
  handlers: new Set<(e: NativeVoiceEnvelope) => void>(),
  connectResult: Promise.resolve({
    session: 1,
    identity: "user-1",
    frames: "ws://127.0.0.1:9/tok",
  }),
  publishCamera: (): Promise<string> => Promise.resolve("TR_cam"),
  startCamera: (): Promise<unknown> => Promise.resolve({ capture: 5, width: 1280, height: 720 }),
  changeCamera: (): Promise<unknown> => Promise.resolve({ capture: 7, width: 960, height: 720 }),
  setDevice: (): Promise<void> => Promise.resolve(),
  getStats: (): Promise<NativeVoiceStats | null> => Promise.resolve(null),
  setVideoView: (): Promise<void> => Promise.resolve(),
  pick: (): Promise<unknown> =>
    Promise.resolve({
      source: "screen:7",
      quality: "low",
      fps: 30,
      capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
      maxBitrate: 1_500_000,
      maxFramerate: 5,
    }),
  setScreenQuality: (): Promise<unknown> =>
    Promise.resolve({ ok: true, sid: "TR_screen2", width: 1920, height: 1080 }),
  notedQuality: [] as Array<[string, number]>,
  startScreen: (): Promise<unknown> => Promise.resolve({ capture: 4, width: 1280, height: 720 }),
  changeScreen: (): Promise<unknown> => Promise.resolve({ capture: 6, width: 800, height: 600 }),
  pickChange: (): Promise<string | null> => Promise.resolve("window:9"),
  publishScreenAudio: (): Promise<string> => Promise.resolve("TR_audio"),
  noted: [] as string[],
  unsubscribed: 0,
  renderers: [] as FakeMedia[],
};

export const track = (sid: string, source: "microphone" | "screen_share_audio") => ({
  sid,
  kind: "audio" as const,
  source,
  muted: false,
  encrypted: true,
});

export function livekitClientMock() {
  return {
    RoomEvent: {
      Connected: "connected",
      Disconnected: "disconnected",
      Reconnecting: "reconnecting",
      Reconnected: "reconnected",
      ParticipantConnected: "participantConnected",
      ParticipantDisconnected: "participantDisconnected",
      ActiveSpeakersChanged: "activeSpeakersChanged",
      ParticipantPermissionsChanged: "participantPermissionsChanged",
      EncryptionError: "encryptionError",
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      TrackPublished: "trackPublished",
      TrackUnpublished: "trackUnpublished",
      TrackMuted: "trackMuted",
    },
    Track: {
      Kind: { Audio: "audio", Video: "video" },
      Source: {
        Camera: "camera",
        Microphone: "microphone",
        ScreenShare: "screen_share",
        ScreenShareAudio: "screen_share_audio",
      },
      sourceToProto: (source: string) =>
        ({ camera: 1, microphone: 2, screen_share: 3, screen_share_audio: 4 })[source],
    },
    DisconnectReason: { UNKNOWN_REASON: 0, CLIENT_INITIATED: 1 },
  };
}

export function loggerMock() {
  return sharedLoggerMock({
    createLogger: (tag: string) => {
      log.tags.push(tag);
      return log;
    },
  });
}

export function videoRendererMock() {
  return {
    NativeVideoRenderer: class {
      disposed = false;
      readonly mediaStreamTrack = {
        id: `canvas-${host.renderers.length}`,
        events: [] as string[],
        readyState: "live",
        stop() {
          this.readyState = "ended";
        },
        dispatchEvent(e: Event) {
          this.events.push(e.type);
          return true;
        },
      };
      constructor(readonly url: string) {
        host.renderers.push(this);
      }
      dispose() {
        this.disposed = true;
      }
    },
  };
}

export function screenPickerMock() {
  return {
    // The picker's quality mapping (pinned in screenPicker.test.ts), as a table.
    shareSettings: (quality: string) =>
      ({
        low: {
          capture: { fps: 5, maxWidth: 1280, maxHeight: 720 },
          maxBitrate: 1_500_000,
          maxFramerate: 5,
          simulcast: false,
        },
        medium: {
          capture: { fps: 30, maxWidth: 1280, maxHeight: 720 },
          maxBitrate: 3_000_000,
          maxFramerate: 30,
          simulcast: true,
        },
        high: {
          capture: { fps: 30, maxWidth: 1920, maxHeight: 1080 },
          maxBitrate: 6_000_000,
          maxFramerate: 30,
          simulcast: true,
        },
      })[quality],
    pickScreenSource: () => host.pick(),
    pickChangeSource: () => host.pickChange(),
    noteChangedSource: (source: string) => host.noted.push(source),
    noteChangedQuality: (quality: string, fps: number) => host.notedQuality.push([quality, fps]),
  };
}

export function platformDesktopMock() {
  return {
    desktop: {
      nativeVoice: {
        connect: (...args: unknown[]) => {
          host.calls.push(["connect", args]);
          return host.connectResult;
        },
        disconnect: (...args: unknown[]) => {
          host.calls.push(["disconnect", args]);
          return Promise.resolve({ rooms: 0, localTracks: 0, captureStreams: 0, threads: 12 });
        },
        setMicrophone: (...args: unknown[]) => {
          host.calls.push(["setMicrophone", args]);
          return Promise.resolve();
        },
        setPttGated: (...args: unknown[]) => {
          host.calls.push(["setPttGated", args]);
          return Promise.resolve();
        },
        setVoiceGate: (...args: unknown[]) => {
          host.calls.push(["setVoiceGate", args]);
          return Promise.resolve();
        },
        setInputGain: (...args: unknown[]) => {
          host.calls.push(["setInputGain", args]);
          return Promise.resolve();
        },
        setAudioProcessing: (...args: unknown[]) => {
          host.calls.push(["setAudioProcessing", args]);
          return Promise.resolve();
        },
        setSubscribed: (...args: unknown[]) => {
          host.calls.push(["setSubscribed", args]);
          return Promise.resolve();
        },
        setVideoView: (...args: unknown[]) => {
          host.calls.push(["setVideoView", args]);
          return host.setVideoView();
        },
        setVolume: (...args: unknown[]) => {
          host.calls.push(["setVolume", args]);
          return Promise.resolve();
        },
        setScreenshareVolume: (...args: unknown[]) => {
          host.calls.push(["setScreenshareVolume", args]);
          return Promise.resolve();
        },
        setDevice: (...args: unknown[]) => {
          host.calls.push(["setDevice", args]);
          return host.setDevice();
        },
        getStats: (...args: unknown[]) => {
          host.calls.push(["getStats", args]);
          return host.getStats();
        },
        publishCamera: (...args: unknown[]) => {
          host.calls.push(["publishCamera", args]);
          return host.publishCamera();
        },
        unpublishCamera: (...args: unknown[]) => {
          host.calls.push(["unpublishCamera", args]);
          return Promise.resolve();
        },
        startCamera: (...args: unknown[]) => {
          host.calls.push(["startCamera", args]);
          return host.startCamera();
        },
        stopCamera: (...args: unknown[]) => {
          host.calls.push(["stopCamera", args]);
          return Promise.resolve();
        },
        startScreen: (...args: unknown[]) => {
          host.calls.push(["startScreen", args]);
          return host.startScreen();
        },
        publishScreen: (...args: unknown[]) => {
          host.calls.push(["publishScreen", args]);
          return Promise.resolve("TR_screen");
        },
        unpublishScreen: (...args: unknown[]) => {
          host.calls.push(["unpublishScreen", args]);
          return Promise.resolve();
        },
        publishScreenAudio: (...args: unknown[]) => {
          host.calls.push(["publishScreenAudio", args]);
          return host.publishScreenAudio();
        },
        unpublishScreenAudio: (...args: unknown[]) => {
          host.calls.push(["unpublishScreenAudio", args]);
          return Promise.resolve();
        },
        stopScreen: (...args: unknown[]) => {
          host.calls.push(["stopScreen", args]);
          return Promise.resolve();
        },
        changeCamera: (...args: unknown[]) => {
          host.calls.push(["changeCamera", args]);
          return host.changeCamera();
        },
        changeScreen: (...args: unknown[]) => {
          host.calls.push(["changeScreen", args]);
          return host.changeScreen();
        },
        setScreenQuality: (...args: unknown[]) => {
          host.calls.push(["setScreenQuality", args]);
          return host.setScreenQuality();
        },
        onEvent: (handler: (e: NativeVoiceEnvelope) => void) => {
          host.handlers.add(handler);
          return () => {
            host.handlers.delete(handler);
            host.unsubscribed++;
          };
        },
      },
    },
  };
}
