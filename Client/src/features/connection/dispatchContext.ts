// Dispatch context — what the features/*/wsHandlers.ts modules receive from
// lib/dispatcher.ts. The dispatcher keeps every ws.on(...) registration (it is
// the only door server events enter the stores through); the handler modules
// export plain functions it calls with this context. Built once per
// wireDispatcher call, so a fresh login always starts with a fresh clock.
import type { WsClient } from "../../lib/ws";
import { createLogger } from "../../lib/logger";
import type { ApiClient } from "../../lib/api";
import type { ServerMessage } from "../../lib/types";

/** The dispatcher's logger, shared by every handler module so their lines keep the `[dispatcher]` tag. */
export const log = createLogger("dispatcher");

/** The payload type of one server message type. */
export type Payload<T extends ServerMessage["type"]> = Extract<
  ServerMessage,
  { type: T }
>["payload"];

/**
 * `api` is optional so tests can wire the dispatcher without a client; when
 * present it is used to refresh DM block state (GET /blocks) on ready, and to
 * refetch the active channel's history after a full-ready resync.
 */
export type DispatchApi = Pick<ApiClient, "listBlocks"> &
  Partial<
    Pick<
      ApiClient,
      | "updateProfile"
      | "getConfig"
      | "listEmoji"
      | "getMessages"
      | "getMessagesAround"
      | "listDmRequests"
      | "decideDmRequest"
      | "getDmChannels"
      | "getOwnModeration"
      | "getMyAppeals"
    >
  >;

/** Per-login reconnect state shared by the connection, ready and chat handlers. */
export interface ReconnectClock {
  hasAuthenticatedBefore: boolean;
  hasReceivedReadyBefore: boolean;
  lastReconnectHandshakeAt: number | null;
  serverClockSkewMs: number;
}

/** The socket surface a handler may use: send and disconnect, never subscribe. */
export type DispatchWs = Pick<WsClient, "send" | "disconnect">;

/**
 * A fresh reconnect clock. Called inside wireDispatcher, never at module
 * scope: module state would survive a logout and re-login and misclassify the
 * next session's live messages as replay.
 */
export function createReconnectClock(): ReconnectClock {
  return {
    // A second (or later) auth_ok/ready in this call's lifetime is always a
    // reconnect: wireDispatcher is called once per login (main.ts's
    // wirePostAuth), and every automatic reconnect fires its events through
    // these same long-lived listeners. Closure-scoped so a fresh login (a new
    // wireDispatcher call) always starts clean.
    hasAuthenticatedBefore: false,
    hasReceivedReadyBefore: false,
    // Set from the second-or-later auth_ok — the reconnect handshake time, in
    // THIS CLIENT's clock. A chat_message replay frame the transport delivers
    // after it is timestamped *before* it; a genuinely live message is
    // timestamped after. But payload.timestamp is the SERVER's created_at, in
    // the SERVER's clock — comparing it to this anchor directly mixes clock
    // domains, so the comparison below shifts the anchor into server time
    // using serverClockSkewMs first (see its declaration below).
    lastReconnectHandshakeAt: null,
    // Running estimate of (this client's clock) minus (the server's clock),
    // sampled from the most recently accepted live chat_message (Date.now() at
    // receipt minus that frame's own server timestamp). A self-hosted server
    // routinely runs without NTP or with a skewed TZ/clock, and comparing its
    // timestamps against lastReconnectHandshakeAt without this correction means
    // a lagging server clock makes every genuinely live message look like a
    // replay for the whole drift window after every reconnect — and with
    // persistent skew that never recovers. Network latency between the
    // server's send and this receipt biases the estimate positive, which nudges
    // the boundary computed below slightly EARLY relative to the server's true
    // clock; that is the safe direction — a missed replay suppression is at
    // worst a duplicate notification, while a false replay classification
    // silently drops one.
    serverClockSkewMs: 0,
  };
}

/** Lazily import the LiveKit session module. livekit-client (~1.3 MB) is kept
 *  out of the entry chunk; voice handlers load it on first use. Once a voice
 *  flow has started the module is cached, so this resolves in a microtask. */
export function livekitSession(): Promise<typeof import("../../lib/livekitSession")> {
  return import("../../lib/livekitSession");
}
