// Step 2.13 — REST API Client
// Uses Tauri's HTTP plugin fetch to bypass self-signed cert rejection in webview.

import { desktop } from "../platform/desktop";
import { createLogger } from "./logger";
import { ensureHttpProxy } from "./httpProxy";
import { isValidHost } from "./hostValidation";
import { SessionScope } from "./sessionScope";
import {
  NSFW_ACKNOWLEDGEMENT_REQUIRED,
  nsfwContentBlocked,
} from "../features/content-consent/nsfw";
import { setNsfwAcknowledged } from "../stores/channels.store";
import { connectText } from "../i18n/connect";
import type {
  AuthResponse,
  AdminUser,
  RegisterResponse,
  HealthResponse,
  ServerInfoResponse,
  MessagesResponse,
  MessagesAroundResponse,
  ReactionUsersResponse,
  PurgeResponse,
  SearchResponse,
  ApiError,
  ChannelType,
  ChannelResponse,
  EmojiResponse,
  InviteResponse,
  UploadResponse,
  VoiceCredentialsResponse,
  MemberResponse,
  DmChannelsResponse,
  CreateDmResponse,
  GroupDmResponse,
  BlockedUsersResponse,
  DmRequestListResponse,
  GifSearchResponse,
  PartialSuccessResponse,
} from "./types";

/** Configuration for the API client. */
export interface ApiClientConfig {
  readonly host: string;
  readonly token?: string;
}

/**
 * Per-request options for the internal `doFetch`. `onUploadProgress` tags a
 * multipart upload with a fresh id so the native transport's `upload-progress`
 * ticks can be matched to this request, and receives the matching ones as a
 * 0–1 fraction.
 */
interface RequestOptions {
  skipUnauthorized?: boolean;
  token?: string;
  multipart?: boolean;
  detached?: boolean;
  onUploadProgress?: (fraction: number) => void;
}

/**
 * The distinct code the desktop proxy reports for a TLS/certificate failure
 * (a refused first-use or changed TOFU pin, or a failed handshake). Kept in
 * step with `Client/src-tauri/src/tofu.rs`'s `TLS_CERT_ERROR_CODE`.
 */
export const TLS_CERT_CODE = "TLS_CERT_UNVERIFIED";

/** API client error with parsed error body. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  /** The response's Retry-After, in milliseconds, when it sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A Retry-After header in delta-seconds form, as milliseconds; undefined otherwise. */
function parseRetryAfterMs(res: Response): number | undefined {
  const value = res.headers.get("retry-after")?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) * 1000 : undefined;
}

/**
 * A request that never reached the server: the host is offline or
 * unreachable, or the desktop HTTP tunnel refused its certificate. `cause`
 * keeps the transport's raw text for the log; the display copy is
 * `errorText`'s.
 */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportError";
  }
}

/**
 * The error for a non-2xx response. The desktop HTTP tunnel now answers a
 * refused certificate with a 502 whose JSON body carries {@link TLS_CERT_CODE},
 * which `serverErrorCopy` maps to the certificate copy. A code-less 502 (a
 * legacy or intermediary refusal shape) is still a `TransportError`, showing
 * the unreachable copy rather than a server refusal.
 */
export function httpError(
  status: number,
  code: string,
  message: string,
  retryAfterMs?: number,
): Error {
  if (status === 502 && code === "UNKNOWN") return new TransportError(message);
  return new ApiClientError(status, code, message, retryAfterMs);
}

function isSessionExpired(message: string): boolean {
  return (
    message === "session has expired" ||
    message === "invalid or expired session" ||
    message === "missing or invalid authorization header" ||
    message === "not authenticated"
  );
}

function authSliceCopy(message: string): string | null {
  switch (message) {
    case "account temporarily locked due to too many failed attempts":
      return connectText("error.accountLocked");
    case "recovery temporarily locked due to too many failed attempts":
      return connectText("error.recoveryLocked");
    case "too many failed attempts, try again later":
      return connectText("error.tooManyAttempts");
    case "registration queue is full, try again later":
      return connectText("error.registrationQueueFull");
    case "too many registrations from this address, try again later":
      return connectText("error.registrationRateLimited");
    case "too many authentication attempts in progress, try again later":
      return connectText("error.authBusy");
    case "too many recovery credentials issued; try again later":
      return connectText("error.recoveryCredentialBudget");
    case "login temporarily unavailable":
      return connectText("error.loginUnavailable");
    case "failed to load authentication policy":
    case "failed to process registration":
      return connectText("error.couldNotComplete");
    case "failed to load registration policy":
      return connectText("error.registrationUnavailable");
    case "registration failed — please try again":
      return connectText("error.registrationFailed");
    case "failed to create session":
      return connectText("error.sessionFailed");
    case "registration succeeded but user fetch failed":
      return connectText("error.registeredSignInFailed");
    case "failed to start two-factor challenge":
    case "failed to verify two-factor code":
    case "two-factor verification temporarily unavailable":
      return connectText("error.totpUnavailable");
    case "failed to logout":
      return connectText("error.logoutFailed");
    case "failed to delete account":
      return connectText("error.deleteAccountFailed");
    case "failed to generate two-factor secret":
    case "failed to stage two-factor enrolment":
    case "failed to enable two-factor authentication":
      return connectText("error.totpEnableFailed");
    case "failed to disable two-factor authentication":
      return connectText("error.totpDisableFailed");
    case "failed to issue recovery codes":
      return connectText("error.recoveryCodesFailed");
    case "recovery failed — please try again":
      return connectText("error.recoveryFailed");
    case "failed to issue the recovery kit":
      return connectText("error.recoveryKitFailed");
    case "failed to issue the recovery credential":
      return connectText("error.recoveryCredentialFailed");
    default:
      return null;
  }
}

const PERMISSION_REFUSAL =
  /\bmissing\b.*\bpermission\b|insufficient permissions|permission required$|role required$|^access denied$/i;

