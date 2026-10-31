// Step 2.13 — REST API Client
// Uses Tauri's HTTP plugin fetch to bypass self-signed cert rejection in webview.

import { desktop } from "../platform/desktop";
import { ensureHttpProxy } from "./net/httpProxy";
import { isValidHost } from "./net/hostValidation";
import { createAccountApi } from "./apiAccount";
import { createAdminApi } from "./apiAdmin";
import { createChannelsApi } from "./apiChannels";
import { createDmsApi } from "./apiDms";
import type { ApiTransport } from "./apiShared";
import { SessionScope } from "./net/sessionScope";
import {
  NSFW_ACKNOWLEDGEMENT_REQUIRED,
  nsfwContentBlocked,
} from "../features/content-consent/nsfw";
import { setNsfwAcknowledged } from "../stores/channels.store";
import { connectText } from "../i18n/connect";
import type { ApiError } from "./types";
import {
  type ApiClientConfig,
  ApiClientError,
  httpError,
  isNotJsonError,
  log,
  type OnUnauthorized,
  parseRetryAfterMs,
  type RequestOptions,
  TransportError,
} from "./apiShared";
export {
  TLS_CERT_CODE,
  ApiClientError,
  TransportError,
  httpError,
  serverErrorCopy,
  serverErrorText,
  errorText,
  channelMediaParams,
} from "./apiShared";
export type {
  ApiClientConfig,
  BanMemberResponse,
  OnUnauthorized,
  SessionInfo,
  DmPrivacy,
  UserNote,
  RevokeAllSessionsResponse,
  RecoveryKitIssue,
  RecoveryKitStatus,
  OwnModerationAction,
  MyAppeal,
  ReportTargetType,
  ReportReason,
  FileReportRequest,
  OwnReportSummary,
  ModerationQueueFilter,
  ModerationQueueRow,
  ModerationReportDetail,
  ModerationActRequest,
  ModerationOutcome,
  ModerationAppealFilter,
  ModerationAppealRow,
  ModerationAppealDetail,
  AppealDecision,
  DmRequestDecision,
} from "./apiShared";

function refusal(): ApiClientError {
  return new ApiClientError(403, NSFW_ACKNOWLEDGEMENT_REQUIRED, NSFW_ACKNOWLEDGEMENT_REQUIRED);
}

async function channelContent<T>(channelId: number, load: () => Promise<T>): Promise<T> {
  if (nsfwContentBlocked(channelId)) throw refusal();
  let result: T;
  try {
    result = await load();
  } catch (err) {
    // The server's refusal outranks a stale local "consented". A resume
    // that missed an nsfw_ack already gets a full ready (the revoke bumps
    // the server's visibility watermark), so this is defence in depth.
    if (err instanceof ApiClientError && err.code === NSFW_ACKNOWLEDGEMENT_REQUIRED) {
      setNsfwAcknowledged(channelId, false);
    }
    throw err;
  }
  if (nsfwContentBlocked(channelId)) throw refusal();
  return result;
}

