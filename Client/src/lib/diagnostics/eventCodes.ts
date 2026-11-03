// The client diagnostic event catalogue: every event code the rolling event
// log may record, its plain label, the file that emits it, and the only fields
// it may carry. Data only. The recorder drops any field not listed here, and
// docs/architecture/client-diagnostics.md is the readable copy of this table.
//
// Privacy rule: no field type holds free text. A value is a number, a boolean,
// one of a fixed list of words, a per-report hash or pseudonym, a host name
// without path, a version, or a short token from a vocabulary the browser or OS
// defines (codec, encoder, exception code). Anything else is dropped.

/** How a field's value is checked before it is stored. */
export type FieldSpec =
  | { readonly type: "enum"; readonly values: readonly string[] }
  /** A whole number: a count, size in pixels, frames per second, a close code. */
  | { readonly type: "int" }
  /** A duration in milliseconds. */
  | { readonly type: "ms" }
  | { readonly type: "bool" }
  /** A per-report hash of a value that may hold a name, such as a device label. */
  | { readonly type: "hash" }
  /** A per-report pseudonym of a user or channel id; never the name. */
  | { readonly type: "pseudonym" }
  /** A host name only: no scheme, port, path or query. */
  | { readonly type: "host" }
  /** A dotted version such as 2.7.0 or 131.0.2903.70. */
  | { readonly type: "version" }
  /** A short token from a vocabulary the browser or OS defines. */
  | { readonly type: "token" }
  /** Another code from this catalogue. */
  | { readonly type: "code" };

export type FieldType = FieldSpec["type"];

export const FIELD_TYPES: readonly FieldType[] = [
  "enum",
  "int",
  "ms",
  "bool",
  "hash",
  "pseudonym",
  "host",
  "version",
  "token",
  "code",
];

/** Patterns the recorder applies to the string-valued field types. */
export const FIELD_PATTERNS = {
  host: /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
  version: /^\d{1,6}(\.\d{1,6}){0,3}$/,
  token: /^[A-Za-z0-9_.-]{1,48}$/,
  hash: /^[0-9a-f]{8}$/,
  pseudonym: /^[a-z]\d{1,4}$/,
} as const;

/**
 * Who can be identified from a code's fields, in the data-lifecycle class
 * numbers the server's support bundle uses (docs/architecture/data-lifecycle.md).
 * An empty list means technical facts only.
 */
export type DataClass = 1 | 19;

export const EVENT_AREAS = [
  "app",
  "native",
  "camera",
  "mic",
  "track",
  "share",
  "voice",
  "ice",
  "ws",
  "events",
] as const;

export type EventArea = (typeof EVENT_AREAS)[number];

export interface EventCodeSpec {
  readonly label: string;
  /** Files that call record() for this code, relative to Client/. */
  readonly owners: readonly string[];
  readonly dataClasses: readonly DataClass[];
  readonly fields: Readonly<Record<string, FieldSpec>>;
}

/** Caps for the rolling event log. Oldest events go first. */
export const EVENT_LOG_CAPS = {
  maxEvents: 2000,
  maxBytes: 512 * 1024,
  maxAgeMs: 30 * 60 * 1000,
  /** Per code, per rolling minute; the rest are counted in events.dropped. */
  perCodePerMinute: 30,
} as const;

/**
 * The camera counts as stalled when framesSent stays flat for this long on every
 * active camera layer while the track is live and not muted. Layers the SFU
 * paused because nobody watches do not count.
 */
export const CAMERA_STALL_THRESHOLD_MS = 2000;

