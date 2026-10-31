/** The shared scope of one voice settings pane build. */
import type { MicProcessor } from "@lib/voice/micProcessor";
import type {
  NativeMicTestEnvelope,
  NativeMicTestUpdate,
} from "../../../platform/contracts/nativeVoice";
import type { InputMode } from "@lib/ui/inputMode";
import type { NoiseFloorTracker } from "@lib/voice/noiseFloor";

export type MicRegistrar = (stop: () => void) => void;
export type CameraRegistrar = (stream: MediaStream | null) => void;
export type CameraInvalidationRegistrar = (invalidate: () => void) => void;
export type NativePreviewRegistrar = (stop: () => void) => void;
export type NativeMicTestRegistrar = (stop: () => void) => void;
export type NativeDevicesRegistrar = NativeMicTestRegistrar;

/** The values one build of the voice settings pane makes, shared by its build steps. */
export interface VoiceTabScope {
  signal: AbortSignal;
  registerMic: MicRegistrar;
  stopMic: () => void;
  registerCamera: CameraRegistrar;
  registerCameraInvalidation: CameraInvalidationRegistrar;
  registerNativePreview: NativePreviewRegistrar;
  registerMicTest: NativeMicTestRegistrar;
  registerNativeDevices: NativeDevicesRegistrar;
  section: HTMLDivElement;
  // Linux voice runs in the native audio engine (docs/architecture/voice-e2ee.md):
  // its capture takes the input volume, sensitivity and automatic sensitivity
  // like the web processor, and reports its level in a call, in the mic test
  // and in the capture-only monitor the meter runs outside a call. The
  // webview's microphone is not the engine's, so the meter opens none there.
  nativeAudio: boolean;
  // The Android app has no output device choice and no screen sharing, so
  // those controls are left out; its Push to Talk is the talk button in a
  // call, not a bound key.
  android: boolean;
  // The mode the gate runs in: the saved choice, on every platform.
  currentMode: () => InputMode;
  // Five cards: when you transmit, what you speak into, what you hear, what
  // you show, and how your voice is processed.
  card: (title: string) => HTMLElement;
  inputModeCard: HTMLElement;
  micCard: HTMLElement;
  speakersCard: HTMLElement;
  cameraCard: HTMLElement;
  processingCard: HTMLElement;
  // The microphone's state at a glance, from the live meter below.
  micStatus: HTMLSpanElement;
  micStatusIcon: HTMLSpanElement;
  micStatusWord: HTMLSpanElement;
  micHeard: boolean | null;
  showMicState: (heard: boolean) => void;
  // Input device selector
  inputHeader: HTMLDivElement;
  inputSelect: HTMLSelectElement;
  defaultInputOpt: HTMLOptionElement;
  // Input Volume slider
  inputVolumeHeader: HTMLDivElement;
  inputVolumeRow: HTMLDivElement;
  savedInputVolume: number;
  /** The slider's current value, for a meter processor started after it moved. */
  inputVolumePercent: number;
  inputVolumeSlider: HTMLInputElement;
  inputVolumeLabel: HTMLSpanElement;
  // ── Mic level meter with draggable sensitivity threshold ────────
  sensitivityHeader: HTMLDivElement;
  // Automatic sensitivity: the gate finds its own threshold above the room's
  // noise, and the meter shows the level without a handle.
  autoSensitivity: boolean;
  autoRow: HTMLDivElement;
  autoToggle: HTMLDivElement;
  // Real-time mic level bar with embedded draggable threshold handle
  meterWrap: HTMLDivElement;
  meterBar: HTMLDivElement;
  meterLevel: HTMLDivElement;
  // A range, not a pointer-only div: the threshold is adjustable by keyboard
  // as well as drag (Q1 — every action reachable, no pointer-only control).
  meterThreshold: HTMLDivElement;
  // The value in words beside the meter, not only as the handle's position.
  sensitivityValue: HTMLSpanElement;
  // The bar on the threshold handle's axis, green while the gate is open, and
  // the pill saying whether the mic picks anything up, whatever the
  // sensitivity, held between syllables so it does not flicker.
  lastHeardAt: number;
  paintMeter: (level: number, gateOpen: boolean) => void;
  // ── Mic test: plays the processed microphone, after the voice gate, through
  // the chosen output, so you hear what a call would send. On the web it plays
  // the meter's processor; on the native engine the host loops its own capture
  // back to its own output (native_voice/mic_test.rs).
  micTestRow: HTMLDivElement;
  micTestInfo: HTMLDivElement;
  micTestDesc: HTMLDivElement;
  micTestButton: HTMLButtonElement;
  currentSensitivity: number;
  // ── Input mode: Voice Activity gates on the sensitivity above, Push to Talk
  // on a held key (whose controls show only in that mode).
  modeGroup: HTMLDivElement;
  pttBox: HTMLDivElement;
  modeButtons: Map<InputMode, HTMLButtonElement>;
  paintMode: () => void;
  chooseMode: (mode: InputMode) => void;
  modeLabels: Record<InputMode, string>;
  updateThresholdIndicator: (sensitivity: number) => void;
  paintSensitivity: () => void;
  /** Compute sensitivity % from a mouse/touch X position relative to the meter bar. */
  sensitivityFromPointer: (clientX: number) => number;
  /** The meter's detector, so a dragged threshold applies to it at once. */
  meterThresholdSetter: ((threshold: number | "auto") => void) | null;
  /** The meter's detector, so an Input Volume move relearns its noise floor. */
  meterResetFloor: (() => void) | null;
  /** The meter's processor, so the Enhanced NS toggle re-routes it at once. */
  meterProcessor: MicProcessor | null;
  /** The meter detector's last verdict, which the mic test's gate follows. */
  meterGated: boolean;
  /** Whether the mic test is on. Its playback follows the meter's processor
   *  across restarts and stops with it when the tab or the overlay closes. */
  micTesting: boolean;
  micTestAudio: HTMLAudioElement | null;
  // ── The native mic test's state (Linux): the host's id for the running
  // test, a counter that retires a start a later click or teardown
  // superseded, the noise-floor tracker automatic sensitivity retunes the
  // test's gate with, and the event subscription.
  nativeTestId: number | null;
  nativeTestRequest: number;
  nativeTestStarting: boolean;
  /** Whether the current (or starting) native test is the meter's
   *  capture-only monitor rather than the mic test. */
  nativeMonitoring: boolean;
  /** Whether a call's capture is reporting levels, which the monitor yields to. */
  callCapturing: boolean;
  nativeTestEndedEarly: number | null;
  nativeTestFloor: NoiseFloorTracker | null;
  unsubscribeTestEvents: (() => void) | null;
  /** The test's gate threshold, as the web meter gates its test playback:
   *  none in Push to Talk, the tab's sensitivity in Voice Activity. */
  nativeTestThreshold: () => number;
  makeNativeTestFloor: () => void;
  updateNativeTest: (update: NativeMicTestUpdate) => void;
  /** The mode or the automatic toggle changed: the gate starts over. */
  resetNativeTestGate: () => void;
  paintTestButton: (on: boolean) => void;
  /** Forget the running test: its id, floor, subscription and meter. */
  endNativeTest: () => void;
  onTestEvent: ({ test, event }: NativeMicTestEnvelope) => void;
  startNativeTest: (monitor?: boolean, attempt?: number) => Promise<void>;
  /** Button off, or the tab going away. */
  stopNativeTest: () => void;
  /** Gate the meter's output as a call would: on the detector in Voice
   *  Activity, open in Push to Talk (there the key decides, not the level). */
  syncMeterGate: () => void;
  startMicTestPlayback: (processor: MicProcessor) => void;
  stopMicTestPlayback: () => void;
  previewSensitivity: (val: number) => void;
  commitSensitivity: () => void;
  applySensitivity: (val: number) => void;
  onMove: (ev: PointerEvent) => void;
  // Output device selector
  outputHeader: HTMLDivElement;
  outputSelect: HTMLSelectElement;
  defaultOutputOpt: HTMLOptionElement;
  // Output Volume slider
  outputVolumeHeader: HTMLDivElement;
  outputVolumeRow: HTMLDivElement;
  storedOutputVolume: number;
  savedOutputVolume: number;
  outputVolumeSlider: HTMLInputElement;
  outputVolumeLabel: HTMLSpanElement;
  // Camera and screen share quality selectors: separate prefs, because a
  // screen share is mostly text and a camera is mostly motion.
  qualityGroup: (
    label: string,
    desc: string,
    pref: string,
    saved: string,
    options: Array<[string, string]>,
    disabled?: ReadonlySet<string>,
  ) => HTMLElement[];
  cameraQualityGroup: HTMLElement[];
  screenQualityGroup: HTMLElement[];
  // Screen share FPS selector
  fpsHeader: HTMLDivElement;
  fpsDesc: HTMLParagraphElement;
  fpsSelect: HTMLSelectElement;
  fpsLabels: Record<number, string>;
  fpsOptions: Array<[number, string]>;
  savedFps: number;
  // Linux: the Wayland portal negotiates 60 fps at most; the picker
  // greys 120 out there, so say it here as well.
  fpsGroup: (HTMLDivElement | HTMLSelectElement)[];
  // Video device selector
  videoHeader: HTMLDivElement;
  videoSelect: HTMLSelectElement;
  defaultVideoOpt: HTMLOptionElement;
  // Remote cameras play on their own; off, each one waits behind Watch stream.
  autoPlayRow: HTMLDivElement;
  autoPlayInfo: HTMLDivElement;
  // Camera preview
  previewWrap: HTMLDivElement;
  // Said in words, so an empty box is not a mystery.
  previewLabel: HTMLDivElement;
  previewVideo: HTMLVideoElement;
  // The codec choice. Off Linux the webview's own encoders decide what is
  // offered; on Linux the native engine offers VP8, Auto (VP8), and H.264 and
  // VP9 only when its probe says it can encode them.
  codecGroup: (h264Available: boolean, vp9Native?: boolean) => HTMLElement[];
  // Device names seen while this tab is open, to name one that is unplugged.
  deviceLabels: Map<string, string>;
  /**
   * (Re)fill the three device dropdowns from the current device list.
   *
   * Called on build and again on every `devicechange`, so unplugging a headset
   * with the panel open removes it from the list instead of leaving a dead
   * entry the user can select. A saved microphone or speaker that has vanished
   * stays the selection as a disabled "(disconnected)" entry: the voice
   * session keeps it too and switches back to it when it returns. A
   * vanished camera reads as "Default".
   */
  populateDevices: () => Promise<void>;
  onDeviceChange: () => void;
  // On Linux the host's hot-plug watch is the trigger (null elsewhere); it
  // also starts the watch, so the lists stay live outside a call.
  // Released through cleanupMic (a rebuild or the overlay closing), not an
  // "abort" listener: build() runs again on every rebuild.
  stopNative: (() => void) | null;
  // Race guard: prevent stale getUserMedia results from overwriting a newer
  // request. cleanupMic() invalidates both counters, so a stream resolving
  // after teardown is stopped instead of re-arming state nobody cleans up.
  cameraRequestId: number;
  micRequestId: number;
  stopCameraPreview: () => void;
  startCameraPreview: (deviceId: string) => void;
  previewDevice: (deviceId: string) => void;
  // Start the camera preview on the saved device, or on the default when
  // none was explicitly chosen: an unexplained empty 16:9 box reads as broken
  // (voice #22). The default device is only previewed when a camera exists.
  // Linux previews through the native backend (the native camera list); its
  // preview renderer is registered so teardown releases the host capture.
  savedVideoDevice: string;
  activeNativePreview: (() => void) | null;
  /** The Linux settings preview: capture natively (works while the window is
   *  hidden and exposes the same device ids the call will select) and draw the
   *  frame socket's `/camera` route onto the preview canvas. */
  startNativeCameraPreview: (deviceId: string) => Promise<void>;
  stopNativeCameraPreview: () => void;
  // Camera teardown on overlay close is already covered by the factory's
  // single signal.addEventListener("abort", cleanupMic), registered once
  // against the overlay-lifetime signal in createVoiceAudioTab — registering
  // another "abort" handler here too would add one more listener every time
  // the tab is rebuilt, since this function runs again on every build.
  // Mic level meter. It runs the call's own microphone processor
  // (lib/voice/micProcessor.ts: RNNoise when Enhanced Noise Suppression is on) over
  // a microphone opened with the call's capture settings, and the call's own
  // detector (lib/voice/audioPipeline.ts startVadDetector, same attack and hold)
  // at the same threshold. The bar is the loudest smoothed level (a ~10 ms
  // running RMS, the one the gate compares) the detector saw, on the threshold handle's axis; green is the gate open. So
  // what the meter shows is what the gate does. Opening the microphone with
  // other settings would also fight the call for the device: the browser can
  // hand the call this stream's processing instead of its own.
  // On the native engine the saved device id is the engine's, so the meter
  // shows the call capture's own level reports instead (startNativeMeter).
  startMicMeter: () => void;
  /** The native engine's meter: the capture's level reports, after its
   *  input volume and with its gate's verdict, so the bar shows what the gate
   *  does. In a call they are the call's own; outside one the host runs a
   *  capture-only monitor (a mic test without playout), which a call, the mic
   *  test or the tab closing ends. */
  startNativeMeter: () => void;
  /** Back to the empty bar: no level, no status. */
  clearMeter: () => void;
  /**
   * Release the meter's microphone while the call re-opens its own, then
   * meter again. The browser resolves a capture request against the streams
   * already open on the device, so a meter still holding the old settings
   * can hand them to the call's restart (and the reverse).
   */
  restartMeterAfter: (callRestart: Promise<void>) => void;
  // ── Audio processing toggles ──────────────────────────────────────
  audioToggles: ReadonlyArray<{
    key: string;
    label: string;
    desc: string;
    fallback: boolean;
  }>;
}
