/**
 * Native voice: the Linux desktop backend that runs the LiveKit room in the
 * host process, because the Linux system webview ships no WebRTC. The web
 * `Room` is replaced behind the `livekitSession` facade by an adapter
 * (`features/voice/native/nativeRoom.ts`) that drives this contract; the
 * E2EE key exchange stays in TypeScript and hands over only the final room
 * key (`setRoomKey`), which the backend derives from exactly as a browser
 * client would. Every room event arrives on one subscription (`onEvent`),
 * tagged with the session it belongs to, and `disconnect` is scoped to a
 * session id so a superseded join tears down only its own room. Video
 * frames never cross IPC: each session serves them on a loopback WebSocket
 * whose token-carrying URL arrives only in the `connect` result
 * (`NativeVoiceConnected.frames`). Screen share captures in the host
 * (`startScreen`): the webview picks among `screenSources`, or, on Wayland,
 * the desktop portal's own dialog picks and asks for consent; the webview
 * sees the capture only as a preview on the frame socket. Browser outlook:
 * not applicable — a browser has its own WebRTC.
 */
export interface NativeVoiceAudioOptions {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/** Host-side resource counts for the facade's debug surface. */
export interface NativeVoiceResources {
  rooms: number;
  localTracks: number;
  admRefs: number;
  /** Remote audio tracks being read into the playout mixer. */
  audioStreams: number;
  /** Open frame-socket connections (remote renderers, camera upload and
   *  screen preview). */
  videoSockets: number;
  /** Screen capturers alive (each holds, on Wayland, a portal session);
   *  zero once every share has stopped. */
  screenCaptures: number;
  /** Process thread count, the observable for a leaked frame-cryptor thread. */
  threads: number;
}

export interface NativeVoiceTrack {
  sid: string;
  kind: "audio" | "video";
  source: "microphone" | "camera" | "screen_share" | "screen_share_audio" | "unknown";
  muted: boolean;
}

export interface NativeVoiceParticipant {
  identity: string;
  tracks: NativeVoiceTrack[];
}

export type NativeVoiceEvent =
  | { type: "connected"; participants: NativeVoiceParticipant[] }
  | { type: "participantConnected"; identity: string }
  | { type: "participantDisconnected"; identity: string }
  | { type: "trackPublished"; identity: string; track: NativeVoiceTrack }
  | { type: "trackUnpublished"; identity: string; sid: string }
  | { type: "trackSubscribed"; identity: string; track: NativeVoiceTrack }
  | { type: "trackUnsubscribed"; identity: string; sid: string }
  | { type: "trackMuted"; identity: string; sid: string; muted: boolean }
  | { type: "activeSpeakers"; identities: string[] }
  | { type: "encryptionStatus"; identity: string; encrypted: boolean }
  /** Screen capture `capture` ended on its own after it started: stopped
   *  from the desktop's sharing indicator, or the shared window closed. */
  | { type: "screenCaptureEnded"; capture: number }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "disconnected"; reason: string };

export interface NativeVoiceEnvelope {
  session: number;
  event: NativeVoiceEvent;
}

export interface NativeVoiceDevice {
  /** The host's identifier: the capture device's name, or the output
   *  host's stable device id. */
  id: string;
  name: string;
}

/** Capture and playout devices in the host's order; the first entry of each
 *  list is what the host uses by default. */
export interface NativeVoiceDevices {
  inputs: NativeVoiceDevice[];
  outputs: NativeVoiceDevice[];
}

export interface NativeVoiceConnected {
  session: number;
  /** Our LiveKit identity in the room (`user-<id>…`). */
  identity: string;
  /** The session's frame-socket base URL, token included: append
   *  `/remote/<track sid>` to read a remote video track (I420 frames) or
   *  `/camera` to upload the local camera. */
  frames: string;
}

/** How the camera is published: the web path's `publishTrack` options. */
export interface NativeVoiceCameraOptions {
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
  simulcast: boolean;
}

export interface NativeVoiceScreenSource {
  /** What `startScreen` takes. */
  id: string;
  kind: "screen" | "window";
  title: string;
  /** An image URL of the source as it looks now, when it could be read. */
  thumbnail: string | null;
}