const SOURCES = {
  type: "enum",
  values: ["camera", "microphone", "screen_share", "screen_share_audio", "unknown"],
} as const;
const PLATFORMS = {
  type: "enum",
  values: ["windows", "linux", "macos", "android", "browser", "unknown"],
} as const;
const QUALITY_LIMITATION = {
  type: "enum",
  values: ["none", "cpu", "bandwidth", "other", "unknown"],
} as const;
const MEDIA_ERRORS = {
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
const STOP_REASONS = {
  type: "enum",
  values: ["user", "ended", "error", "left_voice", "replaced", "unknown"],
} as const;
const GEN = { type: "int" } as const;
const INT = { type: "int" } as const;
const MS = { type: "ms" } as const;
const BOOL = { type: "bool" } as const;
const TOKEN = { type: "token" } as const;
const HASH = { type: "hash" } as const;

const WS = "src/lib/ws.ts";
const MEDIA = "src/features/voice/mediaControl.ts";
const DEVICES = "src/lib/voice/deviceManager.ts";
const ROOM_EVENTS = "src/lib/voice/roomEventHandlers.ts";
const RECONNECT = "src/lib/voice/livekitReconnect.ts";
const LIFECYCLE = "src/features/voice/roomLifecycle.ts";
const SCREEN = "src/lib/voice/screenShare.ts";
const E2EE = "src/lib/voice/livekitE2EE.ts";
const MAIN = "src/main.ts";
const EXIT_WATCH = "src-tauri/src/exit_watch.rs";
const CRASH_LOG = "src-tauri/src/crash_log.rs";
const SYSTEM_CRASH = "src-tauri/src/system_crash_report.rs";
const ANDROID = "src-tauri/gen/android/app/src/main/java/com/owncord/client/MainActivity.kt";
const EVENT_LOG = "src/lib/diagnostics/eventLog.ts";

const CAMERA_STATS = {
  frames_sent: INT,
  encoder: TOKEN,
  hardware_encoder: BOOL,
  quality_limitation: QUALITY_LIMITATION,
  width: INT,
  height: INT,
  fps: INT,
  active_layers: INT,
} as const;

export const EVENT_CODES = {
  "app.started": {
    label: "App started",
    owners: [MAIN],
    dataClasses: [],
    fields: {
      app_version: { type: "version" },
      platform: PLATFORMS,
      webview_version: { type: "version" },
    },
  },
  "app.suspended": { label: "Computer went to sleep", owners: [MAIN], dataClasses: [], fields: {} },
  "app.resumed": {
    label: "Computer woke up",
    owners: [MAIN],
    dataClasses: [],
    fields: { asleep_ms: MS },
  },
  "app.visibility": {
    label: "Window shown or hidden",
    owners: [MAIN],
    dataClasses: [],
    fields: { state: { type: "enum", values: ["visible", "hidden", "minimized", "restored"] } },
  },
  "app.network": {
    label: "Network went online or offline",
    owners: [MAIN],
    dataClasses: [],
    fields: { state: { type: "enum", values: ["online", "offline"] } },
  },

  "native.crash": {
    label: "App crashed last time",
    owners: [CRASH_LOG, SYSTEM_CRASH, ANDROID],
    dataClasses: [],
    fields: {
      platform: PLATFORMS,
      kind: {
        type: "enum",
        values: ["signal", "exception", "panic", "x_error", "jvm", "native", "unknown"],
      },
      code: TOKEN,
      module: TOKEN,
      age_ms: MS,
    },
  },
  "native.exit": {
    label: "How the last run ended",
    owners: [EXIT_WATCH, ANDROID],
    dataClasses: [],
    fields: {
      platform: PLATFORMS,
      kind: {
        type: "enum",
        values: [
          "normal",
          "signal",
          "unclean",
          "anr",
          "low_memory",
          "killed_by_user",
          "killed_by_system",
          "unknown",
        ],
      },
      last_seen_ms: MS,
      memory_mb: INT,
      hang_ms: MS,
    },
  },
  "native.hang": {
    label: "App stopped answering",
    owners: [EXIT_WATCH],
    dataClasses: [],
    fields: { thread: { type: "enum", values: ["main", "webview"] }, duration_ms: MS },
  },
  "native.hang_recovered": {
    label: "App answered again",
    owners: [EXIT_WATCH],
    dataClasses: [],
    fields: { thread: { type: "enum", values: ["main", "webview"] }, duration_ms: MS },
  },
  "native.webview_process_failed": {
    label: "A webview helper process failed",
    owners: [EXIT_WATCH, ANDROID],
    dataClasses: [],
    fields: {
      process: { type: "enum", values: ["browser", "renderer", "gpu", "utility", "unknown"] },
      reason: {
        type: "enum",
        values: ["exited", "crashed", "unresponsive", "killed", "out_of_memory", "unknown"],
      },
    },
  },

  "camera.started": {
    label: "Camera started",
    owners: [MEDIA],
    dataClasses: [],
    fields: {
      device: HASH,
      width: INT,
      height: INT,
      fps: INT,
      requested_width: INT,
      requested_height: INT,
      requested_fps: INT,
      facing: { type: "enum", values: ["user", "environment", "unknown"] },
    },
  },
  "camera.stopped": {
    label: "Camera stopped",
    owners: [MEDIA],
    dataClasses: [],
    fields: { reason: STOP_REASONS },
  },
  "camera.device_changed": {
    label: "Camera device changed",
    owners: [DEVICES],
    dataClasses: [],
    fields: { device: HASH },
  },
  "camera.ended": {
    label: "Browser ended the camera track",
    owners: [MEDIA],
    dataClasses: [],
    fields: {},
  },
  "camera.muted": {
    label: "Camera track muted",
    owners: [MEDIA],
    dataClasses: [],
    fields: { by: { type: "enum", values: ["browser", "user"] } },
  },
  "camera.unmuted": {
    label: "Camera track unmuted",
    owners: [MEDIA],
    dataClasses: [],
    fields: { by: { type: "enum", values: ["browser", "user"] } },
  },
  "camera.permission_error": {
    label: "Camera could not open",
    owners: [MEDIA],
    dataClasses: [],
    fields: { error: MEDIA_ERRORS },
  },
  "camera.stalled": {
    label: "Camera stopped sending frames",
    owners: [MEDIA],
    dataClasses: [],
    fields: CAMERA_STATS,
  },
  "camera.resumed": {
    label: "Camera sends frames again",
    owners: [MEDIA],
    dataClasses: [],
    fields: { ...CAMERA_STATS, gap_ms: MS },
  },

  "mic.started": {
    label: "Microphone started",
    owners: [MEDIA],
    dataClasses: [],
    fields: { device: HASH, sample_rate: INT },
  },
  "mic.stopped": {
    label: "Microphone stopped",
    owners: [MEDIA],
    dataClasses: [],
    fields: { reason: STOP_REASONS },
  },
  "mic.device_changed": {
    label: "Microphone device changed",
    owners: [DEVICES],
    dataClasses: [],
    fields: { device: HASH },
  },
  "mic.ended": {
    label: "Browser ended the microphone track",
    owners: [MEDIA],
    dataClasses: [],
    fields: {},
  },
  "mic.permission_error": {
    label: "Microphone could not open",
    owners: [MEDIA],
    dataClasses: [],
    fields: { error: MEDIA_ERRORS },
  },

  "track.published": {
    label: "Track published",
    owners: [LIFECYCLE],
    dataClasses: [],
    fields: { source: SOURCES, codec: TOKEN, simulcast: BOOL },
  },
  "track.unpublished": {
    label: "Track unpublished",
    owners: [LIFECYCLE],
    dataClasses: [],
    fields: { source: SOURCES, reason: STOP_REASONS },
  },
  "track.replaced": {
    label: "Track replaced",
    owners: [MEDIA],
    dataClasses: [],
    fields: { source: SOURCES },
  },
  "track.layers_changed": {
    label: "Simulcast layers turned on or off",
    owners: [ROOM_EVENTS],
    dataClasses: [],
    fields: { source: SOURCES, active_layers: INT },
  },
  "track.subscribed": {
    label: "Started receiving a track",
    owners: [ROOM_EVENTS],
    dataClasses: [1],
    fields: { source: SOURCES, participant: { type: "pseudonym" } },
  },
  "track.unsubscribed": {
    label: "Stopped receiving a track",
    owners: [ROOM_EVENTS],
    dataClasses: [1],
    fields: { source: SOURCES, participant: { type: "pseudonym" } },
  },
  "track.subscription_failed": {
    label: "Could not receive a track",
    owners: [ROOM_EVENTS],
    dataClasses: [1],
    fields: { participant: { type: "pseudonym" } },
  },

  "share.started": {
    label: "Screen share started",
    owners: [SCREEN],
    dataClasses: [],
    fields: {
      surface: { type: "enum", values: ["monitor", "window", "browser", "unknown"] },
      width: INT,
      height: INT,
      fps: INT,
      native: BOOL,
    },
  },
  "share.stopped": {
    label: "Screen share stopped",
    owners: [SCREEN],
    dataClasses: [],
    fields: { reason: STOP_REASONS },
  },
  "share.ended": {
    label: "Browser ended the screen share",
    owners: [SCREEN],
    dataClasses: [],
    fields: {},
  },
  "share.source_changed": {
    label: "Screen share source changed",
    owners: [SCREEN],
    dataClasses: [],
    fields: { surface: { type: "enum", values: ["monitor", "window", "browser", "unknown"] } },
  },

  "voice.joined": {
    label: "Joined a voice channel",
    owners: [LIFECYCLE],
    dataClasses: [19],
    fields: { channel: { type: "pseudonym" }, native: BOOL, after_ms: MS },
  },
  "voice.left": {
    label: "Left the voice channel",
    owners: [LIFECYCLE],
    dataClasses: [19],
    fields: { channel: { type: "pseudonym" } },
  },
  "voice.reconnecting": {
    label: "Voice is reconnecting",
    owners: [ROOM_EVENTS, RECONNECT],
    dataClasses: [],
    fields: { attempt: INT, kind: { type: "enum", values: ["signal", "media", "full"] } },
  },
  "voice.reconnected": {
    label: "Voice reconnected",
    owners: [ROOM_EVENTS, RECONNECT],
    dataClasses: [],
    fields: { after_ms: MS },
  },
  "voice.disconnected": {
    label: "Voice disconnected",
    owners: [ROOM_EVENTS],
    dataClasses: [],
    fields: {
      reason: {
        type: "enum",
        values: [
          "unknown_reason",
          "client_initiated",
          "duplicate_identity",
          "server_shutdown",
          "participant_removed",
          "room_deleted",
          "state_mismatch",
          "join_failure",
          "migration",
          "signal_close",
          "room_closed",
          "user_unavailable",
          "user_rejected",
          "sip_trunk_failure",
          "connection_timeout",
          "media_failure",
        ],
      },
      unexpected: BOOL,
    },
  },
  "voice.encryption": {
    label: "Call encryption changed",
    owners: [E2EE],
    dataClasses: [],
    fields: { state: { type: "enum", values: ["on", "off", "error"] } },
  },

  "ice.state": {
    label: "Media connection state changed",
    owners: [ROOM_EVENTS],
    dataClasses: [],
    fields: {
      transport: { type: "enum", values: ["publisher", "subscriber"] },
      state: {
        type: "enum",
        values: ["new", "checking", "connected", "completed", "failed", "disconnected", "closed"],
      },
    },
  },
  "ice.route": {
    label: "Media route chosen",
    owners: [ROOM_EVENTS],
    dataClasses: [],
    fields: {
      local_type: { type: "enum", values: ["host", "srflx", "prflx", "relay", "unknown"] },
      remote_type: { type: "enum", values: ["host", "srflx", "prflx", "relay", "unknown"] },
      protocol: { type: "enum", values: ["udp", "tcp", "tls", "unknown"] },
    },
  },

  "ws.connecting": {
    label: "Connecting to the server",
    owners: [WS],
    dataClasses: [],
    fields: { generation: GEN, attempt: INT, host: { type: "host" } },
  },
  "ws.open": {
    label: "Server connection open",
    owners: [WS],
    dataClasses: [],
    fields: { generation: GEN },
  },
  "ws.ready": {
    label: "Server connection ready",
    owners: [WS],
    dataClasses: [],
    fields: { generation: GEN, after_ms: MS },
  },
  "ws.closed": {
    label: "Server connection closed",
    owners: [WS],
    dataClasses: [],
    fields: {
      generation: GEN,
      close_code: INT,
      close_class: {
        type: "enum",
        values: [
          "normal",
          "going_away",
          "protocol",
          "auth",
          "policy",
          "server_error",
          "abnormal",
          "other",
        ],
      },
    },
  },
  "ws.reconnect_scheduled": {
    label: "Reconnect to the server scheduled",
    owners: [WS],
    dataClasses: [],
    fields: { generation: GEN, attempt: INT, delay_ms: MS },
  },
  "ws.superseded": {
    label: "A newer server connection replaced this one",
    owners: [WS],
    dataClasses: [],
    fields: { generation: GEN, by_generation: GEN },
  },
  "ws.stale_event": {
    label: "Event from an old server connection ignored",
    owners: [WS],
    dataClasses: [],
    fields: { generation: GEN, live_generation: GEN },
  },

  "events.dropped": {
    label: "Similar events left out",
    owners: [EVENT_LOG],
    dataClasses: [],
    fields: { dropped_code: { type: "code" }, count: INT },
  },
} as const satisfies Readonly<Record<string, EventCodeSpec>>;

export type EventCode = keyof typeof EVENT_CODES;
