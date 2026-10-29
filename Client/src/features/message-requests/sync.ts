/**
 * Message Requests snapshot loading (GET /api/v1/dm-requests) and the
 * session's client for the inbox. `ready`, a resume, and a decision
 * that lost a race all fetch through here; the dispatcher's handler hands
 * over the client, which sign-out forgets.
 */

import { createLogger } from "@lib/logger";
import { registerSessionReset } from "@lib/sessionRegistry";
import type { DispatchApi } from "../connection/dispatchContext";
import { mapRequest } from "./api";
import { applySnapshot, beginSnapshot, failSnapshot } from "./store";

const log = createLogger("message-requests");

let source: DispatchApi | undefined;
// App-lifetime reset hook, registered at module load.
void registerSessionReset(
  "message-requests:source",
  () => {
    source = undefined;
  },
  { phase: "session" },
);

/** The client the inbox decides requests with; undefined before the first ready. */
export function requestsApi(): DispatchApi | undefined {
  return source;
}

/** Fetch the pending inbox with `api`, and keep it for the inbox's own refetches. */
export function loadRequests(api: DispatchApi | undefined): Promise<void> {
  if (api?.listDmRequests === undefined) return Promise.resolve();
  source = api;
  const token = beginSnapshot();
  return api.listDmRequests().then(
    (r) => applySnapshot(r.requests.map(mapRequest), token),
    (err: unknown) => {
      // A sign-out or profile switch cancelled it; the next session fetches its own.
      if (err instanceof DOMException && err.name === "AbortError") return;
      log.warn("Failed to load message requests", { error: String(err) });
      failSnapshot(token);
    },
  );
}