/**
 * The user-facing copy for a server error code that has one, or null when the
 * code has none (the caller then shows the server's own message). Every string
 * is plain, capitalised prose — never the raw lower-case server text.
 *
 * `message` disambiguates the codes the server overloads. UNAUTHORIZED is an
 * expired session, a refused sign-in ("invalid credentials"), or a wrong
 * two-factor code or recovery kit; FORBIDDEN is a missing permission, a
 * suspended account, or an account-state refusal ("account is awaiting
 * approval"). Only a refused sign-in, session, suspension or permission has
 * fixed copy — the rest keep the server's own sentence, which says what went
 * wrong. AUTH_BUSY is the server's authentication queue being full. RATE_LIMITED
 * and INTERNAL_ERROR carry the auth slice's lockout,
 * budget and failure sentences, each of which gets copy of its own; any other
 * rate limit reads as the generic line and any other internal failure as the
 * caller's fallback.
 */
export function serverErrorCopy(code: string, message: string): string | null {
  switch (code) {
    // The desktop HTTP tunnel reports a refused certificate or a failed TLS
    // handshake with this distinct code (http_pool.rs's cert_error_response)
    // rather than a bare 502, so the two failure classes stay distinguishable.
    case TLS_CERT_CODE:
      return connectText("error.tlsFailed");
    case "RATE_LIMITED":
      return authSliceCopy(message) ?? connectText("error.rateLimited");
    case "AUTH_BUSY":
      return connectText("error.authBusy");
    case "INTERNAL":
    case "INTERNAL_ERROR":
      return authSliceCopy(message);
    case "UNAUTHORIZED":
      if (message === "invalid credentials") return connectText("error.invalidCredentials");
      return isSessionExpired(message) ? connectText("error.unauthorized") : null;
    case "FORBIDDEN":
      if (message === "your account has been suspended") return connectText("error.banned");
      return PERMISSION_REFUSAL.test(message) ? connectText("error.forbidden") : null;
    case "NOT_FOUND":
      return connectText("error.notFound");
    case "BANNED":
      return connectText("error.banned");
    case "SERVICE_UNAVAILABLE":
    case "BAD_GATEWAY":
      return connectText("error.unavailable");
    case "STORAGE_QUOTA_EXCEEDED":
      return connectText("error.storageQuota");
    case "STORAGE_LOW_DISK":
      return connectText("error.storageLowDisk");
    case "STORAGE_ERROR":
      return connectText("error.storageError");
    case "GIF_DISABLED":
      return connectText("error.gifDisabled");
    case "PUSH_DISABLED":
      return connectText("error.pushDisabled");
    default:
      return null;
  }
}

/**
 * Capitalise a server message's first letter, so an unmapped code's raw
 * lower-case text ("name already exists") still reads as a sentence. The rest
 * of the string is left alone — it may be a proper noun or an already-cased
 * developer message.
 */
function capitalise(message: string): string {
  return message.length === 0 ? message : message[0]!.toUpperCase() + message.slice(1);
}

/**
 * The text for a server error: catalog copy when its code has a mapping, the
 * server's message (capitalised) only when it has none, and `fallback` for an
 * empty message. An unmapped internal failure maps to the caller's own
 * `fallback`.
 */
export function serverErrorText(code: string, message: string, fallback: string): string {
  const copy = serverErrorCopy(code, message);
  if (copy !== null) return copy;
  if (code === "INTERNAL" || code === "INTERNAL_ERROR") return fallback;
  return message ? capitalise(message) : fallback;
}

/** A failed request's text: friendly copy for a `TransportError`, `serverErrorText`
 *  for an `ApiClientError`, else the error's own message. */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof TransportError) return connectText("session.connectTimeout");
  if (err instanceof ApiClientError) return serverErrorText(err.code, err.message, fallback);
  return err instanceof Error ? err.message : fallback;
}

export type OnUnauthorized = () => void;

/**
 * Single session object from GET /users/me/sessions, matching the server's
 * wire shape (Server/api/profile_handler.go's sessionResponse, wrapped in a
 * `{sessions: [...]}` envelope — docs/api.md). Defined here, next to its only
 * consumer, rather than in `./types`: the declaration that used to live there
 * had drifted from the actual contract (it declared `ip_address`/`expires_at`,
 * which the server never sends, and omitted `ip`/`is_current`, which it always
 * does), and nothing else needs this shape.
 */
export interface SessionInfo {
  readonly id: number;
  /** Never null: the server's fields are plain Go strings, so an unknown
   *  device or address arrives as "" rather than being omitted. */
  readonly device: string;
  readonly ip: string;
  readonly created_at: string;
  readonly last_used: string;
  readonly is_current: boolean;
  /** A sign-in no other device has acknowledged yet. Listing the sessions
   *  acknowledges every row but the caller's own, so this is visible in
   *  exactly one listing per device. */
  readonly unseen: boolean;
}

/** DELETE /users/me/sessions: every session is revoked, the caller's included. */
export interface RevokeAllSessionsResponse {
  readonly sessions_revoked: number;
  readonly current_session_revoked: boolean;
}

/** POST /users/me/recovery-kit: `kit_secret` is present only when the server
 *  generated it, and it is shown exactly once. */
export interface RecoveryKitIssue {
  readonly kit_secret?: string;
  readonly created_at: string;
}

/** GET /users/me/recovery-kit: whether the account holds an unspent kit. */
export interface RecoveryKitStatus {
  readonly enrolled: boolean;
  readonly created_at?: string;
  readonly used_at: string | null;
}

/** One row of GET /users/me/moderation: the caller's own warning, timeout,
 *  removal or (lapsed) ban, read from the server's ledger, so it survives a
 *  restart. `id` is the `action_id` an appeal takes. Mirrors
 *  Server/api/moderation_handler.go's ownModerationActionResponse. */
export interface OwnModerationAction {
  readonly id: number;
  readonly kind: "warning" | "timeout" | "removal" | "ban";
  readonly reason: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly lifted_at: string | null;
  readonly acknowledged_at: string | null;
  /** An appealable kind with no appeal filed against it yet. */
  readonly appealable: boolean;
  /** The appeal filed against this row: its opaque public id and state. */
  readonly appeal: { readonly id: string; readonly state: AppealState } | null;
}

export type AppealState = "open" | "assigned" | "upheld" | "overturned" | "withdrawn";

