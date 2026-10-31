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
  /** RNNoise after the engine's processing (the web path's worklet). */
  enhancedNoiseSuppression: boolean;
}

/** Host-side resource counts for the facade's debug surface. */
export interface NativeVoiceResources {
  rooms: number;
  localTracks: number;
  /** Open microphone input streams (0 while muted). */
  captureStreams: number;
  /** Remote audio tracks being read into the playout mixer. */
  audioStreams: number;
  /** Open frame-socket connections (remote renderers, camera upload and
   *  screen preview). */
  videoSockets: number;
  /** Screen capturers alive (each holds, on Wayland, a portal session);
   *  zero once every share has stopped. */
  screenCaptures: number;
  /** Native camera capture threads alive (each holds a GStreamer pipeline
   *  and the device); zero once the camera is off. */
  cameraCaptures: number;
  /** Process thread count, the observable for a leaked frame-cryptor thread. */
  threads: number;
}

export interface NativeVoiceTrack {
  sid: string;
  kind: "audio" | "video";
  source: "microphone" | "camera" | "screen_share" | "screen_share_audio" | "unknown";
  muted: boolean;
  /** Whether the server reports the track end-to-end encrypted. */
  encrypted: boolean;
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
  /** The server's grant for the local participant: once on connect, then on
   *  every change (a moderator server-mute, a role or channel permission
   *  change). Sources are LiveKit protocol `TrackSource` numbers; an empty
   *  list means every source. */
  | { type: "permission"; canPublish: boolean; canPublishSources: number[] }
  /** The input-sensitivity gate opened (speech) or closed (silence). */
  | { type: "voiceGate"; open: boolean }
  /** A capture level report, every ~50 ms while the microphone runs: the
   *  loudest ~10 ms RMS after the input volume (the detector's scale) and
   *  whether the voice gate is open. */
  | { type: "inputLevel"; rms: number; open: boolean }
  | { type: "encryptionStatus"; identity: string; encrypted: boolean }
  /** Screen capture `capture` ended on its own after it started: stopped
   *  from the desktop's sharing indicator, or the shared window closed. */
  | { type: "screenCaptureEnded"; capture: number }
  /** Camera capture `capture` ended on its own after it started: the device
   *  was unplugged or the pipeline errored. */
  | { type: "cameraCaptureEnded"; capture: number }
  | { type: "reconnecting" }
  | { type: "reconnected" }
  | { type: "disconnected"; reason: string };

export interface NativeVoiceEnvelope {
  session: number;
  event: NativeVoiceEvent;
}

export interface NativeVoiceDevice {
  /** The audio host's stable device id. */
  id: string;
  name: string;
}

/** Capture and playout devices in the host's order; the first entry of each
 *  list is what the host uses by default. */
export interface NativeVoiceDevices {
  inputs: NativeVoiceDevice[];
  outputs: NativeVoiceDevice[];
}

/** One note of an app sound's tone spec: a sine whose frequency
 *  steps at the given offsets, fading exponentially from `gain` to `endGain`
 *  over `duration`. Times are seconds, `freqs` entries are `[offset from the
 *  note's start, hertz]`. The host synthesizes it; the same table drives the
 *  Web Audio renderer, so the two cannot drift. */
export interface NativeToneNote {
  at: number;
  duration: number;
  gain: number;
  endGain: number;
  freqs: ReadonlyArray<readonly [number, number]>;
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

/** A video codec the native engine publishes. */
export type NativeVoiceVideoCodec = "vp8" | "h264" | "vp9";

/** What the native engine can encode beyond VP8 (`h264`, `vp9`) and decode
 *  (`decode`: lowercase codec names from libwebrtc's receiver capabilities). */
export interface NativeVoiceVideoCodecs {
  h264: boolean;
  vp9: boolean;
  decode: string[];
}

/** How the camera is published: the web path's `publishTrack` options. */
export interface NativeVoiceCameraOptions {
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
  simulcast: boolean;
  /** The codec to publish with. The host defaults to VP8 when it is absent;
   *  `h264` and `vp9` only go out when `videoCodecs` said the engine can encode them. */
  codec: NativeVoiceVideoCodec;
}

/** A native camera device: the id `startCamera` takes. */
export interface NativeVoiceCameraDevice {
  id: string;
  name: string;
  /** Offers only greyscale formats: a face-unlock infrared sensor, listed
   *  after the colour cameras. */
  infrared: boolean;
}

/** Whether the host can capture cameras at all: GStreamer initialises and the
 *  capture pipeline's required elements exist. `missing` names the required
 *  elements that could not be found. */
export interface NativeVoiceCameraSupport {
  available: boolean;
  missing: string[];
}

/** Capture pacing and size cap for the native camera; 0 for both sizes is the
 *  source size. */
export interface NativeVoiceCameraCapture {
  fps: number;
  maxWidth: number;
  maxHeight: number;
}

/** A started camera capture: its id and the first frame's size. */
export interface NativeVoiceCameraStarted {
  capture: number;
  width: number;
  height: number;
}

/** A camera preview outside any room (the settings tab): the live preview
 *  plays on the frame socket's `/camera` route. */
export interface NativeVoiceCameraPreview {
  width: number;
  height: number;
  /** The preview's frame-socket base URL, token included. */
  frames: string;
}

export interface NativeVoiceScreenSource {
  /** What `startScreen` takes. */
  id: string;
  kind: "screen" | "window";
  title: string;
  /** An image URL of the source as it looks now, when it could be read. */
  thumbnail: string | null;
  /** Refresh rate in Hz of the monitor a `screen` source is (X11, from
   *  XRandR). `null` for windows and when it could not be read. */
  readonly refreshHz?: number | null;
}

/** What can be shared. `portal`: the desktop portal's dialog picks
 *  (Wayland), so `sources` is empty and `startScreen` takes `"portal"`. */
export interface NativeVoiceScreenSources {
  portal: boolean;
  sources: NativeVoiceScreenSource[];
  /** Other applications' sound can be shared with the screen: a PulseAudio
   *  protocol server (PulseAudio or pipewire-pulse) answered. */
  audio: boolean;
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
 *  path's `publishTrack` encoding for it. `simulcast` adds the web path's
 *  720p 15 fps layer (`SCREENSHARE_SIMULCAST_LAYERS`). */
export interface NativeVoiceScreenOptions {
  width: number;
  height: number;
  maxBitrate: number;
  maxFramerate: number;
  simulcast: boolean;
  /** The codec to publish with. The host defaults to VP8 when it is absent;
   *  `h264` and `vp9` only go out when `videoCodecs` said the engine can encode them. */
  codec: NativeVoiceVideoCodec;
}

/** What a live quality change published: the new publication's sid and the
 *  size the capture now delivers. */
export interface NativeVoiceScreenQualitySet {
  sid: string;
  width: number;
  height: number;
}

/** The outcome of `setScreenQuality`. `refused`: nothing changed and the
 *  share goes on (no published share, a stale capture, a source change
 *  pending, or a host that rejected without a stage). `publish`: the
 *  republish failed and only the screen video is unpublished: the capture
 *  and the share audio stay up, so the caller must `stopScreen` or retry
 *  `publishScreen`. */
export type NativeVoiceScreenQualityResult =
  | ({ ok: true } & NativeVoiceScreenQualitySet)
  | { ok: false; stage: "refused" | "publish"; message: string };

/** What the settings tab's mic test starts with (Linux only). */
export interface NativeMicTestOptions {
  /** `listDevices` ids; empty selects the host default. */
  input: string;
  output: string;
  audio: NativeVoiceAudioOptions;
  /** The input volume, percent (0-200). */
  inputGain: number;
  /** The output volume, linear (0-1). */
  outputGain: number;
  /** The voice gate's threshold on the web path's scale; 0 is no gate. */
  threshold: number;
  /** The voice gate also asks RNNoise's verdict (automatic sensitivity). */
  speech?: boolean;
  /** Capture and report levels only: no output is opened or played. */
  monitor?: boolean;
}

/** A live change to a running mic test. */
export type NativeMicTestUpdate =
  | { kind: "processing"; audio: NativeVoiceAudioOptions }
  | { kind: "inputGain"; percent: number }
  | { kind: "voiceGate"; threshold: number; retune: boolean; speech?: boolean }
  | { kind: "outputGain"; gain: number }
  | { kind: "inputDevice"; deviceId: string }
  | { kind: "outputDevice"; deviceId: string };

export type NativeMicTestEvent =
  | { type: "inputLevel"; rms: number; open: boolean }
  /** The host stopped the test (a call joined). */
  | { type: "ended" };

export interface NativeMicTestEnvelope {
  /** The id `startMicTest` resolved with. */
  test: number;
  event: NativeMicTestEvent;
}

/** The host's refusal of a mic test start during a call. */
// i18n-exempt: the host's refusal code, matched by the tab, never shown
export const NATIVE_MIC_TEST_IN_CALL = "mic test unavailable during a call";

/** One W3C-shaped stats entry (`RTCStats` field names) of a transport, cut to
 *  what `connectionStats.ts` reads. Times are seconds, as in the W3C reports. */
export type NativeVoiceStatsEntry =
  | {
      type: "candidate-pair";
      id: string;
      currentRoundTripTime: number;
      bytesSent: number;
      bytesReceived: number;
    }
  | { type: "outbound-rtp"; id: string; kind: string; packetsSent: number; bytesSent: number }
  | {
      type: "inbound-rtp";
      id: string;
      kind: string;
      packetsReceived: number;
      bytesReceived: number;
      packetsLost: number;
      jitter: number;
    }
  | {
      type: "remote-inbound-rtp";
      id: string;
      kind: string;
      /** The id of the outbound entry this one reports on. */
      localId: string;
      packetsLost: number;
      jitter: number;
    };

/** A subscribed remote video track's receiver sample. */
export interface NativeVoiceReceiverSample {
  frameWidth: number;
  frameHeight: number;
  framesDecoded: number;
  bytesReceived: number;
  packetsLost: number;
  packetsReceived: number;
  mimeType?: string;
}

/** One encoder layer of a local video track. */
export interface NativeVoiceSenderLayer {
  framesPerSecond?: number;
  frameWidth: number;
  frameHeight: number;
  qualityLimitationReason: string;
  encoderImplementation?: string;
  active: boolean;
}

/** One stats sample of a native session. */
export interface NativeVoiceStats {
  /** Host wall clock (ms since the epoch) at collection. */
  atMs: number;
  publisher: NativeVoiceStatsEntry[];
  /** Empty in single-PC mode. */
  subscriber: NativeVoiceStatsEntry[];
  /** Subscribed remote video by publication sid. */
  remoteVideo: Record<string, NativeVoiceReceiverSample>;
  /** Local video by source. */
  localVideo: { camera?: NativeVoiceSenderLayer[]; screen_share?: NativeVoiceSenderLayer[] };
}

/** A simulcast layer, as `native_voice_set_video_view` names it. */
export type NativeVideoQuality = "low" | "medium" | "high";

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
  /** `bitrate` (bits/s) is the channel's configured voice bitrate, applied
   *  when this enable publishes the microphone; omitted, the host keeps its
   *  default. */
  setMicrophone(session: number, enabled: boolean, bitrate?: number): Promise<void>;
  /** Push-to-talk's gate: closed, the open capture sends silence. */
  setPttGated(session: number, gated: boolean): Promise<void>;
  /** The input-sensitivity gate: the level (`vadThreshold`'s scale) the
   *  capture must reach to send, 0 for no gate. Its verdicts arrive as
   *  `voiceGate` events. `retune` moves the level without restarting the
   *  detector (automatic sensitivity's steps); `speech` makes the gate also
   *  ask RNNoise whether a frame is a voice (automatic sensitivity's rule),
   *  on a restart. */
  setVoiceGate(
    session: number,
    threshold: number,
    retune?: boolean,
    speech?: boolean,
  ): Promise<void>;
  /** The input volume, 0-200 % as the `inputVolume` pref: a gain on the
   *  processed microphone, ahead of the voice gate and the level reports. */
  setInputGain(session: number, percent: number): Promise<void>;
  /** Echo cancellation, noise suppression, automatic gain control and
   *  Enhanced Noise Suppression for the running call: the capture and the
   *  echo canceller's reference switch to them within a few frames, muted
   *  or not. */
  setAudioProcessing(session: number, audio: NativeVoiceAudioOptions): Promise<void>;
  /** One stats sample of `session`; null when the host could not read
   *  one (stale session, timeout). Never rejects. */
  getStats(session: number): Promise<NativeVoiceStats | null>;
  setSubscribed(session: number, identity: string, sid: string, subscribed: boolean): Promise<void>;
  /** Layer control for remote video `sid`: stop it, or ask for
   *  `quality` while it is shown. */
  setVideoView(
    session: number,
    identity: string,
    sid: string,
    enabled: boolean,
    quality: NativeVideoQuality,
  ): Promise<void>;
  /** Per-user volume: play `identity`'s microphone at `volume` (1 is unity),
   *  the value the web path hands `RemoteParticipant.setVolume`. */
  setVolume(session: number, identity: string, volume: number): Promise<void>;
  /** Play `identity`'s screen-share audio at `volume` (1 is unity, 0 when
   *  muted), the value the web path gives its screen-share audio element. */
  setScreenshareVolume(session: number, identity: string, volume: number): Promise<void>;
  /** Publish (or replace) camera capture `capture`; its frames then go to
   *  remote peers from the host. E2EE covers it with the room key, as for
   *  the microphone. Resolves with the publication's sid. */
  publishCamera(
    session: number,
    capture: number,
    options: NativeVoiceCameraOptions,
  ): Promise<string>;
  /** Unpublish camera `sid` if it is still the published one; a sid a later
   *  publish replaced is a no-op. The capture keeps running for the preview. */
  unpublishCamera(session: number, sid: string): Promise<void>;
  /** List the GStreamer `Video/Source` cameras (V4L2 and PipeWire), in or out
   *  of a call. */
  listCameras(): Promise<NativeVoiceCameraDevice[]>;
  /** Whether the host can capture cameras: GStreamer initialises and the
   *  capture pipeline's required elements exist. An empty list with this
   *  available is "no camera plugged in"; this false is "camera support is
   *  missing". */
  cameraSupport(): Promise<NativeVoiceCameraSupport>;
  /** Which codecs the engine encodes (libwebrtc's sender capabilities) and
   *  decodes (its receiver capabilities). A rejection resolves
   *  `{ h264: false, vp9: false, decode: [] }`, never throws. */
  videoCodecs(): Promise<NativeVoiceVideoCodecs>;
  /** Start capturing native camera `source` (replacing any running capture)
   *  and resolve once its first frame arrives; a source that fails or yields
   *  no frame in time rejects. The preview then plays on the frame socket's
   *  `/camera` route. Capture runs in the host and is independent of the
   *  window being visible. */
  startCamera(
    session: number,
    source: string,
    capture: NativeVoiceCameraCapture,
  ): Promise<NativeVoiceCameraStarted>;
  /** Unpublish and stop camera capture `capture`, releasing the pipeline and
   *  the device; a stale id is a no-op. */
  stopCamera(session: number, capture: number): Promise<void>;
  /** Start a camera preview outside any room (the settings tab) and resolve
   *  once its first frame arrives. */
  startCameraPreview(
    source: string,
    capture: NativeVoiceCameraCapture,
  ): Promise<NativeVoiceCameraPreview>;
  /** Stop the out-of-call camera preview. */
  stopCameraPreview(): Promise<void>;
  /** What can be shared, with thumbnails; enumerating is slow (one capture
   *  per source). */
  screenSources(): Promise<NativeVoiceScreenSources>;
  /** Start capturing `source` (replacing any running capture) and resolve
   *  once its first frame arrives — on Wayland after the portal dialog
   *  completes; a portal capture that ends before its first frame rejects
   *  with "screen capture portal did not start", any other failure before
   *  the first frame with its reason.
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
  /** Unpublish the share of capture `capture` but keep the capture running,
   *  so a codec republish can publish it again; a stale id is a no-op. */
  unpublishScreen(session: number, capture: number): Promise<void>;
  /** Publish the sound of the other applications as capture `capture`'s
   *  `ScreenShareAudio` track (E2EE as every track); resolves with the
   *  publication's sid. The audio lives as long as the capture and survives
   *  a codec republish and a Change source; rejects when `capture` is not
   *  running. A second call replaces the first. */
  publishScreenAudio(session: number, capture: number): Promise<string>;
  /** Unpublish screen audio `sid` and stop capturing the sound; a stale sid
   *  is a no-op. */
  unpublishScreenAudio(session: number, sid: string): Promise<void>;
  /** Unpublish and stop capture `capture`, releasing the capturer and any
   *  portal session; a stale id is a no-op. */
  stopScreen(session: number, capture: number): Promise<void>;
  /** Share `source` instead under the live, published share: a new capture
   *  starts beside it and takes the publication over (same sid) once its
   *  first frame arrives, then the old capture stops. Resolves with the new
   *  capture, which `stopScreen` then names; rejects, leaving the live share
   *  untouched, as `startScreen` does (a portal closed without a pick is
   *  "screen capture portal did not start"), or when no share is published. */
  changeScreen(
    session: number,
    source: string,
    capture: NativeVoiceScreenCapture,
  ): Promise<NativeVoiceScreenStarted>;
  /** Change the quality of the live, published share `capture` without a
   *  new pick: the running capture is re-paced and re-capped to `capture`'s
   *  `NativeVoiceScreenCapture`, then published again with `publish` at the
   *  size it now delivers (the host's `publish.width`/`height` is the
   *  fallback), which gives viewers a new sid. The share audio is untouched.
   *  Never rejects: see `NativeVoiceScreenQualityResult`. */
  setScreenQuality(
    session: number,
    capture: number,
    options: NativeVoiceScreenCapture,
    publish: NativeVoiceScreenOptions,
  ): Promise<NativeVoiceScreenQualityResult>;
  /** Use camera `source` instead under the live, published camera: a new
   *  capture starts beside it and takes the publication over (same sid, same
   *  preview socket) once its first frame arrives, then the old capture
   *  stops. Resolves with the new capture, which `stopCamera` then names;
   *  rejects, leaving the live camera untouched, when the device cannot be
   *  opened beside it or no camera is published. */
  changeCamera(
    session: number,
    source: string,
    capture: NativeVoiceCameraCapture,
  ): Promise<NativeVoiceCameraStarted>;
  debugInfo(): Promise<NativeVoiceResources>;
  /** Enumerate audio devices, in or out of a call. */
  listDevices(): Promise<NativeVoiceDevices>;
  /** Switch the session's capture (`audioinput`) or playout (`audiooutput`)
   *  device to a `listDevices` id; an empty id selects the host default. */
  setDevice(session: number, kind: "audioinput" | "audiooutput", deviceId: string): Promise<void>;
  /** Start the mic test: the chosen microphone, with the call's processing,
   *  gain and voice gate, played back on the chosen output (the echo
   *  canceller gets no reference); `monitor` skips the output and only
   *  reports levels. Replaces a running test or monitor. Resolves with the
   *  test's id once the streams are open; rejects with the host's reason, a
   *  call in progress being `NATIVE_MIC_TEST_IN_CALL`. */
  startMicTest(options: NativeMicTestOptions): Promise<number>;
  /** Apply a live change to test `test`; a stale id is a no-op. A device
   *  fallback rejects while the test plays on the default. */
  updateMicTest(test: number, update: NativeMicTestUpdate): Promise<void>;
  /** Stop test `test`; a stale id is a no-op. */
  stopMicTest(test: number): Promise<void>;
  /** The mic test's level reports and its end, for every test. Returns a
   *  synchronous unsubscribe that is safe to call before the host
   *  subscription has finished registering. */
  onMicTestEvent(handler: (envelope: NativeMicTestEnvelope) => void): () => void;
  /** Start the host's app-level device watch (idempotent, kept for the app's
   *  life) and subscribe to its changes: `handler` runs with the new lists each
   *  time the capture or playout devices change, in or out of a call. A
   *  restarting sound server is not reported as a change. Returns a
   *  synchronous unsubscribe that is safe to call before the host subscription
   *  has finished registering, as `onEvent`'s is. */
  watchDevices(handler: (devices: NativeVoiceDevices) => void): () => void;
  /** Play an app sound on output `deviceId` (empty: the default) at the
   *  app-sounds volume `gain`, in or out of a call. Resolves with an id for
   *  `stopSound`, or null when the host could not play it (no device, the
   *  stream failed to open), so the caller can fall back. Never rejects. */
  playSound(
    notes: readonly NativeToneNote[],
    deviceId: string,
    gain: number,
  ): Promise<number | null>;
  /** Cut sound `id` (a ring burst); an unknown or finished id is a no-op.
   *  Never rejects. */
  stopSound(id: number): Promise<void>;
  /** Room events for every session. Returns a synchronous unsubscribe that
   *  is safe to call before the host subscription has finished registering. */
  onEvent(handler: (envelope: NativeVoiceEnvelope) => void): () => void;
}
