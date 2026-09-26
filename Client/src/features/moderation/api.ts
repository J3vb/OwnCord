/**
 * The Moderation Center adapter (B9-11): the one place the B5-8 queue and
 * report wire shapes become the view's model.
 *
 * It keeps only what the view renders: an attachment keeps its name, type and
 * size but never its id, so nothing past this point can fetch the file.
 * Internal notes stay apart from the history (B9-12), which merges the
 * report's own events and the moderator actions taken with it in time order.
 *
 * Evidence is only ever narrowed here, never widened: the server's
 * `evidence_withheld` is final, and evidence the server did return is still
 * withheld when this client holds no NSFW consent for its channel (consent
 * withdrawn while the read was in flight).
 */

import {
  ApiClientError,
  type ModerationAppealDetail,
  type ModerationAppealRow,
  type ModerationQueueRow,
  type ModerationReportDetail,
} from "@lib/api";
import { parseTimestamp } from "@components/message-list/formatting";
import { NSFW_ACKNOWLEDGEMENT_REQUIRED, nsfwContentBlocked } from "../content-consent/nsfw";

/** Whether a request failed with this HTTP status (and error code, when given). */
export function isStatus(err: unknown, status: number, code?: string): boolean {
  return (
    err instanceof ApiClientError &&
    err.status === status &&
    (code === undefined || err.code === code)
  );
}

export interface QueueItem {
  readonly id: string;
  readonly reporterName: string;
  readonly subjectName: string;
  readonly targetType: string;
  readonly reason: string;
  readonly state: string;
  readonly outcome: string;
  readonly assigneeId: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface EvidenceAttachment {
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
}

export interface EvidenceRow {
  /** 0 is the reported message; negative before it, positive after. */
  readonly seq: number;
  readonly authorId: number;
  readonly content: string;
  readonly attachments: readonly EvidenceAttachment[];
  readonly capturedAt: string;
}

export type Evidence =
  | { readonly kind: "shown"; readonly rows: readonly EvidenceRow[] }
  /** Withheld until this account acknowledges `channelId` (B5-7/B9-7). */
  | { readonly kind: "consent"; readonly channelId: number }
  | { readonly kind: "unavailable" };

/** An internal note: moderators only, never either party. */
export interface ReportNote {
  readonly authorId: number;
  readonly body: string;
  readonly createdAt: string;
}

export type HistoryEntry =
  /** A report_events row: created, assigned, noted or closed. */
  | {
      readonly kind: "event";
      readonly action: string;
      readonly detail: string;
      readonly actorId: number;
      readonly at: string;
    }
  /** A moderator action taken with this report; its reason is shown to the member. */
  | {
      readonly kind: "action";
      readonly action: string;
      readonly reason: string;
      readonly actorId: number;
      readonly at: string;
      /** A timeout's end. */
      readonly expiresAt: string | null;
      readonly liftedAt: string | null;
    };

export interface ReportDetail {
  readonly id: string;
  readonly reporterId: number;
  /** The reported account; 0 once it is erased. */
  readonly subjectId: number;
  /** What was reported: "message" is the one a removal can act on. */
  readonly targetType: string;
  readonly channelId: number | null;
  readonly detail: string;
  readonly state: string;
  readonly outcome: string;
  readonly assigneeId: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly evidence: Evidence;
  readonly notes: readonly ReportNote[];
  readonly history: readonly HistoryEntry[];
}

export function mapQueueRow(w: ModerationQueueRow): QueueItem {
  return {
    id: w.id,
    reporterName: w.reporter_name,
    subjectName: w.subject_name,
    targetType: w.target_type,
    reason: w.reason,
    state: w.state,
    outcome: w.outcome,
    assigneeId: w.assignee_id,
    createdAt: w.created_at,
    closedAt: w.closed_at ?? null,
  };
}

/** The attachments column: a JSON array of references. Anything else is none. */
export function parseAttachments(raw: string): EvidenceAttachment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: EvidenceAttachment[] = [];
  for (const a of parsed as unknown[]) {
    if (typeof a !== "object" || a === null) continue;
    const { filename, mime, size } = a as Record<string, unknown>;
    if (typeof filename !== "string") continue;
    out.push({
      filename,
      mime: typeof mime === "string" ? mime : "",
      size: typeof size === "number" ? size : 0,
    });
  }
  return out;
}

function mapEvidence(w: ModerationReportDetail): Evidence {
  const channelId = w.channel_id ?? null;
  const withheld = w.evidence_withheld ?? "";
  if (withheld === NSFW_ACKNOWLEDGEMENT_REQUIRED && channelId !== null) {
    return { kind: "consent", channelId };
  }
  if (withheld !== "") return { kind: "unavailable" };
  if (channelId !== null && nsfwContentBlocked(channelId)) return { kind: "consent", channelId };
  return {
    kind: "shown",
    rows: w.evidence
      .map((e) => ({
        seq: e.seq,
        authorId: e.author_id,
        content: e.content,
        attachments: parseAttachments(e.attachments),
        capturedAt: e.captured_at,
      }))
      .toSorted((a, b) => a.seq - b.seq),
  };
}

