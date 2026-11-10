// Checks the body of a REST reply against the shape its call named.

import { checkRest, type RestTable } from "./net/wireCheck";
import type { RestReplyShapes } from "./net/restReplies";
import { connectText } from "../i18n/connect";
import { ApiClientError, log, REPLY_SHAPE_CODE } from "./apiShared";

let restTable: Promise<RestTable> | undefined;

/**
 * The REST shape table, fetched on the first reply that needs a check. The
 * table is large and every reply is read after a network round trip, so it
 * loads as its own chunk instead of with the startup code. A load that fails is
 * not remembered: the next reply tries again.
 */
function loadRestTable(): Promise<RestTable> {
  if (restTable === undefined) {
    const pending = import("./net/restShapes");
    restTable = pending;
    pending.catch(() => {
      if (restTable === pending) restTable = undefined;
    });
  }
  return restTable;
}

/**
 * Starts fetching the shape table without waiting for it, so a probe with a
 * short deadline (the connect page's health and server-info checks) does not
 * spend that deadline on the chunk load.
 */
export function preloadReplyShapes(): void {
  loadRestTable().catch(() => undefined);
}

/**
 * A reply the client cannot read. A call that is not a GET has already been
 * acted on, so its copy says the change may have been made: a blind retry
 * could make it twice.
 */
function unreadable(method: string, status: number): ApiClientError {
  return new ApiClientError(
    status,
    REPLY_SHAPE_CODE,
    connectText(method === "GET" ? "session.unreadableReply" : "session.unreadableWriteReply"),
  );
}

/**
 * The decoded body of a 2xx reply, once it is known to have the shape `reply`
 * names. A body that does not is a server this client cannot read (an older or
 * newer one, or a gateway answering in its place): the call fails with
 * `REPLY_SHAPE_CODE` and the response's own status, as does a shape table that
 * cannot be loaded (the log tells the two apart). The log names the
 * field and what it should have been, never the body, which may hold chat text.
 */
export async function readReply<K extends keyof RestReplyShapes>(
  reply: K,
  body: unknown,
  at: {
    readonly method: string;
    readonly path: string;
    readonly status: number;
  },
): Promise<RestReplyShapes[K]> {
  let table: RestTable;
  try {
    table = await loadRestTable();
  } catch (err) {
    log.warn("Reply shape table failed to load", {
      method: at.method,
      path: at.path.split("?")[0],
      status: at.status,
      error: err instanceof Error ? err.name : "unknown",
    });
    throw unreadable(at.method, at.status);
  }
  const fault = checkRest(reply, body, table);
  if (fault === null) return body as RestReplyShapes[K];
  log.warn("Response is not the expected shape", {
    method: at.method,
    path: at.path.split("?")[0],
    status: at.status,
    field: fault.path,
    expected: fault.expected,
  });
  throw unreadable(at.method, at.status);
}
