/**
 * Message Requests snapshot loading (B5-6 GET /api/v1/dm-requests) and the
 * session's client for the inbox (B9-6). `ready`, a resume, and a decision
 * that lost a race all fetch through here; the dispatcher's handler hands
 * over the client, which sign-out forgets.
 */

import { createLogger } from "@lib/logger";
import { onAuthCleared } from "@stores/auth.store";
import type { DispatchApi } from "../connection/dispatchContext";
import { mapRequest } from "./api";
import { applySnapshot, beginSnapshot, failSnapshot } from "./store";

const log = createLogger("message-requests");

let source: DispatchApi | undefined;
onAuthCleared(() => {
  source = undefined;
});

/** The client the inbox decides requests with; undefined before the first ready. */
export function requestsApi(): DispatchApi | undefined {
  return source;
}

/** Fetch the pending inbox with `api`, and keep it for the inbox's own refetches. */
export function loadRequests(api: DispatchApi | undefined): void {
  if (api?.listDmRequests === undefined) return;
  source = api;
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
