// The transport's reports turned into the app's reaction: socket open and
// closed (the connection state machine), and the certificate trust events.

import type { SocketConnectionState, SocketRetryHint } from "../../../platform/contracts/socket";
import { createLogger } from "../../logger";
import { recordEvent } from "../../diagnostics/eventSink";
import { parseStoredFingerprint, type CertTofuEvent } from "../../wsConfig";
import { normalizeHostForCertCompare } from "../hostNormalize";
import { buildAuthFrame, hasIdentityKeyProvider, resolveIdentityKey } from "./authFrame";
import { currentGeneration } from "./generation";
import { stopHeartbeat, stopLiveness } from "./wsLiveness";
import { scheduleReconnect } from "./wsReconnect";
import { sendMessage } from "./wsSend";
import { setState, type WsState } from "./wsState";
import { cancelGapResume, cancelReconnect, stopWakeListeners } from "./wsTimers";

const log = createLogger("ws");

// The transport's proxy lifecycle: an open proxy is still unauthenticated until
// `auth_ok` arrives, and a closed one starts the reconnect policy unless the
// close was intentional.
export function handleTransportState(
  s: WsState,
  next: SocketConnectionState,
  retryHint?: SocketRetryHint,
): void {
  if (next === "connected") {
    onSocketOpen(s);
  } else if (next === "disconnected") {
    onSocketClosed(s, retryHint);
  }
  // "connecting" — this client sets that state itself before asking the
  // transport to dial, so a report here is already reflected.
}

function onSocketOpen(s: WsState): void {
  s.proxyOpen = true;
  s.socketId++;
  s.lastCseq = 0;
  cancelGapResume(s);
  s.connectFailureCode = null;
  s.socketGeneration = currentGeneration();
  recordEvent("ws.open", { generation: currentGeneration() });
  log.info("WebSocket open, sending auth", {
    host: s.config?.host ?? "unknown",
    isReconnect: s.reconnectAttempt > 0,
    lastSeq: s.lastSeq,
  });
  setState(s, "authenticating");
  if (s.config === null) return;
  const frame = buildAuthFrame(s, s.config.token);
  if (!hasIdentityKeyProvider()) {
    sendMessage(s, { type: "auth", payload: frame });
    return;
  }
  sendAuthWithIdentity(s, s.config.host, frame);
}

// The key is looked up asynchronously, so this attempt must still own the
// socket when the lookup settles: a newer socket, a disconnect() or a newer
// connect() makes this frame stale and it is dropped. The ownership check is
// the first thing the continuation runs, in the same step as the send it guards.
function sendAuthWithIdentity(s: WsState, host: string, frame: object): void {
  const attemptSocketId = s.socketId;
  const attemptGen = currentGeneration();
  void resolveIdentityKey(s, host).then((identityKey) => {
    if (s.socketId !== attemptSocketId || currentGeneration() !== attemptGen || !s.proxyOpen) {
      if (currentGeneration() !== attemptGen) {
        recordEvent("ws.stale_event", {
          generation: attemptGen,
          live_generation: currentGeneration(),
        });
      }
      return;
    }
    sendMessage(s, {
      type: "auth",
      payload: {
        ...frame,
        ...(identityKey !== null ? { identity_public_key: identityKey } : {}),
      },
    });
  });
}

function closeClass(s: WsState): "normal" | "policy" | "other" | "abnormal" {
  if (s.intentionalClose) return "normal";
  if (s.certMismatchBlock) return "policy";
  return s.connectFailureCode !== null ? "other" : "abnormal";
}

function onSocketClosed(s: WsState, retryHint?: SocketRetryHint): void {
  s.proxyOpen = false;
  cancelGapResume(s);
  // Record the transport's distinct failure code, if any: a failed connect
  // can carry one (a certificate failure today), and a plain close clears
  // it. The pre-auth deadline reads this to name the failure.
  s.connectFailureCode = retryHint?.errorCode ?? null;
  recordEvent("ws.closed", {
    generation: s.socketGeneration,
    close_class: closeClass(s),
  });
  log.info("WebSocket closed", {
    host: s.config?.host ?? "unknown",
    intentional: s.intentionalClose,
    certBlocked: s.certMismatchBlock,
  });
  stopHeartbeat(s);
  stopLiveness(s);
  // A close the loop will retry keeps the wake listeners, so the
  // network or the screen coming back can cut the backoff short.
  if (s.intentionalClose || s.certMismatchBlock) stopWakeListeners(s);
  if (!s.intentionalClose) {
    scheduleReconnect(s, retryHint?.retryAfterMs);
  } else {
    setState(s, "disconnected");
  }
}

// The transport's cert-tofu reports, already routed by status.
export function handleCertFirstUse(s: WsState, raw: CertTofuEvent): void {
  log.warn("TOFU: first-use certificate — awaiting user confirmation", {
    host: raw.host,
    fingerprint: raw.fingerprint,
  });
  for (const listener of s.certFirstUseListeners) {
    listener(raw);
  }
}

export function handleCertMismatch(s: WsState, raw: CertTofuEvent): void {
  const evt: CertTofuEvent = {
    ...raw,
    storedFingerprint: raw.storedFingerprint ?? parseStoredFingerprint(raw.message),
  };
  log.error("Certificate fingerprint mismatch!", {
    host: evt.host,
    fingerprint: evt.fingerprint,
    storedFingerprint: evt.storedFingerprint,
  });
  // Only latch/tear down THIS connection when the mismatch is for the
  // host it's actually connected to — the http proxy emits mismatch
  // events for any tunneled host, and the connect page health-checks
  // every saved profile, so an unrelated profile's rotated cert must not
  // permanently kill this socket's reconnect loop.
  if (s.config !== null && raw.host === normalizeHostForCertCompare(s.config.host)) {
    s.certMismatchBlock = true;
    stopWakeListeners(s);
    // A reconnect armed before the mismatch arrived would still fire and
    // call connect(), which clears the latch — resuming the loop against
    // the very host whose certificate just changed. Latching only blocks
    // FUTURE scheduling, so the pending attempt has to be cancelled here.
    cancelReconnect(s);
    setState(s, "disconnected");
  }
  // Notified unconditionally either way — the connect page's first-use
  // and mismatch modals key off host and need every event.
  for (const listener of s.certMismatchListeners) {
    listener(evt);
  }
}