/** What can be shared. `portal`: the desktop portal's dialog picks
 *  (Wayland), so `sources` is empty and `startScreen` takes `"portal"`. */
export interface NativeVoiceScreenSources {
  portal: boolean;
  sources: NativeVoiceScreenSource[];
}

/** Capture pacing and size cap; 0 for both sizes is the source size. */
export interface NativeVoiceScreenCapture {
  fps: number;
  maxWidth: number;
  maxHeight: number;
}

/** A started capture: its id and the first frame's size. */
export interface NativeVoiceScreenStarted {
  capture: number;
  width: number;
  height: number;
}

/** How the screen share is published: the capture's size and the web
 *  path's `publishTrack` encoding for it. */
export interface NativeVoiceScreenOptions {
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
}

export interface NativeVoice {
  /** Install or rotate the room key: the same base64 text the web key
   *  provider receives, so both derive the same key (index 0). */
  setRoomKey(keyBase64: string): Promise<void>;
  clearRoomKey(): Promise<void>;
  connect(
    url: string,
    token: string,
    audio: NativeVoiceAudioOptions,
  ): Promise<NativeVoiceConnected>;
  /** Close `session` if it is still the live one; a stale id is a no-op. */
  disconnect(session: number): Promise<NativeVoiceResources>;
  setMicrophone(session: number, enabled: boolean): Promise<void>;
  setSubscribed(session: number, identity: string, sid: string, subscribed: boolean): Promise<void>;
  /** Per-user volume: play `identity`'s microphone at `volume` (1 is unity),
   *  the value the web path hands `RemoteParticipant.setVolume`. */
  setVolume(session: number, identity: string, volume: number): Promise<void>;
  /** Play `identity`'s screen-share audio at `volume` (1 is unity, 0 when
   *  muted), the value the web path gives its screen-share audio element. */
  setScreenshareVolume(session: number, identity: string, volume: number): Promise<void>;
  /** Publish (or replace) the camera; its frames then go up the session's
   *  frame socket. E2EE covers it with the room key, as for the microphone.
   *  Resolves with the publication's sid. */
  publishCamera(session: number, options: NativeVoiceCameraOptions): Promise<string>;
  /** Unpublish camera `sid` if it is still the published one; a sid a later
   *  publish replaced is a no-op. */
  unpublishCamera(session: number, sid: string): Promise<void>;
  /** What can be shared, with thumbnails; enumerating is slow (one capture
   *  per source). */
  screenSources(): Promise<NativeVoiceScreenSources>;
  /** Start capturing `source` (replacing any running capture) and resolve
   *  once its first frame arrives — on Wayland after the portal dialog
   *  completes; a cancelled or refused dialog rejects with "screen capture
   *  was cancelled or refused".
   *  The preview then plays on the frame socket's `/screen` route. */
  startScreen(
    session: number,
    source: string,
    capture: NativeVoiceScreenCapture,
  ): Promise<NativeVoiceScreenStarted>;
  /** Publish running capture `capture` (E2EE as the camera); resolves with
   *  the publication's sid. */
  publishScreen(
    session: number,
    capture: number,
    options: NativeVoiceScreenOptions,
  ): Promise<string>;
  /** Unpublish and stop capture `capture`, releasing the capturer and any
   *  portal session; a stale id is a no-op. */
  stopScreen(session: number, capture: number): Promise<void>;
  debugInfo(): Promise<NativeVoiceResources>;
  /** Enumerate audio devices, in or out of a call. */
  listDevices(): Promise<NativeVoiceDevices>;
  /** Switch the session's capture (`audioinput`) or playout (`audiooutput`)
   *  device to a `listDevices` id; an empty id selects the host default. */
  setDevice(session: number, kind: "audioinput" | "audiooutput", deviceId: string): Promise<void>;
  /** Room events for every session. Returns a synchronous unsubscribe that
   *  is safe to call before the host subscription has finished registering. */
  onEvent(handler: (envelope: NativeVoiceEnvelope) => void): () => void;
}
