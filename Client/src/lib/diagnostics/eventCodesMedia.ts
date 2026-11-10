// Diagnostic event catalogue: camera, microphone, track and screen share events.
// Data only; assembled into EVENT_CODES by eventCodes.ts.

import {
  SOURCES,
  MEDIA_ERRORS,
  STOP_REASONS,
  INT,
  MS,
  BOOL,
  TOKEN,
  HASH,
  SCREEN,
  VOICE_LOG,
  WATCHDOG,
  SCREEN_CHANGE,
  CAMERA_STATS,
} from "./eventCodesShared";

export const MEDIA_EVENT_CODES = {
  "camera.started": {
    label: "Camera started", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
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
    label: "Camera stopped", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { reason: STOP_REASONS },
  },
  "camera.device_changed": {
    label: "Camera device changed", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { device: HASH },
  },
  "camera.ended": {
    label: "Browser ended the camera track", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: {},
  },
  "camera.muted": {
    label: "Camera track muted", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { by: { type: "enum", values: ["browser", "user"] } },
  },
  "camera.unmuted": {
    label: "Camera track unmuted", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { by: { type: "enum", values: ["browser", "user"] } },
  },
  "camera.permission_error": {
    label: "Camera could not open", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { error: MEDIA_ERRORS },
  },
  "camera.stalled": {
    label: "Camera stopped sending frames", // i18n-exempt: support bundle text, never shown in the app
    owners: [WATCHDOG],
    dataClasses: [],
    fields: CAMERA_STATS,
  },
  "camera.resumed": {
    label: "Camera sends frames again", // i18n-exempt: support bundle text, never shown in the app
    owners: [WATCHDOG],
    dataClasses: [],
    fields: { ...CAMERA_STATS, gap_ms: MS },
  },

  "mic.started": {
    label: "Microphone started", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { device: HASH, sample_rate: INT },
  },
  "mic.stopped": {
    label: "Microphone stopped", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { reason: STOP_REASONS },
  },
  "mic.device_changed": {
    label: "Microphone device changed", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { device: HASH },
  },
  "mic.ended": {
    label: "Browser ended the microphone track", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: {},
  },
  "mic.permission_error": {
    label: "Microphone could not open", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { error: MEDIA_ERRORS },
  },

  "track.published": {
    label: "Track published", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { source: SOURCES, codec: TOKEN, simulcast: BOOL },
  },
  "track.unpublished": {
    label: "Track unpublished", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { source: SOURCES, reason: STOP_REASONS },
  },
  "track.replaced": {
    label: "Track replaced", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG, SCREEN_CHANGE],
    dataClasses: [],
    fields: { source: SOURCES },
  },
  "track.layers_changed": {
    label: "Simulcast layers turned on or off", // i18n-exempt: support bundle text, never shown in the app
    owners: [WATCHDOG],
    dataClasses: [],
    fields: { source: SOURCES, active_layers: INT },
  },
  "track.subscribed": {
    label: "Started receiving a track", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [1],
    fields: { source: SOURCES, participant: { type: "pseudonym" } },
  },
  "track.unsubscribed": {
    label: "Stopped receiving a track", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [1],
    fields: { source: SOURCES, participant: { type: "pseudonym" } },
  },
  "track.subscription_failed": {
    label: "Could not receive a track", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [1],
    fields: { participant: { type: "pseudonym" } },
  },

  "share.started": {
    label: "Screen share started", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
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
    label: "Screen share stopped", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { reason: STOP_REASONS },
  },
  "share.ended": {
    label: "Browser ended the screen share", // i18n-exempt: support bundle text, never shown in the app
    owners: [SCREEN],
    dataClasses: [],
    fields: {},
  },
  "share.source_changed": {
    label: "Screen share source changed", // i18n-exempt: support bundle text, never shown in the app
    owners: [SCREEN_CHANGE],
    dataClasses: [],
    fields: { surface: { type: "enum", values: ["monitor", "window", "browser", "unknown"] } },
  },
} as const;
