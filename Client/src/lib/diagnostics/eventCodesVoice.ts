// Diagnostic event catalogue: voice, ICE and WebSocket events.
// Data only; assembled into EVENT_CODES by eventCodes.ts.

import {
  GEN,
  INT,
  MS,
  BOOL,
  TOKEN,
  WS,
  WS_TRANSPORT,
  WS_INBOUND,
  WS_RECONNECT,
  ROOM_EVENTS,
  VOICE_LOG,
  DIAGNOSTICS,
} from "./eventCodesShared";

export const VOICE_NET_EVENT_CODES = {
  "voice.joined": {
    label: "Joined a voice channel", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [19],
    fields: { channel: { type: "pseudonym" }, native: BOOL, after_ms: MS },
  },
  "voice.left": {
    label: "Left the voice channel", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [19],
    fields: { channel: { type: "pseudonym" } },
  },
  "voice.reconnecting": {
    label: "Voice is reconnecting", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { attempt: INT, kind: { type: "enum", values: ["signal", "media", "full"] } },
  },
  "voice.reconnected": {
    label: "Voice reconnected", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
    dataClasses: [],
    fields: { after_ms: MS },
  },
  "voice.disconnected": {
    label: "Voice disconnected", // i18n-exempt: support bundle text, never shown in the app
    owners: [VOICE_LOG],
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
    label: "Call encryption changed", // i18n-exempt: support bundle text, never shown in the app
    owners: [ROOM_EVENTS],
    dataClasses: [],
    fields: { state: { type: "enum", values: ["on", "off", "error"] } },
  },

  "ice.state": {
    label: "Media connection state changed", // i18n-exempt: support bundle text, never shown in the app
    owners: [DIAGNOSTICS],
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
    label: "Media route chosen", // i18n-exempt: support bundle text, never shown in the app
    owners: [DIAGNOSTICS],
    dataClasses: [],
    fields: {
      local_type: { type: "enum", values: ["host", "srflx", "prflx", "relay", "unknown"] },
      remote_type: { type: "enum", values: ["host", "srflx", "prflx", "relay", "unknown"] },
      protocol: { type: "enum", values: ["udp", "tcp", "tls", "unknown"] },
    },
  },

  "ws.connecting": {
    label: "Connecting to the server", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS],
    dataClasses: [],
    fields: { generation: GEN, attempt: INT, host: { type: "host" } },
  },
  "ws.open": {
    label: "Server connection open", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS_TRANSPORT],
    dataClasses: [],
    fields: { generation: GEN },
  },
  "ws.ready": {
    label: "Server connection ready", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS_INBOUND],
    dataClasses: [],
    fields: { generation: GEN, after_ms: MS },
  },
  "ws.closed": {
    label: "Server connection closed", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS_TRANSPORT],
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
    label: "Reconnect to the server scheduled", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS_RECONNECT],
    dataClasses: [],
    fields: { generation: GEN, attempt: INT, delay_ms: MS },
  },
  "ws.superseded": {
    label: "A newer server connection replaced this one", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS],
    dataClasses: [],
    fields: { generation: GEN, by_generation: GEN },
  },
  "ws.stale_event": {
    label: "Event from an old server connection ignored", // i18n-exempt: support bundle text, never shown in the app
    owners: [WS, WS_TRANSPORT],
    dataClasses: [],
    fields: { generation: GEN, live_generation: GEN },
  },
  "ws.frame_invalid": {
    label: "Server message with the wrong shape dropped", // i18n-exempt: support bundle text, never shown in the app
    owners: ["src/lib/net/wsFrame.ts"],
    dataClasses: [],
    fields: { type: TOKEN, field: TOKEN },
  },
} as const;
