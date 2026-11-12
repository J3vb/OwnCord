// Response and request shapes of the REST client's account, moderation and
// report endpoints. Type-only; re-exported from apiShared.ts.

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

/** One of the caller's live API tokens, from GET /users/me/api-tokens
 *  (`{tokens: [...]}`). Revoked and expired tokens are not listed. */
export interface OwnApiToken {
  readonly id: number;
  readonly label: string;
  readonly created_at: string;
  readonly last_used: string | null;
  readonly expires_at: string | null;
}

export interface OwnApiTokensListResponse {
  readonly tokens: readonly OwnApiToken[];
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
