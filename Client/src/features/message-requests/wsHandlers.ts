// Message Requests WebSocket handlers (B9-5) — lib/dispatcher.ts keeps the
// socket subscriptions and calls these plain functions.
import type { DispatchApi, Payload } from "../connection/dispatchContext";
import { log } from "../connection/dispatchContext";
import { mapRequest } from "./api";
import { applyFrame, applySnapshot, beginSnapshot, failSnapshot } from "./store";

/**
 * The Message Requests slice of `ready`: re-fetch the pending inbox. dm_request
 * is unsequenced and never replayed, so a frame missed while disconnected is
 * only recovered here (docs/protocol.md, dm_request).
 */
export function applyReadyDmRequests(api: DispatchApi | undefined): void {
  if (api?.listDmRequests === undefined) return;
  const token = beginSnapshot();
  api.listDmRequests().then(
    (r) => applySnapshot(r.requests.map(mapRequest), token),
    (err: unknown) => {
      // A sign-out or profile switch cancelled it; the next session fetches its own.
      if (err instanceof DOMException && err.name === "AbortError") return;
      log.warn("Failed to load message requests", { error: String(err) });
      failSnapshot(token);
    },
  );
}

export function handleDmRequest(payload: Payload<"dm_request">): void {
  applyFrame(mapRequest(payload), payload.state === "pending");
}
