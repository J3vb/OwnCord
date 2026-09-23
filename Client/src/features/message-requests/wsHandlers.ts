// Message Requests WebSocket handlers (B9-5) — lib/dispatcher.ts keeps the
// socket subscriptions and calls these plain functions.
import type { DispatchApi, Payload } from "../connection/dispatchContext";
import { mapRequest } from "./api";
import { applyFrame } from "./store";
import { loadRequests } from "./sync";

/**
 * The Message Requests slice of `ready`, and of a resumed `auth_ok` (which gets
 * no ready): re-fetch the pending inbox. dm_request is unsequenced and never
 * replayed, so a frame missed while disconnected is only recovered here
 * (docs/protocol.md, dm_request).
 */
export function applyReadyDmRequests(api: DispatchApi | undefined): void {
  loadRequests(api);
}

export function handleDmRequest(payload: Payload<"dm_request">): void {
  applyFrame(mapRequest(payload), payload.state === "pending");
}
