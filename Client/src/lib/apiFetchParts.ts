// Synchronous pieces of the REST client's request pipeline. Every await and
// every ownership check stays in doFetch (api.ts): these helpers only build
// values, log and map errors, so no guard ever sits behind an awaited helper.

import { desktop } from "../platform/desktop";
import { connectText } from "../i18n/connect";
import type { SessionScope } from "./net/sessionScope";
import type { ApiError } from "./types";
import {
  ApiClientError,
  httpError,
  isNotJsonError,
  log,
  type OnUnauthorized,
  parseRetryAfterMs,
  type RequestOptions,
  TransportError,
} from "./apiShared";

/** Headers, bearer token and body for one request; wires upload progress. */
export function buildRequestInit(
  owner: SessionScope,
  method: string,
  body: unknown,
  opts: RequestOptions | undefined,
  snapshotToken: string | undefined,
  transportSignal: AbortSignal,
): RequestInit {
  const headers: Record<string, string> = {};
  if (!opts?.multipart) headers["Content-Type"] = "application/json";
  const token = opts?.token ?? snapshotToken;
  // i18n-exempt: wire header value, never rendered
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method, headers, signal: transportSignal };
  if (body !== undefined) init.body = opts?.multipart ? (body as FormData) : JSON.stringify(body);
  // Subscribe before the request goes out (the proxy can emit as soon as
  // the body starts moving) and let the request scope unsubscribe it.
  if (opts?.onUploadProgress !== undefined) {
    subscribeUploadProgress(owner, headers, opts.onUploadProgress);
  }
  return init;
}

function subscribeUploadProgress(
  owner: SessionScope,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
): void {
  // The Rust proxy echoes this id back in its upload-progress events, so
  // the caller can tell its own upload's ticks from any other in flight.
  const id = crypto.randomUUID();
  headers["X-Upload-Id"] = id;
  const unsubscribe = desktop.http.onUploadProgress((p) => {
    if (p.id === id) {
      // A 0–1 fraction; the native <progress> renders and announces it.
      onProgress(p.total > 0 ? Math.min(1, Math.max(0, p.sent / p.total)) : 0);
    }
  });
  owner.addCleanup(unsubscribe);
}

/** Log and type a failure of the proxy start or the fetch itself. */
export function transportFailure(
  label: string,
  what: string,
  method: string,
  path: string,
  cause: unknown,
): TransportError {
  // The raw detail stays in the log; the caller gets a typed error so
  // display copy can be friendly.
  log.error(`${label} ${what} failed`, { method, path, error: String(cause) });
  return new TransportError(cause instanceof Error ? cause.message : String(cause), { cause });
}

/**
 * Handle a non-2xx reply whose body has been parsed and whose ownership was
 * just re-checked: run the unauthorized callback, log, and build the error.
 */
export function failedReply(
  label: string,
  method: string,
  path: string,
  res: Response,
  err: ApiError,
  opts: RequestOptions | undefined,
  onUnauthorized: OnUnauthorized | undefined,
): Error {
  if (res.status === 401 && !opts?.skipUnauthorized) {
    // Parse first: the session can change while the error body is arriving.
    // This callback is allowed to synchronously dispose the current session.
    onUnauthorized?.();
  }
  log.warn(`${label} error`, {
    method,
    path,
    status: res.status,
    code: err.error,
    message: err.message,
    reqId: res.headers.get("x-request-id") ?? undefined,
  });
  return httpError(res.status, err.error, err.message, parseRetryAfterMs(res));
}

/** Map a body-read failure: a non-JSON 2xx becomes NOT_JSON, anything else rethrows. */
export function bodyReadFailure(
  label: string,
  method: string,
  path: string,
  res: Response,
  jsonErr: unknown,
): ApiClientError {
  // A 2xx that is not JSON (a proxy's web page in front of the API): the
  // webview's parse error says nothing a user can act on.
  if (!isNotJsonError(jsonErr)) throw jsonErr;
  log.warn(`${label} response is not JSON`, {
    method,
    path,
    status: res.status,
    contentType: res.headers.get("content-type") ?? undefined,
  });
  return new ApiClientError(res.status, "NOT_JSON", connectText("error.notJson"));
}