/** One row of GET /appeals/mine: never the assignee or who decided it.
 *  Mirrors Server/api/appeal_handler.go's appealMineResponse. */
export interface MyAppeal {
  /** The opaque public id withdraw takes. */
  readonly id: string;
  /** The appealed action's kind, reason and time; all "" once that action is erased. */
  readonly action_kind: OwnModerationAction["kind"] | "";
  readonly action_reason: string;
  readonly action_created_at: string;
  readonly state: AppealState;
  /** Set only once the appeal is decided (upheld or overturned). */
  readonly decision_note: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}

/** POST /reports target kinds and reason codes: B5's finite, server-owned
 *  sets (Server/service/report.go). */
export type ReportTargetType = "message" | "user" | "attachment";
export type ReportReason = "spam" | "harassment" | "nsfw_unlabelled" | "illegal" | "other";

/** POST /reports body. The server derives the subject from the target. */
export interface FileReportRequest {
  readonly target_type: ReportTargetType;
  readonly target_id: string;
  readonly reason: ReportReason;
  readonly detail: string;
}

/** One row of GET /reports/mine: the reporter's own summary, never evidence,
 *  assignee or notes. `id` is the opaque public id. Mirrors
 *  Server/api/report_handler.go's reportSummaryResponse; kept apart from any
 *  moderator shape so the two can never share a cache or a field. */
export interface OwnReportSummary {
  readonly id: string;
  readonly target_type: string;
  readonly reason: string;
  /** open, assigned, resolved, dismissed or subject_erased. */
  readonly state: string;
  /** "" while open; actioned, no_action, duplicate or subject_erased once closed. */
  readonly outcome: string;
  readonly created_at: string;
  readonly closed_at: string | null;
}

/** GET /moderation/queue's `state` filter: "" is open and assigned together. */
export type ModerationQueueFilter = "" | "open" | "assigned" | "closed";

/** One row of GET /moderation/queue (B5-8), for MODERATE_MEMBERS holders
 *  only. `id` is the opaque public id. Mirrors
 *  Server/api/moderation_queue_handler.go's moderationQueueRowResponse. */
export interface ModerationQueueRow {
  readonly id: string;
  readonly reporter_name: string;
  readonly subject_name: string;
  readonly target_type: string;
  readonly target_ref: string;
  readonly channel_id?: number;
  readonly reason: string;
  readonly state: string;
  readonly assignee_id: number;
  readonly outcome: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at?: string;
}

/** GET /moderation/queue/{id}: the fields the Moderation Center reads (B9-11,
 *  B9-12). Mirrors Server/api/moderation_queue_handler.go's
 *  moderationReportDetailResponse. */
export interface ModerationReportDetail {
  readonly id: string;
  readonly reporter_id: number;
  /** The reported account; 0 once it is erased. */
  readonly subject_id: number;
  readonly target_type: string;
  readonly channel_id?: number;
  readonly reason: string;
  readonly detail: string;
  readonly state: string;
  readonly assignee_id: number;
  readonly outcome: string;
  readonly created_at: string;
  readonly closed_at?: string;
  /** The snapshot the server captured at filing; empty when withheld. */
  readonly evidence: readonly {
    readonly seq: number;
    readonly author_id: number;
    readonly content: string;
    /** JSON array of {id, filename, mime, size}: references, never bytes. */
    readonly attachments: string;
    readonly captured_at: string;
  }[];
  /** NSFW_ACKNOWLEDGEMENT_REQUIRED or SOURCE_CHANNEL_UNAVAILABLE when withheld. */
  readonly evidence_withheld?: string;
  /** Internal notes: always empty for the report's own reporter, once the
   *  retention sweep has run on a closed report, and once the subject's
   *  account is erased. */
  readonly notes: readonly {
    readonly id: number;
    readonly author_id: number;
    readonly body: string;
    readonly created_at: string;
  }[];
  /** report_events, oldest first: created, assigned, noted, closed. Actor 0
   *  is the server (created) or an erased account. */
  readonly events: readonly {
    readonly actor_id: number;
    readonly action: string;
    readonly detail: string;
    readonly created_at: string;
  }[];
  /** Moderator actions taken with this report. */
  readonly actions: readonly {
    readonly id: number;
    readonly kind: string;
    readonly actor_id: number;
    readonly reason: string;
    readonly created_at: string;
    /** A timeout's end. */
    readonly expires_at?: string;
    readonly lifted_at?: string;
  }[];
}

/** POST /moderation/queue/{id}/act: the report-linked actions B9-13 sends. A
 *  timeout's duration is 60 to 2,419,200 seconds (Server/service/moderation.go). */
export type ModerationActRequest =
  | { readonly kind: "warning"; readonly reason: string }
  | { readonly kind: "timeout"; readonly reason: string; readonly duration_seconds: number }
  /** B9-14: removal acts on the reported message; kick is a force-logout. */
  | { readonly kind: "removal" | "kick" | "ban"; readonly reason: string };

/** POST /moderation/queue/{id}/close outcomes (Server/service/report.go). */
export type ModerationOutcome = "actioned" | "no_action" | "duplicate";

/** GET /moderation/appeals' `state` filter: "" is open and assigned together;
 *  "decided" is upheld and overturned. */
export type ModerationAppealFilter = "" | "open" | "assigned" | "decided";

/** One row of GET /moderation/appeals (B5-10), for MODERATE_MEMBERS holders
 *  only; never the caller's own appeal. Mirrors Server/api/appeal_handler.go's
 *  appealQueueRowResponse. */
export interface ModerationAppealRow {
  readonly id: string;
  readonly action_id: number;
  /** 0 once the appellant's account is erased. */
  readonly appellant_id: number;
  readonly state: AppealState;
  /** 0 while no one holds it. */
  readonly assignee_id: number;
  readonly created_at: string;
  readonly decided_at: string | null;
}

/** GET /moderation/appeals/{id}: the appeal and the action it is about. 403
 *  SELF_REVIEW on the caller's own appeal. Mirrors appealDetailResponse. */
