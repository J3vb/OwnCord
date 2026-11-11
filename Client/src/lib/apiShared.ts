// Shared pieces of the REST client: errors and their copy, request options,
// response shapes and query helpers. Re-exported from api.ts.

import type { SessionScope } from "./net/sessionScope";
import { createLogger } from "./logger";
import { connectText } from "../i18n/connect";
import { messageStatusText } from "../i18n/messageStatus";
import type { ChannelMediaQuery, UserUploadsQuery } from "./types";
import { RestErrorCode, WsErrorCode } from "@lib/protocolTypes";
import type { RestReplyShapes } from "./net/restReplies";

/** Configuration for the API client. */
export interface ApiClientConfig {
  readonly host: string;
  readonly token?: string;
}

/** How long a detached logout may wait for the server before it is abandoned. */
export const LOGOUT_TIMEOUT_MS = 10_000;

/**
 * Per-request options for the internal `doFetch`. `onUploadProgress` tags a
 * multipart upload with a fresh id so the native transport's `upload-progress`
 * ticks can be matched to this request, and receives the matching ones as a
 * 0–1 fraction.
 */
export interface RequestOptions {
  skipUnauthorized?: boolean;
  token?: string;
  multipart?: boolean;
  detached?: boolean;
  /** Aborts the request once this many ms pass, so a server that never answers cannot hang it. */
  timeoutMs?: number;
  onUploadProgress?: (fraction: number) => void;
}

/**
 * The distinct code the desktop proxy reports for a TLS/certificate failure
 * (a refused first-use or changed TOFU pin, or a failed handshake). Kept in
 * step with `Client/src-tauri/src/tofu.rs`'s `TLS_CERT_ERROR_CODE`.
 */
export const TLS_CERT_CODE = "TLS_CERT_UNVERIFIED";

/**
 * The local code of a 2xx reply whose body is JSON but does not have the shape
 * its call promised (a required field missing, a field of the wrong kind). The
 * server never sends it: the client raises it, so it is not in the generated
 * error-code list.
 */
export const REPLY_SHAPE_CODE = "REPLY_UNREADABLE";

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
export function parseRetryAfterMs(res: Response): number | undefined {
  const value = res.headers.get("retry-after")?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) * 1000 : undefined;
}

/**
 * A request that never reached the server: the host is offline or
 * unreachable. `cause` keeps the transport's raw text for the log; the
 * display copy is `errorText`'s.
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

/** The auth slice's server sentences and the catalog copy each one gets. */
const AUTH_SLICE_COPY: Readonly<Record<string, Parameters<typeof connectText>[0]>> = {
  "account temporarily locked due to too many failed attempts": "error.accountLocked",
  "recovery temporarily locked due to too many failed attempts": "error.recoveryLocked",
  "too many failed attempts, try again later": "error.tooManyAttempts",
  "registration queue is full, try again later": "error.registrationQueueFull",
  "too many registrations from this address, try again later": "error.registrationRateLimited",
  "too many authentication attempts in progress, try again later": "error.authBusy",
  "too many recovery credentials issued; try again later": "error.recoveryCredentialBudget",
  "login temporarily unavailable": "error.loginUnavailable",
  "failed to load authentication policy": "error.couldNotComplete",
  "failed to process registration": "error.couldNotComplete",
  "failed to load registration policy": "error.registrationUnavailable",
  "registration failed — please try again": "error.registrationFailed",
  "failed to create session": "error.sessionFailed",
  "registration succeeded but user fetch failed": "error.registeredSignInFailed",
  "failed to start two-factor challenge": "error.totpUnavailable",
  "failed to verify two-factor code": "error.totpUnavailable",
  "two-factor verification temporarily unavailable": "error.totpUnavailable",
  "failed to logout": "error.logoutFailed",
  "failed to delete account": "error.deleteAccountFailed",
  "failed to generate two-factor secret": "error.totpEnableFailed",
  "failed to stage two-factor enrolment": "error.totpEnableFailed",
  "failed to enable two-factor authentication": "error.totpEnableFailed",
  "failed to disable two-factor authentication": "error.totpDisableFailed",
  "failed to issue recovery codes": "error.recoveryCodesFailed",
  "recovery failed — please try again": "error.recoveryFailed",
  "failed to issue the recovery kit": "error.recoveryKitFailed",
  "failed to issue the recovery credential": "error.recoveryCredentialFailed",
};

function authSliceCopy(message: string): string | null {
  return Object.hasOwn(AUTH_SLICE_COPY, message) ? connectText(AUTH_SLICE_COPY[message]!) : null;
}

