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
import type { ApiError } from "./types";
import type { RestReplyShapes } from "./net/restReplies";
import { readReply } from "./apiReply";
import {
  type ApiClientConfig,
  ApiClientError,
  log,
  type OnUnauthorized,
  type RequestOptions,
} from "./apiShared";
import { bodyReadFailure, buildRequestInit, failedReply, transportFailure } from "./apiFetchParts";
export {
  TLS_CERT_CODE,
  REPLY_SHAPE_CODE,
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
  OwnApiToken,
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
  async function doFetch<K extends keyof RestReplyShapes>(
    reply: K,
    label: string,
    prefix: string,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    opts?: RequestOptions,
  ): Promise<RestReplyShapes[K]> {
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
      const init = buildRequestInit(owner, method, body, opts, snapshot.token, transport.signal);
      let origin: string;
      try {
        origin = await owner.run(ensureHttpProxy(snapshot.host));
      } catch (proxyErr) {
        owner.assertCurrent();
        // start_http_proxy rejects with a bare string; type it like a failed fetch.
        // i18n-exempt: log text, never rendered
        throw transportFailure(label, "proxy start", method, path, proxyErr);
      }
      owner.assertCurrent();
      log.debug(`${label} →`, { method, path });
      let res: Response;
      try {
        res = await owner.run(desktop.http.fetch(`${origin}${prefix}${path}`, init));
      } catch (fetchErr) {
        owner.assertCurrent();
        throw transportFailure(label, "fetch", method, path, fetchErr);
      }
      owner.assertCurrent();
      log.debug(`${label} ←`, { method, path, status: res.status });
      if (!res.ok) {
        const err = await owner.run(parseError(res)).finally(releaseTransport);
        owner.assertCurrent();
        throw failedReply(label, method, path, res, err, opts, onUnauthorized);
      }
      if (res.status === 204) {
        releaseTransport();
        return undefined as RestReplyShapes[K];
      }
      let data: unknown;
      try {
        data = await owner.run(res.json() as Promise<unknown>).finally(releaseTransport);
      } catch (jsonErr) {
        owner.assertCurrent();
        throw bodyReadFailure(label, method, path, res, jsonErr);
      }
      owner.assertCurrent();
      const checked = await owner.run(readReply(reply, data, { method, path, status: res.status }));
      owner.assertCurrent();
      return checked;
    } finally {
      clearTimeout(timer);
      owner.dispose();
    }
  }

  function request<K extends keyof RestReplyShapes>(
    reply: K,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    opts?: RequestOptions,
  ): Promise<RestReplyShapes[K]> {
    return doFetch(reply, "API", "/api/v1", method, path, body, signal, opts);
  }

  function channelRequest<K extends keyof RestReplyShapes>(
    reply: K,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<RestReplyShapes[K]> {
    return request(reply, method, `/moderation/channels${path}`, body, signal);
  }

  function memberRequest<K extends keyof RestReplyShapes>(
    reply: K,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<RestReplyShapes[K]> {
    return request(reply, method, `/moderation/members${path}`, body, signal);
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
