// Outbound frames: the send path with its failure codes, and the ping probe.

import type { ClientMessage } from "../../types";
import { createLogger } from "../../logger";
import { uuid, type ConnectionState } from "../../wsConfig";
import { currentGeneration } from "./generation";
import type { WsState } from "./wsState";

const log = createLogger("ws");

function notifySendFailure(s: WsState, id: string | undefined, code: string): void {
  if (id === undefined) return;
  for (const listener of s.sendFailureListeners) {
    try {
      listener(id, code);
    } catch (err) {
      log.error("Send-failure listener error", err);
    }
  }
}

function reportSendError(s: WsState, id: string | undefined, json: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("channel full")) {
    // Outbound channel is saturated — surface the drop to listeners so an
    // optimistic row fails with retry instead of silently losing the send.
    // Log id + size only — a slice of `json` can contain the auth
    // envelope's bearer token, and this line is persisted to disk.
    log.warn("ws_send: outbound channel full, message dropped (backpressure)", {
      id,
      bytes: json.length,
    });
    notifySendFailure(s, id, "NETWORK");
  } else {
    log.error("ws_send failed", err);
    const offline = msg.includes("channel closed") || msg.includes("not connected");
    notifySendFailure(s, id, offline ? "OFFLINE" : "NETWORK");
  }
}

export function sendRaw(s: WsState, json: string, id?: string): void {
  if (!s.proxyOpen) {
    log.warn("Cannot send, WebSocket not open");
    // Deferred so a caller that registers the envelope id right after send()
    // returns (the optimistic-row flow) sees the failure after registration.
    queueMicrotask(() => notifySendFailure(s, id, "OFFLINE"));
    return;
  }
  void s.transport.send(json).catch((err: unknown) => reportSendError(s, id, json, err));
}

export function sendMessage(
  s: WsState,
  msg: ClientMessage | { type: string; payload: unknown },
): string {
  const id = uuid();
  const envelope = { ...msg, id };
  log.debug("WS →", { type: msg.type, id });
  sendRaw(s, JSON.stringify(envelope), id);
  return id;
}

/** Send a heartbeat and require a fresh pong on this authenticated socket.
 * Pongs are uncorrelated, so this proves liveness, not an RTT measurement. */
export function pingTransport(s: WsState, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    if (s.state !== "connected" || !s.proxyOpen) {
      // i18n-exempt: internal ping liveness guard, never rendered
      reject(new Error("The application connection is not ready."));
      return;
    }
    const generation = currentGeneration();
    const cleanup = (): void => {
      clearTimeout(timer);
      s.pongListeners.delete(onPong);
      s.stateListeners.delete(onState);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (reason: unknown): void => {
      cleanup();
      reject(reason);
    };
    const onAbort = (): void => fail(signal.reason);
    const onState = (next: ConnectionState): void => {
      // i18n-exempt: internal ping liveness guard, never rendered
      if (next !== "connected") fail(new Error("The application connection changed."));
    };
    const onPong = (): void => {
      if (generation !== currentGeneration()) {
        // i18n-exempt: internal ping liveness guard, never rendered
        fail(new Error("The application connection changed."));
        return;
      }
      cleanup();
      resolve();
    };
    const timer = setTimeout(
      // i18n-exempt: internal ping liveness guard, never rendered
      () => fail(new Error("No heartbeat response arrived.")),
      timeoutMs,
    );
    s.pongListeners.add(onPong);
    s.stateListeners.add(onState);
    signal.addEventListener("abort", onAbort, { once: true });
    void s.transport.send(JSON.stringify({ type: "ping", payload: {} })).catch(fail);
  });
}