export interface ModerationAppealDetail extends ModerationAppealRow {
  /** The appellant's statement. */
  readonly body: string;
  readonly decided_by: number;
  /** Sent to the appellant with the decision. */
  readonly decision_note: string;
  readonly action: {
    readonly id: number;
    readonly kind: string;
    readonly actor_id: number;
    readonly reason: string;
    readonly created_at: string;
    readonly expires_at?: string;
    readonly acknowledged_at?: string;
    readonly lifted_at?: string;
  };
  /** The report the action was taken with, only when this reader may open it. */
  readonly report_id?: string;
}

export type AppealDecision = "upheld" | "overturned";

/** The four recipient transitions of a pending Message Request (docs/api.md). */
export type DmRequestDecision = "accept" | "ignore" | "delete" | "block";

/** The 200 body of every POST /dm-requests/{id}/{decision}. */
export interface DmRequestDecisionResult {
  readonly id: number;
  readonly state: "accepted" | "ignored" | "deleted" | "blocked";
  readonly decided_at: string | null;
}

interface SessionsListResponse {
  readonly sessions: SessionInfo[];
}

const log = createLogger("api");

function refusal(): ApiClientError {
  return new ApiClientError(403, NSFW_ACKNOWLEDGEMENT_REQUIRED, NSFW_ACKNOWLEDGEMENT_REQUIRED);
}

