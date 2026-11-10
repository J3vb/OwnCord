// Shared field vocabularies and source-file paths for the client diagnostic event
// catalogue. Data only; used by eventCodes.ts and its part files.

export const SOURCES = {
  type: "enum",
  values: ["camera", "microphone", "screen_share", "screen_share_audio", "unknown"],
} as const;
export const PLATFORMS = {
  type: "enum",
  values: ["windows", "linux", "macos", "android", "browser", "unknown"],
} as const;
export const QUALITY_LIMITATION = {
  type: "enum",
  values: ["none", "cpu", "bandwidth", "other", "unknown"],
} as const;
export const MEDIA_ERRORS = {
  type: "enum",
  values: [
    "not_allowed",
    "not_found",
    "not_readable",
    "overconstrained",
    "abort",
    "security",
    "type",
    "unknown",
  ],
} as const;
export const STOP_REASONS = {
  type: "enum",
  values: ["user", "ended", "error", "left_voice", "replaced", "unknown"],
} as const;
export const GEN = { type: "int" } as const;
export const INT = { type: "int" } as const;
export const MS = { type: "ms" } as const;
export const BOOL = { type: "bool" } as const;
export const TOKEN = { type: "token" } as const;
export const HASH = { type: "hash" } as const;

export const WS = "src/lib/ws.ts";
export const WS_TIMERS = "src/lib/net/ws/wsTimers.ts";
export const WS_LIVENESS = "src/lib/net/ws/wsLiveness.ts";
export const WS_TRANSPORT = "src/lib/net/ws/wsTransport.ts";
export const WS_INBOUND = "src/lib/net/ws/wsInbound.ts";
export const WS_RECONNECT = "src/lib/net/ws/wsReconnect.ts";
export const ROOM_EVENTS = "src/lib/voice/roomEventHandlers.ts";
export const SCREEN = "src/features/voice/screenTrackStop.ts";
export const EXIT_WATCH = "src-tauri/src/exit_watch.rs";
export const CRASH_LOG = "src-tauri/src/crash_log.rs";
export const EXCEPTION_LOG = "src-tauri/src/exception_log.rs";
export const SYSTEM_CRASH = "src-tauri/src/system_crash_report.rs";
export const ANDROID_DIR = "src-tauri/gen/android/app/src/main/java/com/owncord/client";
export const ANDROID_EXITS = `${ANDROID_DIR}/ExitInfoPlugin.kt`;
export const ANDROID_CRASH = `${ANDROID_DIR}/NativeLog.kt`;
export const ANDROID_WEBVIEW = `${ANDROID_DIR}/RenderGoneClient.kt`;
export const EVENT_LOG = "src/lib/diagnostics/eventLog.ts";
export const APP_EVENTS = "src/lib/diagnostics/appEvents.ts";
export const VOICE_LOG = "src/lib/voice/voiceEventLog.ts";
export const WATCHDOG = "src/lib/voice/cameraStallWatchdog.ts";
export const DIAGNOSTICS = "src/lib/voice/livekitDiagnostics.ts";
export const SCREEN_CHANGE = "src/features/voice/screenshareChange.ts";

export const CAMERA_STATS = {
  frames_sent: INT,
  encoder: TOKEN,
  hardware_encoder: BOOL,
  quality_limitation: QUALITY_LIMITATION,
  width: INT,
  height: INT,
  fps: INT,
  active_layers: INT,
} as const;