/** Create the REST API client. */
export function createApiClient(initialConfig: ApiClientConfig, onUnauthorized?: OnUnauthorized) {
  let config: Readonly<ApiClientConfig> = Object.freeze({ ...initialConfig });
  let generation = 0;
  let session = new SessionScope({ host: config.host, generation });

  function replaceSession(nextConfig: ApiClientConfig): void {
    const previous = session;
    config = Object.freeze({ ...nextConfig });
    session = new SessionScope({ host: config.host, generation: ++generation });
    previous.dispose();
  }

  // Snapshot both destination and credentials BEFORE starting the native proxy.
  // Every path (including multipart, admin and TOTP) uses the same ownership
  // checks through response-body consumption. Native cancellation is best-effort;
  // SessionScope also rejects completions that arrive after a session switch.
  async function doFetch<T>(
    label: string,
    prefix: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    opts?: RequestOptions,
  ): Promise<T> {
    const snapshot = config;
    // A detached request is owned by its caller's signal alone, so ending the
    // session it was sent from does not cancel it.
    const owner = opts?.detached
      ? new SessionScope({ host: snapshot.host, generation }, signal ? [signal] : [])
      : session.fork(signal);
    // Tauri keeps abort listeners after a response body has been consumed.
    // Detach transport cancellation when that work settles, while still
    // disposing the logical request scope and all of its parent listeners.
    const transport = new AbortController();
    const releaseTransport = owner.addCleanup(() => transport.abort());
    const timer =
      opts?.timeoutMs === undefined ? undefined : setTimeout(() => owner.dispose(), opts.timeoutMs);
    try {
      owner.assertCurrent();
      const headers: Record<string, string> = {};
      if (!opts?.multipart) headers["Content-Type"] = "application/json";
      const token = opts?.token ?? snapshot.token;
      // i18n-exempt: wire header value, never rendered
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const init: RequestInit = { method, headers, signal: transport.signal };
      if (body !== undefined)
        init.body = opts?.multipart ? (body as FormData) : JSON.stringify(body);
      // Subscribe before the request goes out (the proxy can emit as soon as
      // the body starts moving) and let the request scope unsubscribe it.
      if (opts?.onUploadProgress !== undefined) {
        // The Rust proxy echoes this id back in its upload-progress events, so
        // the caller can tell its own upload's ticks from any other in flight.
        const id = crypto.randomUUID();
        headers["X-Upload-Id"] = id;
        const onProgress = opts.onUploadProgress;
        const unsubscribe = desktop.http.onUploadProgress((p) => {
          if (p.id === id) {
            // A 0–1 fraction; the native <progress> renders and announces it.
            onProgress(p.total > 0 ? Math.min(1, Math.max(0, p.sent / p.total)) : 0);
          }
        });
        owner.addCleanup(unsubscribe);
      }
      let origin: string;
      try {
        origin = await owner.run(ensureHttpProxy(snapshot.host));
      } catch (proxyErr) {
        owner.assertCurrent();
        // start_http_proxy rejects with a bare string; type it like a failed fetch.
        log.error(`${label} proxy start failed`, { method, path, error: String(proxyErr) });
        throw new TransportError(proxyErr instanceof Error ? proxyErr.message : String(proxyErr), {
          cause: proxyErr,
        });
      }
      owner.assertCurrent();
      log.debug(`${label} →`, { method, path });
      let res: Response;
      try {
        res = await owner.run(desktop.http.fetch(`${origin}${prefix}${path}`, init));
      } catch (fetchErr) {
        owner.assertCurrent();
        // The raw detail stays in the log; the caller gets a typed error so
        // display copy can be friendly.
        log.error(`${label} fetch failed`, { method, path, error: String(fetchErr) });
        throw new TransportError(fetchErr instanceof Error ? fetchErr.message : String(fetchErr), {
          cause: fetchErr,
        });
      }
      owner.assertCurrent();
      log.debug(`${label} ←`, { method, path, status: res.status });
      if (!res.ok) {
        const err = await owner.run(parseError(res)).finally(releaseTransport);
        owner.assertCurrent();
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
        throw httpError(res.status, err.error, err.message, parseRetryAfterMs(res));
      }
      if (res.status === 204) {
        releaseTransport();
        return undefined as T;
      }
      let data: T;
      try {
        data = await owner.run(res.json() as Promise<T>).finally(releaseTransport);
      } catch (jsonErr) {
        owner.assertCurrent();
        // A 2xx that is not JSON (a proxy's web page in front of the API): the
        // webview's parse error says nothing a user can act on.
        if (!isNotJsonError(jsonErr)) throw jsonErr;
        log.warn(`${label} response is not JSON`, {
          method,
          path,
          status: res.status,
          contentType: res.headers.get("content-type") ?? undefined,
        });
        throw new ApiClientError(res.status, "NOT_JSON", connectText("error.notJson"));
      }
      owner.assertCurrent();
      return data;
    } finally {
      clearTimeout(timer);
      owner.dispose();
    }
  }

  function request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    opts?: RequestOptions,
  ): Promise<T> {
    return doFetch<T>("API", "/api/v1", method, path, body, signal, opts);
  }

  function channelRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return request<T>(method, `/moderation/channels${path}`, body, signal);
  }

  function memberRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return request<T>(method, `/moderation/members${path}`, body, signal);
  }

  // oxlint-disable-next-line consistent-function-scoping -- co-located with doFetch for encapsulation
  async function parseError(res: Response): Promise<ApiError> {
    try {
      const body = await res.json();
      return {
        error: body.error ?? "UNKNOWN",
        message: body.message ?? res.statusText,
      };
    } catch {
      return {
        error: "UNKNOWN",
        message: res.statusText,
      };
    }
  }

  const t: ApiTransport = {
    request,
    channelRequest,
    memberRequest,
    channelContent,
    get config() {
      return config;
    },
    get session() {
      return session;
    },
    get generation() {
      return generation;
    },
  };

  return {
    /** Update the client config (e.g., after login). */
    setConfig(newConfig: Partial<ApiClientConfig>): void {
      if (newConfig.host !== undefined && !isValidHost(newConfig.host)) {
        log.error("setConfig rejected invalid host", { host: newConfig.host });
        // i18n-exempt: internal guard; callers validate the host before this runs
        throw new Error("Invalid host format");
      }
      // Switching to a different host without an accompanying new token must
      // not carry the previous host's bearer token forward — otherwise the
      // login/register request to the new host rides a still-live session
      // token for the old one. Callers that only rotate the token (post-auth)
      // never pass `host`, so this never touches a same-host token refresh.
      const nextConfig = {
        ...config,
        ...newConfig,
        ...(newConfig.host !== undefined &&
        newConfig.host !== config.host &&
        newConfig.token === undefined
          ? { token: undefined }
          : {}),
      };
      if (nextConfig.host !== config.host || nextConfig.token !== config.token) {
        replaceSession(nextConfig);
      }
    },

    /** Capture before async work; public ownership metadata never exposes tokens. */
    getSession(): SessionScope {
      return session;
    },

    /** End even a same-host, pre-auth attempt and invalidate all its resources. */
    endSession(): void {
      replaceSession({ host: config.host });
    },

    /** Get current config (for debugging). Token is redacted. */
    getConfig(): Readonly<ApiClientConfig> {
      return { ...config, token: config.token ? "[redacted]" : undefined };
    },
    ...createAccountApi(t),
    ...createChannelsApi(t),
    ...createDmsApi(t),
    ...createAdminApi(t),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
