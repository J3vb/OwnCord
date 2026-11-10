// The client diagnostic event catalogue: every event code the rolling event
// log may record, its plain label, the file that emits it, and the only fields
// it may carry. Data only. The recorder drops any field not listed here, and
// docs/architecture/client-diagnostics.md is the readable copy of this table.
//
// Privacy rule: no field type holds free text. A value is a number, a boolean,
// one of a fixed list of words, a per-report hash or pseudonym, a host name
// without path, a version, or a short token from a vocabulary the browser or OS
// defines (codec, encoder, exception code). Anything else is dropped.

import {
  PLATFORMS,
  INT,
  MS,
  TOKEN,
  WS_TIMERS,
  WS_LIVENESS,
  EXIT_WATCH,
  CRASH_LOG,
  EXCEPTION_LOG,
  SYSTEM_CRASH,
  ANDROID_EXITS,
  ANDROID_CRASH,
  ANDROID_WEBVIEW,
  EVENT_LOG,
  APP_EVENTS,
} from "./eventCodesShared";
import { MEDIA_EVENT_CODES } from "./eventCodesMedia";
import { VOICE_NET_EVENT_CODES } from "./eventCodesVoice";

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

export const EVENT_CODES = {
  "app.started": {
    label: "App started", // i18n-exempt: support bundle text, never shown in the app
    owners: [APP_EVENTS],
    dataClasses: [],
    fields: {
      app_version: { type: "version" },
      platform: PLATFORMS,
      webview_version: { type: "version" },
    },
  },
  "app.resumed": {
    label: "Computer woke up", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS_TIMERS],
    dataClasses: [],
    fields: { asleep_ms: MS },
  },
  "app.visibility": {
    label: "Window shown or hidden", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS_LIVENESS],
    dataClasses: [],
    fields: { state: { type: "enum", values: ["visible", "hidden", "minimized", "restored"] } },
  },
  "app.network": {
    label: "Network went online or offline", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS_LIVENESS],
    dataClasses: [],
    fields: { state: { type: "enum", values: ["online", "offline"] } },
  },

  "native.crash": {
    label: "App crashed last time", // i18n-exempt: support bundle text, never shown in the app
    owners: [APP_EVENTS, CRASH_LOG, EXCEPTION_LOG, SYSTEM_CRASH, ANDROID_CRASH, ANDROID_EXITS],
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
    label: "How the last run ended", // i18n-exempt: support bundle text, never shown in the app
    owners: [APP_EVENTS, EXIT_WATCH, ANDROID_EXITS],
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
  "native.webview_process_failed": {
    label: "A webview helper process failed", // i18n-exempt: support bundle text, never shown in the app
    owners: [APP_EVENTS, EXIT_WATCH, ANDROID_WEBVIEW],
    dataClasses: [],
    fields: {
      process: { type: "enum", values: ["browser", "renderer", "gpu", "utility", "unknown"] },
      reason: {
        type: "enum",
        values: ["exited", "crashed", "unresponsive", "killed", "out_of_memory", "unknown"],
      },
    },
  },

  ...MEDIA_EVENT_CODES,
  ...VOICE_NET_EVENT_CODES,

  "events.dropped": {
    label: "Similar events left out", // i18n-exempt: support bundle text, never shown in the app
    owners: [EVENT_LOG],
    dataClasses: [],
    fields: { dropped_code: { type: "code" }, count: INT },
  },
} as const satisfies Readonly<Record<string, EventCodeSpec>>;

export type EventCode = keyof typeof EVENT_CODES;