/**
 * A content read from one channel, admitted only with NSFW consent (B9-7):
 * refused locally, with the server's own error, before any request while
 * the channel is gated, and discarded if consent was withdrawn while it was
 * in flight — so nothing from a labelled channel is fetched or delivered
 * pre-consent, whichever feature asked.
 */
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
      const origin = await owner.run(ensureHttpProxy(snapshot.host));
      owner.assertCurrent();
      log.debug(`${label} →`, { method, path });
      let res: Response;
      try {
        res = await owner.run(desktop.http.fetch(`${origin}${prefix}${path}`, init));
      } catch (fetchErr) {
        owner.assertCurrent();
        // The raw detail stays in the log; the caller gets a typed error so
        // display copy can be friendly (DP-54).
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
      const data = await owner.run(res.json() as Promise<T>).finally(releaseTransport);
      owner.assertCurrent();
      return data;
    } finally {
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

  function adminRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    // i18n-exempt: log label for admin requests, never rendered
    return doFetch<T>("Admin API", "/admin/api", method, path, body, signal);
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

    // ── Auth ──────────────────────────────────────────────

    login(username: string, password: string, signal?: AbortSignal): Promise<AuthResponse> {
      return request<AuthResponse>("POST", "/auth/login", { username, password }, signal);
    },

    register(
      username: string,
      password: string,
      inviteCode: string,
      signal?: AbortSignal,
    ): Promise<RegisterResponse> {
      return request<RegisterResponse>(
        "POST",
        "/auth/register",
        { username, password, invite_code: inviteCode },
        signal,
      );
    },

    /** Revokes this session's token. It runs outside the session's scope, so the
     *  session teardown that follows a logout cannot cancel it, and a 401 (the
     *  token is already gone) does not start a second logout. */
    logout(signal?: AbortSignal): Promise<void> {
      return request<void>("POST", "/auth/logout", undefined, signal, {
        detached: true,
        skipUnauthorized: true,
      });
    },

    verifyTotp(code: string, partialToken: string, signal?: AbortSignal): Promise<AuthResponse> {
      return request<AuthResponse>("POST", "/auth/verify-totp", { code }, signal, {
        token: partialToken,
      });
    },

    /** POST /auth/recover. `secret` is a recovery kit secret or an
     *  owner-issued recovery credential; the server tells them apart by
     *  shape, so both travel in `kit_secret`. Answers the login shape. */
    recoverAccount(
      username: string,
      secret: string,
      newPassword: string,
      signal?: AbortSignal,
    ): Promise<AuthResponse> {
      return request<AuthResponse>(
        "POST",
        "/auth/recover",
        { username, kit_secret: secret, new_password: newPassword },
        signal,
      );
    },

    deleteAccount(password: string, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", "/auth/account", { password }, signal);
    },

    // ── Users ─────────────────────────────────────────────

    getMe(signal?: AbortSignal): Promise<MemberResponse> {
      return request<MemberResponse>("GET", "/auth/me", undefined, signal);
    },

    updateProfile(
      data: {
        username?: string;
        avatar?: string;
        identity_public_key?: string;
        /** Omit to leave unchanged; "" clears the field. */
        display_name?: string;
        about?: string;
      },
      signal?: AbortSignal,
    ): Promise<MemberResponse> {
      return request<MemberResponse>("PATCH", "/users/me", data, signal);
    },

    /**
     * Upload an avatar image (PNG/JPEG/WebP, max 1 MB, max 1024x1024).
     *
     * Multipart rather than JSON for the same reason attachments are, and it
     * shares uploadFile's shape: no Content-Type header (the browser has to
     * set the multipart boundary) and the bearer token attached by hand.
     * On success the server has already pointed the user's avatar at the
     * served file and broadcast a user_update.
     */
    uploadAvatar(file: File, signal?: AbortSignal): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", file);

      return request<UploadResponse>("POST", "/users/me/avatar", formData, signal, {
        multipart: true,
      });
    },

    changePassword(
      currentPassword: string,
      newPassword: string,
      signal?: AbortSignal,
    ): Promise<PartialSuccessResponse | undefined> {
      // 204 on full success; 200 with a warning body when the password
      // changed but the other sessions could not be revoked (OC-0314).
      return request<PartialSuccessResponse | undefined>(
        "PUT",
        "/users/me/password",
        { old_password: currentPassword, new_password: newPassword },
        signal,
      );
    },

    enableTotp(
      password: string,
      signal?: AbortSignal,
    ): Promise<{ qr_uri: string; backup_codes: string[] }> {
      return request("POST", "/users/me/totp/enable", { password }, signal);
    },

    confirmTotp(
      password: string,
      code: string,
      signal?: AbortSignal,
    ): Promise<PartialSuccessResponse | undefined> {
      // Unlike every other endpoint on this client, a wrong answer here
      // (an invalid enrollment code) is reported as 401 UNAUTHORIZED rather
      // than 400/403 — see doFetch's `skipUnauthorized`. Without this the
      // global session-expiry sink would fire on a mistyped code, signing
      // the user out and deleting their stored credential for a session
      // that was never actually invalid.
      return request<PartialSuccessResponse | undefined>(
        "POST",
        "/users/me/totp/confirm",
        { password, code },
        signal,
        {
          skipUnauthorized: true,
        },
      );
    },

    disableTotp(
      password: string,
      signal?: AbortSignal,
    ): Promise<PartialSuccessResponse | undefined> {
      return request<PartialSuccessResponse | undefined>(
        "DELETE",
        "/users/me/totp",
        { password },
        signal,
      );
    },

    /** Replace the emergency recovery codes; the new set is returned once. */
    regenerateRecoveryCodes(
      password: string,
      signal?: AbortSignal,
    ): Promise<{ backup_codes: string[] }> {
      return request("POST", "/users/me/totp/recovery-codes", { password }, signal);
    },

    /** Issue (or replace) the recovery kit; the server generates the secret. */
    enrolRecoveryKit(password: string, signal?: AbortSignal): Promise<RecoveryKitIssue> {
      return request<RecoveryKitIssue>("POST", "/users/me/recovery-kit", { password }, signal);
    },

    getRecoveryKitStatus(signal?: AbortSignal): Promise<RecoveryKitStatus> {
      return request<RecoveryKitStatus>("GET", "/users/me/recovery-kit", undefined, signal);
    },

    getOwnModeration(signal?: AbortSignal): Promise<OwnModerationAction[]> {
      return request<OwnModerationAction[]>("GET", "/users/me/moderation", undefined, signal);
    },

    /** File a local report; resolves to its opaque public id. */
    fileReport(body: FileReportRequest, signal?: AbortSignal): Promise<{ id: string }> {
      return request<{ id: string }>("POST", "/reports", body, signal);
    },

    getMyReports(signal?: AbortSignal): Promise<OwnReportSummary[]> {
      return request<OwnReportSummary[]>("GET", "/reports/mine", undefined, signal);
    },

    /** The moderator queue (B9-11). 403 without MODERATE_MEMBERS. */
    getModerationQueue(
      state: ModerationQueueFilter,
      signal?: AbortSignal,
    ): Promise<ModerationQueueRow[]> {
      const query = state === "" ? "" : `?state=${state}`;
      return request<ModerationQueueRow[]>("GET", `/moderation/queue${query}`, undefined, signal);
    },

    /** One report with its evidence (B9-11). 404 for a report about the caller. */
    getModerationReport(id: string, signal?: AbortSignal): Promise<ModerationReportDetail> {
      return request<ModerationReportDetail>(
        "GET",
        `/moderation/queue/${encodeURIComponent(id)}`,
        undefined,
        signal,
      );
    },

    /** Take a report (B9-12): 409 when another moderator already holds it or it closed. */
    assignModerationReport(id: string, signal?: AbortSignal): Promise<void> {
      return request<void>(
        "POST",
        `/moderation/queue/${encodeURIComponent(id)}/assign`,
        undefined,
        signal,
      );
    },

    /** Add an internal note: 409 once the report is closed. */
    addModerationNote(id: string, body: string, signal?: AbortSignal): Promise<void> {
      return request<void>(
        "POST",
        `/moderation/queue/${encodeURIComponent(id)}/notes`,
        { body },
        signal,
      );
    },

    /** Close a report with its outcome: 409 when it is already closed. */
    closeModerationReport(
      id: string,
      outcome: ModerationOutcome,
      signal?: AbortSignal,
    ): Promise<void> {
      return request<void>(
        "POST",
        `/moderation/queue/${encodeURIComponent(id)}/close`,
        { outcome },
        signal,
      );
    },

    /** Warn or time out a report's subject, linked to the report (B9-13). A
     *  timeout answers with its voice half, "applied" or "skipped"; a warning
     *  answers nothing. 403 below MODERATE_MEMBERS or the subject's rank. */
    actOnModerationReport(
      id: string,
      body: ModerationActRequest,
      signal?: AbortSignal,
    ): Promise<{ readonly voice?: string } | undefined> {
      return request<{ readonly voice?: string } | undefined>(
        "POST",
        `/moderation/queue/${encodeURIComponent(id)}/act`,
        body,
        signal,
      );
    },

    /** End a member's active timeout early: 404 when they have none. */
    liftTimeout(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", `/moderation/users/${userId}/untimeout`, undefined, signal);
    },

    /** The moderator appeal queue (B9-17). 403 without MODERATE_MEMBERS. */
    getModerationAppeals(
      state: ModerationAppealFilter,
      signal?: AbortSignal,
    ): Promise<ModerationAppealRow[]> {
      const query = state === "" ? "" : `?state=${state}`;
      return request<ModerationAppealRow[]>(
        "GET",
        `/moderation/appeals${query}`,
        undefined,
        signal,
      );
    },

    getModerationAppeal(id: string, signal?: AbortSignal): Promise<ModerationAppealDetail> {
      return request<ModerationAppealDetail>(
        "GET",
        `/moderation/appeals/${encodeURIComponent(id)}`,
        undefined,
        signal,
      );
    },

    /** Take an appeal: 409 when someone else holds it or it closed; never forced. */
    assignModerationAppeal(id: string, signal?: AbortSignal): Promise<void> {
      return request<void>(
        "POST",
        `/moderation/appeals/${encodeURIComponent(id)}/assign`,
        undefined,
        signal,
      );
    },

    /** Decide an appeal: 409 when it changed since read, or REVERSAL_FAILED. */
    decideModerationAppeal(
      id: string,
      outcome: AppealDecision,
      note: string,
      signal?: AbortSignal,
    ): Promise<void> {
      return request<void>(
        "POST",
        `/moderation/appeals/${encodeURIComponent(id)}/decide`,
        { outcome, note },
        signal,
      );
    },

    /** Records that the caller read their own warning. 404 when it is already
     *  acknowledged (or not theirs). */
    acknowledgeNotice(actionId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", `/users/me/notices/${actionId}/ack`, undefined, signal);
    },

    /** Files an appeal against the caller's own moderation action (its ledger id).
     *  409 ALREADY_APPEALED, 429 RATE_LIMITED, 404 when not theirs or gone. */
    fileAppeal(actionId: number, body: string, signal?: AbortSignal): Promise<{ id: string }> {
      return request<{ id: string }>("POST", "/appeals/", { action_id: actionId, body }, signal);
    },

    getMyAppeals(signal?: AbortSignal): Promise<MyAppeal[]> {
      return request<MyAppeal[]>("GET", "/appeals/mine", undefined, signal);
    },

    /** Open or assigned appeals only: 409 once decided or withdrawn, 404 when not the caller's. */
    withdrawAppeal(publicId: string, signal?: AbortSignal): Promise<void> {
      return request<void>(
        "POST",
        `/appeals/${encodeURIComponent(publicId)}/withdraw`,
        undefined,
        signal,
      );
    },

    getSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
      const owner = session;
      return request<SessionsListResponse>("GET", "/users/me/sessions", undefined, signal).then(
        (r) => {
          owner.assertCurrent();
          return r.sessions;
        },
      );
    },

    revokeSession(sessionId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/users/me/sessions/${sessionId}`, undefined, signal);
    },

    revokeAllSessions(signal?: AbortSignal): Promise<RevokeAllSessionsResponse> {
      return request<RevokeAllSessionsResponse>("DELETE", "/users/me/sessions", undefined, signal);
    },

    // ── Channels ──────────────────────────────────────────

    getMessages(
      channelId: number,
      options?: { before?: number; limit?: number },
      signal?: AbortSignal,
    ): Promise<MessagesResponse> {
      const params = new URLSearchParams();
      if (options?.before !== undefined) params.set("before", String(options.before));
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      return channelContent(channelId, () =>
        request<MessagesResponse>(
          "GET",
          `/channels/${channelId}/messages${qs ? `?${qs}` : ""}`,
          undefined,
          signal,
        ),
      );
    },

    /**
     * The window of history centred on `messageId`, for jumping to a message
     * outside the loaded page. Messages come back oldest-first (already in
     * render order) — see MessagesAroundResponse. 404 when the message does
     * not live in this channel or has been deleted.
     */
    getMessagesAround(
      channelId: number,
      messageId: number,
      options?: { limit?: number },
      signal?: AbortSignal,
    ): Promise<MessagesAroundResponse> {
      const params = new URLSearchParams();
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      const qs = params.toString();
      return channelContent(channelId, () =>
        request<MessagesAroundResponse>(
          "GET",
          `/channels/${channelId}/messages/around/${messageId}${qs ? `?${qs}` : ""}`,
          undefined,
          signal,
        ),
      );
    },

    /**
     * Bulk-delete the newest `limit` messages in a channel (1-100). Requires
     * MANAGE_MESSAGES; the server broadcasts one chat_bulk_deleted event, so
     * the local store is updated by the dispatcher rather than here.
     */
    purgeMessages(
      channelId: number,
      limit: number,
      options?: { before?: number },
      signal?: AbortSignal,
    ): Promise<PurgeResponse> {
      return request<PurgeResponse>(
        "POST",
        `/channels/${channelId}/messages/purge`,
        { limit, ...(options?.before !== undefined ? { before: options.before } : {}) },
        signal,
      );
    },

    /**
     * The users who reacted to a message with one emoji, for the who-reacted
     * tooltip. Oldest reaction first, capped at 100 server-side. The emoji is a
     * path segment, so it must be percent-encoded.
     */
    getReactionUsers(
      channelId: number,
      messageId: number,
      emoji: string,
      signal?: AbortSignal,
    ): Promise<ReactionUsersResponse> {
      return channelContent(channelId, () =>
        request<ReactionUsersResponse>(
          "GET",
          `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/users`,
          undefined,
          signal,
        ),
      );
    },

    getPins(channelId: number, signal?: AbortSignal): Promise<MessagesResponse> {
      return channelContent(channelId, () =>
        request<MessagesResponse>("GET", `/channels/${channelId}/pins`, undefined, signal),
      );
    },

    pinMessage(channelId: number, messageId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("POST", `/channels/${channelId}/pins/${messageId}`, undefined, signal);
    },

    unpinMessage(channelId: number, messageId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/channels/${channelId}/pins/${messageId}`, undefined, signal);
    },

    // ── Search ────────────────────────────────────────────

    search(
      query: string,
      options?: {
        channelId?: number;
        limit?: number;
        sort?: "relevance" | "recent";
        before?: number;
      },
      signal?: AbortSignal,
    ): Promise<SearchResponse> {
      const params = new URLSearchParams({ q: query });
      if (options?.channelId !== undefined) params.set("channel_id", String(options.channelId));
      if (options?.limit !== undefined) params.set("limit", String(options.limit));
      if (options?.sort !== undefined) params.set("sort", options.sort);
      // A `before` cursor only walks a newest-first list, so it implies the
      // sort rather than letting the caller submit an invalid pairing.
      if (options?.before !== undefined) {
        params.set("sort", "recent");
        params.set("before", String(options.before));
      }
      const send = (): Promise<SearchResponse> =>
        request<SearchResponse>("GET", `/search?${params.toString()}`, undefined, signal);
      // A server-wide search already omits channels the caller has not
      // acknowledged; a single-channel one is a content read like any other.
      return options?.channelId === undefined ? send() : channelContent(options.channelId, send);
    },

    /** Acknowledge a labelled channel for this account, on every device (B5-7). */
    acknowledgeNsfw(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("PUT", `/channels/${channelId}/nsfw-acknowledgement`, undefined, signal);
    },

    /** Withdraw this account's acknowledgement of a labelled channel (B5-7). */
    revokeNsfw(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>(
        "DELETE",
        `/channels/${channelId}/nsfw-acknowledgement`,
        undefined,
        signal,
      );
    },

    // ── GIFs ──────────────────────────────────────────────
    //
    // Proxied by the user's own server so the GIF provider API key never
    // ships in this bundle. A 503 GIF_DISABLED means the operator has not
    // configured a key — callers must degrade, not retry.

    gifSearch(query: string, limit: number, signal?: AbortSignal): Promise<GifSearchResponse> {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      return request<GifSearchResponse>(
        "GET",
        `/gif/search?${params.toString()}`,
        undefined,
        signal,
      );
    },

    gifTrending(limit: number, signal?: AbortSignal): Promise<GifSearchResponse> {
      const params = new URLSearchParams({ limit: String(limit) });
      return request<GifSearchResponse>(
        "GET",
        `/gif/trending?${params.toString()}`,
        undefined,
        signal,
      );
    },

    // ── File Uploads ──────────────────────────────────────

    /**
     * Upload one file. `onProgress` receives a 0–1 fraction for this upload
     * only, correlated by an id the client generates; the callback is not
     * called at all when the native transport reports none (e.g. a browser
     * adapter with no progress channel).
     */
    uploadFile(
      file: File,
      signal?: AbortSignal,
      onProgress?: (fraction: number) => void,
    ): Promise<UploadResponse> {
      const formData = new FormData();
      formData.append("file", file);

      return request<UploadResponse>("POST", "/uploads", formData, signal, {
        multipart: true,
        onUploadProgress: onProgress,
      });
    },

    // ── Invites ───────────────────────────────────────────

    getInvites(signal?: AbortSignal): Promise<InviteResponse[]> {
      return request<InviteResponse[]>("GET", "/invites", undefined, signal);
    },

    createInvite(
      data: { max_uses?: number; expires_in_hours?: number },
      signal?: AbortSignal,
    ): Promise<InviteResponse> {
      return request<InviteResponse>("POST", "/invites", data, signal);
    },

    revokeInvite(code: string, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/invites/${code}`, undefined, signal);
    },

    // ── Custom emoji ──────────────────────────────────────
    //
    // Reading is open to any member; upload and delete require MANAGE_SERVER
    // and are refused server-side with 403 regardless of what the UI offers.

    /** The server's whole custom-emoji set. */
    listEmoji(signal?: AbortSignal): Promise<EmojiResponse[]> {
      return request<EmojiResponse[]>("GET", "/emoji", undefined, signal);
    },

    /**
     * Upload one custom emoji. The image is validated server-side (PNG/JPEG/
     * GIF/WebP, at most 512 KB and 128x128), so the only thing this promises
     * is to send it; a rejection arrives as an ApiClientError with the reason.
     */
    uploadEmoji(shortcode: string, file: File, signal?: AbortSignal): Promise<EmojiResponse> {
      const formData = new FormData();
      formData.append("shortcode", shortcode);
      formData.append("file", file);

      return request<EmojiResponse>("POST", "/emoji", formData, signal, { multipart: true });
    },

    deleteEmoji(emojiId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/emoji/${emojiId}`, undefined, signal);
    },

    // ── Direct Messages ─────────────────────────────────────

    /** List user's open DM channels. */
    getDmChannels(signal?: AbortSignal): Promise<DmChannelsResponse> {
      return request<DmChannelsResponse>("GET", "/dms", undefined, signal);
    },

    /** Create or get a DM channel with a user. */
    createDm(recipientId: number, signal?: AbortSignal): Promise<CreateDmResponse> {
      return request<CreateDmResponse>("POST", "/dms", { recipient_id: recipientId }, signal);
    },

    /** Create a group DM with 2..8 other users (3..10 total). */
    createGroupDm(
      recipientIds: readonly number[],
      name?: string,
      signal?: AbortSignal,
    ): Promise<GroupDmResponse> {
      return request<GroupDmResponse>(
        "POST",
        "/dms/group",
        { recipient_ids: [...recipientIds], name: name ?? "" },
        signal,
      );
    },

    /** Set or clear a group DM's name. Any participant may; 1:1 DMs refuse. */
    renameGroupDm(channelId: number, name: string, signal?: AbortSignal): Promise<GroupDmResponse> {
      return request<GroupDmResponse>("PATCH", `/dms/${channelId}`, { name }, signal);
    },

    /**
     * Remove a DM from the sidebar. For a 1:1 this only hides it — the next
     * message from either side brings it back. For a group it is a *leave*:
     * the caller comes out of the participant list and cannot return unaided.
     */
    closeDm(channelId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/dms/${channelId}`, undefined, signal);
    },

    /** List recipient user IDs the current user has blocked. */
    listBlocks(signal?: AbortSignal): Promise<BlockedUsersResponse> {
      return request<BlockedUsersResponse>("GET", "/blocks", undefined, signal);
    },

    /** The pending Message Requests inbox (B5-6). */
    listDmRequests(signal?: AbortSignal): Promise<DmRequestListResponse> {
      return request<DmRequestListResponse>("GET", "/dm-requests", undefined, signal);
    },

    /** Decide a pending Message Request (B5-6). 409: no longer pending; 404: not the caller's. */
    decideDmRequest(
      id: number,
      decision: DmRequestDecision,
      signal?: AbortSignal,
    ): Promise<DmRequestDecisionResult> {
      return request<DmRequestDecisionResult>(
        "POST",
        `/dm-requests/${id}/${decision}`,
        undefined,
        signal,
      );
    },

    /** Block a user (prevents DMs in both directions). */
    blockUser(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("PUT", `/blocks/${userId}`, undefined, signal);
    },

    /** Unblock a previously blocked user. */
    unblockUser(userId: number, signal?: AbortSignal): Promise<void> {
      return request<void>("DELETE", `/blocks/${userId}`, undefined, signal);
    },

    // ── Voice ─────────────────────────────────────────────

    getVoiceCredentials(signal?: AbortSignal): Promise<VoiceCredentialsResponse> {
      return request<VoiceCredentialsResponse>("GET", "/voice/credentials", undefined, signal);
    },

    // ── Health ────────────────────────────────────────────

    async getHealth(
      host?: string,
      timeoutMs = 3000,
      signal?: AbortSignal,
    ): Promise<HealthResponse> {
      // Explicit-host checks belong to the server picker, independently of the
      // signed-in server. Its page supplies cancellation; current-server checks
      // additionally belong to the authenticated session.
      const targetHost = host ?? config.host;
      const owner =
        host === undefined
          ? session.fork(signal)
          : new SessionScope({ host: targetHost, generation }, signal ? [signal] : []);
      const transport = new AbortController();
      const releaseTransport = owner.addCleanup(() => transport.abort());
      const timer = setTimeout(() => owner.dispose(), timeoutMs);
      try {
        owner.assertCurrent();
        const origin = await owner.run(ensureHttpProxy(targetHost));
        owner.assertCurrent();
        const res = await owner.run(
          desktop.http.fetch(`${origin}/api/v1/health`, { signal: transport.signal }),
        );
        owner.assertCurrent();
        if (!res.ok) {
          // i18n-exempt: internal ApiClientError diagnostic; the connect page shows a fixed status, not this message
          throw new ApiClientError(res.status, "HEALTH_CHECK_FAILED", "Health check failed");
        }
        const data = await owner
          .run(res.json() as Promise<HealthResponse>)
          .finally(releaseTransport);
        owner.assertCurrent();
        return data;
      } finally {
        clearTimeout(timer);
        owner.dispose();
      }
    },

    async getServerInfo(
      host?: string,
      timeoutMs = 3000,
      signal?: AbortSignal,
    ): Promise<ServerInfoResponse> {
      // Same explicit-host shape as getHealth: the connect page probes every
      // saved profile independently of the signed-in server. B7-15 reads
      // through this method rather than inventing a second transport.
      const targetHost = host ?? config.host;
      const owner =
        host === undefined
          ? session.fork(signal)
          : new SessionScope({ host: targetHost, generation }, signal ? [signal] : []);
      const transport = new AbortController();
      const releaseTransport = owner.addCleanup(() => transport.abort());
      const timer = setTimeout(() => owner.dispose(), timeoutMs);
      try {
        owner.assertCurrent();
        const origin = await owner.run(ensureHttpProxy(targetHost));
        owner.assertCurrent();
        const res = await owner.run(
          desktop.http.fetch(`${origin}/api/v1/server-info`, { signal: transport.signal }),
        );
        owner.assertCurrent();
        if (!res.ok) {
          // i18n-exempt: internal ApiClientError diagnostic; the connect page shows a fixed status, not this message
          throw new ApiClientError(res.status, "SERVER_INFO_FAILED", "Server info check failed");
        }
        const data = await owner
          .run(res.json() as Promise<ServerInfoResponse>)
          .finally(releaseTransport);
        owner.assertCurrent();
        return data;
      } finally {
        clearTimeout(timer);
        owner.dispose();
      }
    },

    // ── Admin: Channels ──────────────────────────────────────

    adminCreateChannel(
      data: {
        name: string;
        type: ChannelType;
        category: string;
        topic?: string;
        position?: number;
      },
      signal?: AbortSignal,
    ): Promise<ChannelResponse> {
      return adminRequest<ChannelResponse>("POST", "/channels", data, signal);
    },

    adminUpdateChannel(
      id: number,
      data: {
        name?: string;
        topic?: string;
        // Moving a channel between categories is a rename of free text; an
        // omitted field keeps the channel's current category server-side.
        category?: string;
        slow_mode?: number;
        position?: number;
        archived?: boolean;
        /**
         * Age-restriction label. The server withholds a labelled channel's
         * content from anyone who has not acknowledged it (B5-7); clearing
         * the label drops every acknowledgement.
         */
        nsfw?: boolean;
        /**
         * Voice capacity limits (0 = unlimited), enforced by the server on
         * join. Omit them on a text channel rather than sending 0 — every
         * field the body leaves out keeps its stored value.
         */
        voice_max_users?: number;
        voice_max_video?: number;
      },
      signal?: AbortSignal,
    ): Promise<ChannelResponse> {
      return adminRequest<ChannelResponse>("PATCH", `/channels/${id}`, data, signal);
    },

    adminDeleteChannel(id: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("DELETE", `/channels/${id}`, undefined, signal);
    },

    // ── Admin: Members ──────────────────────────────────────

    adminKickMember(userId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("DELETE", `/users/${userId}/sessions`, undefined, signal);
    },

    adminBanMember(
      userId: number,
      reason?: string,
      durationHours?: number,
      signal?: AbortSignal,
    ): Promise<void> {
      return adminRequest<void>(
        "PATCH",
        `/users/${userId}`,
        {
          banned: true,
          ban_reason: reason ?? "",
          // Omitted/0 = permanent; otherwise the ban expires after this many hours.
          ...(durationHours !== undefined && durationHours > 0
            ? { ban_duration_hours: durationHours }
            : {}),
        },
        signal,
      );
    },

    adminChangeRole(userId: number, roleId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>(
        "PATCH",
        `/users/${userId}`,
        {
          role_id: roleId,
        },
        signal,
      );
    },

    /**
     * Lift a ban. The mirror of `adminBanMember`: the server broadcasts a
     * `member_join` for the unbanned user, which every client turns back into a
     * roster entry, so the roster needs no refreshing locally.
     */
    adminUnbanMember(userId: number, signal?: AbortSignal): Promise<void> {
      return adminRequest<void>("PATCH", `/users/${userId}`, { banned: false }, signal);
    },

    /**
     * The admin user page, which carries the ban state the roster cannot: a
     * banned member is removed from the roster entirely (MEMBER_BAN), so this
     * is the only way back to them. The server pages it (limit caps at 500,
     * ordered by ascending id), so this walks every page: one page alone would
     * hide a ban on any account past the first 500.
     */
    async adminListUsers(signal?: AbortSignal): Promise<AdminUser[]> {
      const pageSize = 500;
      const users: AdminUser[] = [];
      // ponytail: 200 pages (100k accounts) is a stop for a server that never
      // returns a short page, not a product limit; a banned-only server query
      // is the upgrade if the walk ever gets slow.
      for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
        const params = new URLSearchParams({
          limit: String(pageSize),
          offset: String(pageIndex * pageSize),
        });
        // oxlint-disable-next-line no-await-in-loop -- sequential paging: whether a next page exists depends on this one
        const page = await adminRequest<AdminUser[]>(
          "GET",
          `/users?${params.toString()}`,
          undefined,
          signal,
        );
        users.push(...page);
        if (page.length < pageSize) break;
      }
      return users;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