/** The end of a timeout taken with this report that is still running at `now` (B9-13). */
export function activeTimeoutEnd(detail: ReportDetail, now: number): string | null {
  for (const e of detail.history) {
    if (e.kind !== "action" || e.action !== "timeout" || e.liftedAt !== null) continue;
    if (e.expiresAt === null) continue;
    const end = timeOf(e.expiresAt);
    // An unreadable end is not a running timeout: the server is asked, not guessed.
    if (end > now && end !== Number.MAX_SAFE_INTEGER) return e.expiresAt;
  }
  return null;
}

/** Sort key: an unreadable time goes last rather than breaking the order. */
function timeOf(raw: string): number {
  const ms = raw === "" ? Number.NaN : parseTimestamp(raw).getTime();
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms;
}

function mapHistory(w: ModerationReportDetail): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    ...(w.events ?? []).map((e) => ({
      kind: "event" as const,
      action: e.action,
      detail: e.detail,
      actorId: e.actor_id,
      at: e.created_at,
    })),
    ...(w.actions ?? []).map((a) => ({
      kind: "action" as const,
      action: a.kind,
      reason: a.reason,
      actorId: a.actor_id,
      at: a.created_at,
      expiresAt: a.expires_at ?? null,
      liftedAt: a.lifted_at ?? null,
    })),
  ];
  // Stable: rows at the same second keep the server's order, events first.
  return entries.toSorted((a, b) => timeOf(a.at) - timeOf(b.at));
}

export function mapDetail(w: ModerationReportDetail): ReportDetail {
  return {
    id: w.id,
    reporterId: w.reporter_id,
    subjectId: w.subject_id,
    targetType: w.target_type,
    channelId: w.channel_id ?? null,
    detail: w.detail,
    state: w.state,
    outcome: w.outcome,
    assigneeId: w.assignee_id,
    createdAt: w.created_at,
    closedAt: w.closed_at ?? null,
    evidence: mapEvidence(w),
    notes: (w.notes ?? []).map((n) => ({
      authorId: n.author_id,
      body: n.body,
      createdAt: n.created_at,
    })),
    history: mapHistory(w),
  };
}

/**
 * A report opened by id from an appeal (B9-17), which may be outside the
 * current filter: its title and names come from the report itself.
 */
export function itemFromDetail(w: ModerationReportDetail, name: (id: number) => string): QueueItem {
  return {
    id: w.id,
    reporterName: w.reporter_id === 0 ? "" : name(w.reporter_id),
    subjectName: w.subject_id === 0 ? "" : name(w.subject_id),
    targetType: w.target_type,
    reason: w.reason,
    state: w.state,
    outcome: w.outcome,
    assigneeId: w.assignee_id,
    createdAt: w.created_at,
    closedAt: w.closed_at ?? null,
  };
}

/**
 * An appeal queue row (B9-17). The appellant's statement and any decision
 * note are dropped here: the list shows who, what state and when, and the
 * text is read only with the appeal it belongs to.
 */
export interface AppealItem {
  readonly id: string;
  /** 0 once the appellant's account is erased. */
  readonly appellantId: number;
  readonly state: string;
  readonly assigneeId: number;
  readonly createdAt: string;
}

export function mapAppealRow(w: ModerationAppealRow): AppealItem {
  return {
    id: w.id,
    appellantId: w.appellant_id,
    state: w.state,
    assigneeId: w.assignee_id,
    createdAt: w.created_at,
  };
}

/** One appeal and the action it is about. Kept apart from ReportDetail: no evidence, no notes. */
export interface AppealDetail {
  readonly id: string;
  readonly appellantId: number;
  readonly state: string;
  readonly assigneeId: number;
  readonly decidedBy: number;
  /** The appellant's statement. */
  readonly body: string;
  /** Sent to the appellant with the decision; never an internal note. */
  readonly decisionNote: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly action: {
    readonly kind: string;
    readonly actorId: number;
    readonly reason: string;
    readonly createdAt: string;
    readonly expiresAt: string | null;
    readonly acknowledgedAt: string | null;
    readonly liftedAt: string | null;
  };
  /** Set only when the server returned the linked report for this reader. */
  readonly reportId: string | null;
}

export function mapAppealDetail(w: ModerationAppealDetail): AppealDetail {
  return {
    id: w.id,
    appellantId: w.appellant_id,
    state: w.state,
    assigneeId: w.assignee_id,
    decidedBy: w.decided_by,
    body: w.body,
    decisionNote: w.decision_note,
    createdAt: w.created_at,
    decidedAt: w.decided_at,
    action: {
      kind: w.action.kind,
      actorId: w.action.actor_id,
      reason: w.action.reason,
      createdAt: w.action.created_at,
      expiresAt: w.action.expires_at ?? null,
      acknowledgedAt: w.action.acknowledged_at ?? null,
      liftedAt: w.action.lifted_at ?? null,
    },
    reportId: typeof w.report_id === "string" && w.report_id !== "" ? w.report_id : null,
  };
}