/** Codes whose copy never depends on the server's message. */
const FIXED_ERROR_COPY = new Map<string, Parameters<typeof connectText>[0]>([
  // The desktop HTTP tunnel reports a refused certificate or a failed TLS
  // handshake with this distinct code (http_pool.rs's cert_error_response)
  // rather than a bare 502, so the two failure classes stay distinguishable.
  [TLS_CERT_CODE, "error.tlsFailed"],
  [RestErrorCode.AUTH_BUSY, "error.authBusy"],
  [RestErrorCode.NOT_FOUND, "error.notFound"],
  [WsErrorCode.BANNED, "error.banned"],
  [RestErrorCode.SERVICE_UNAVAILABLE, "error.unavailable"],
  [RestErrorCode.SERVER_SHUTTING_DOWN, "error.unavailable"],
  [RestErrorCode.BAD_GATEWAY, "error.unavailable"],
  // The server's transfer lifetime ended a slow upload (or its body stalled).
  [RestErrorCode.TRANSFER_TIMED_OUT, "error.transferTimedOut"],
  [RestErrorCode.STORAGE_QUOTA_EXCEEDED, "error.storageQuota"],
  [RestErrorCode.STORAGE_LOW_DISK, "error.storageLowDisk"],
  [RestErrorCode.STORAGE_ERROR, "error.storageError"],
  [RestErrorCode.GIF_DISABLED, "error.gifDisabled"],
  [RestErrorCode.LAST_ROLE, "error.lastRole"],
  [RestErrorCode.PUSH_DISABLED, "error.pushDisabled"],
  [RestErrorCode.LOGIN_SESSION_REQUIRED, "error.loginSessionRequired"],
]);

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
  const fixed = FIXED_ERROR_COPY.get(code);
  if (fixed !== undefined) return connectText(fixed);
  switch (code) {
    case RestErrorCode.RATE_LIMITED:
      return authSliceCopy(message) ?? connectText("error.rateLimited");
    case WsErrorCode.INTERNAL:
    case RestErrorCode.INTERNAL_ERROR:
      return authSliceCopy(message);
    case RestErrorCode.UNAUTHORIZED:
      if (message === "invalid credentials") return connectText("error.invalidCredentials");
      return isSessionExpired(message) ? connectText("error.unauthorized") : null;
    case RestErrorCode.FORBIDDEN:
      if (message === "your account has been suspended") return connectText("error.banned");
      return PERMISSION_REFUSAL.test(message) ? connectText("error.forbidden") : null;
    // The server's per-frame deadline; nothing was applied.
    case WsErrorCode.REQUEST_TIMEOUT:
      return messageStatusText("send.requestTimeout");
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
  if (code === WsErrorCode.INTERNAL || code === RestErrorCode.INTERNAL_ERROR) return fallback;
  return message ? capitalise(message) : fallback;
}

/** The ban response's own part: `purge` is present only when messages were
 *  asked for and the server handled the field. Its shape is not checked here;
 *  the Ban dialog reads it defensively. */
export interface BanMemberResponse {
  readonly purge?: unknown;
}

/** A failed request's text: friendly copy for a `TransportError`, `serverErrorText`
 *  for an `ApiClientError`, else the error's own message. */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof TransportError) return connectText("session.connectTimeout");
  if (err instanceof ApiClientError) return serverErrorText(err.code, err.message, fallback);
  return err instanceof Error ? err.message : fallback;
}

/** The webview's JSON/stream failure for a body that is not JSON. */
export function isNotJsonError(err: unknown): boolean {
  return (
    err instanceof SyntaxError ||
    (err instanceof Error && /JSON|Unexpected token/.test(err.message))
  );
}

export type OnUnauthorized = () => void;

export type {
  SessionInfo,
  DmPrivacy,
  UserNote,
  OwnApiToken,
  OwnApiTokensListResponse,
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
  DmRequestDecisionResult,
  SessionsListResponse,
} from "./apiSharedTypes";

export const log = createLogger("api");

/**
 * A content read from one channel, admitted only with NSFW consent:
 * refused locally, with the server's own error, before any request while
 * the channel is gated, and discarded if consent was withdrawn while it was
 * in flight — so nothing from a labelled channel is fetched or delivered
 * pre-consent, whichever feature asked.
 */
/** The gallery query as URL parameters; empty and unset filters are left out. */
export function channelMediaParams(query: ChannelMediaQuery): URLSearchParams {
  const params = new URLSearchParams({ kind: query.kind });
  if (query.order !== undefined) params.set("order", query.order);
  if (query.q !== undefined && query.q.trim() !== "") params.set("q", query.q.trim());
  if (query.from !== undefined) params.set("from", String(query.from));
  if (query.month !== undefined) params.set("month", query.month);
  if (query.tz !== undefined && query.tz !== "") params.set("tz", query.tz);
  if (query.cursor !== undefined && query.cursor !== "") params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return params;
}

/** The My uploads query as URL parameters; empty filters are left out. */
export function userUploadsParams(query: UserUploadsQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.sort !== undefined) params.set("sort", query.sort);
  if (query.q !== undefined && query.q.trim() !== "") params.set("q", query.q.trim());
  if (query.cursor !== undefined && query.cursor !== "") params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return params;
}

/** What the per-domain REST modules borrow from createApiClient: its request
 *  helpers and live reads of its config, session and generation. */
export interface ApiTransport {
  request<K extends keyof RestReplyShapes>(
    reply: K,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    opts?: RequestOptions,
  ): Promise<RestReplyShapes[K]>;
  channelRequest<K extends keyof RestReplyShapes>(
    reply: K,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<RestReplyShapes[K]>;
  memberRequest<K extends keyof RestReplyShapes>(
    reply: K,
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<RestReplyShapes[K]>;
  channelContent<T>(channelId: number, load: () => Promise<T>): Promise<T>;
  readonly config: Readonly<ApiClientConfig>;
  readonly session: SessionScope;
  readonly generation: number;
}
