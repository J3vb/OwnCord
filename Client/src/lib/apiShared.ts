// Shared pieces of the REST client: errors and their copy, request options,
// response shapes and query helpers. Re-exported from api.ts.

import type { SessionScope } from "./net/sessionScope";
import { createLogger } from "./logger";
import { connectText } from "../i18n/connect";
import { messageStatusText } from "../i18n/messageStatus";
import type { ChannelMediaQuery, UserUploadsQuery } from "./types";
import { RestErrorCode, WsErrorCode } from "@lib/protocolTypes";

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
    case RestErrorCode.RATE_LIMITED:
      return authSliceCopy(message) ?? connectText("error.rateLimited");
    case RestErrorCode.AUTH_BUSY:
      return connectText("error.authBusy");
    case WsErrorCode.INTERNAL:
    case RestErrorCode.INTERNAL_ERROR:
      return authSliceCopy(message);
    case RestErrorCode.UNAUTHORIZED:
      if (message === "invalid credentials") return connectText("error.invalidCredentials");
      return isSessionExpired(message) ? connectText("error.unauthorized") : null;
    case RestErrorCode.FORBIDDEN:
      if (message === "your account has been suspended") return connectText("error.banned");
      return PERMISSION_REFUSAL.test(message) ? connectText("error.forbidden") : null;
    case RestErrorCode.NOT_FOUND:
      return connectText("error.notFound");
    // The server's per-frame deadline; nothing was applied.
    case WsErrorCode.REQUEST_TIMEOUT:
      return messageStatusText("send.requestTimeout");
    case WsErrorCode.BANNED:
      return connectText("error.banned");
    case RestErrorCode.SERVICE_UNAVAILABLE:
    case RestErrorCode.BAD_GATEWAY:
      return connectText("error.unavailable");
    case RestErrorCode.STORAGE_QUOTA_EXCEEDED:
      return connectText("error.storageQuota");
    case RestErrorCode.STORAGE_LOW_DISK:
      return connectText("error.storageLowDisk");
    case RestErrorCode.STORAGE_ERROR:
      return connectText("error.storageError");
    case RestErrorCode.GIF_DISABLED:
      return connectText("error.gifDisabled");
    case RestErrorCode.LAST_ROLE:
      return connectText("error.lastRole");
    case RestErrorCode.PUSH_DISABLED:
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

/** The caller's direct message privacy settings. Both are always sent. */
export interface DmPrivacy {
  readonly allow_member_dms: boolean;
  readonly message_requests: boolean;
}

/** GET and PUT /users/me/notes/{userId}: the caller's private note about one
 *  member. `note` is "" when there is none (a PUT of "" deletes it). */
export interface UserNote {
  readonly user_id: number;
  readonly note: string;
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

/** One row of GET /moderation/queue, for MODERATE_MEMBERS holders
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

/** GET /moderation/queue/{id}: the fields the Moderation Center reads.
 *  Mirrors Server/api/moderation_queue_handler.go's
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

/** POST /moderation/queue/{id}/act: the report-linked actions the Moderation Center sends. A
 *  timeout's duration is 60 to 2,419,200 seconds (Server/service/moderation.go). */
export type ModerationActRequest =
  | { readonly kind: "warning"; readonly reason: string }
  | { readonly kind: "timeout"; readonly reason: string; readonly duration_seconds: number }
  /** Removal acts on the reported message; kick is a force-logout. */
  | { readonly kind: "removal" | "kick" | "ban"; readonly reason: string };

/** POST /moderation/queue/{id}/close outcomes (Server/service/report.go). */
export type ModerationOutcome = "actioned" | "no_action" | "duplicate";

/** GET /moderation/appeals' `state` filter: "" is open and assigned together;
 *  "decided" is upheld and overturned. */
export type ModerationAppealFilter = "" | "open" | "assigned" | "decided";

/** One row of GET /moderation/appeals, for MODERATE_MEMBERS holders
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

export interface SessionsListResponse {
  readonly sessions: SessionInfo[];
}

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
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    opts?: RequestOptions,
  ): Promise<T>;
  channelRequest<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  memberRequest<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  channelContent<T>(channelId: number, load: () => Promise<T>): Promise<T>;
  readonly config: Readonly<ApiClientConfig>;
  readonly session: SessionScope;
  readonly generation: number;
}
