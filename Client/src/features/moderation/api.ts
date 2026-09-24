/**
 * The Moderation Center adapter (B9-11): the one place the B5-8 queue and
 * report wire shapes become the view's model.
 *
 * It keeps only what the view renders. Notes, events and actions (B9-12's)
 * are dropped, and an attachment keeps its name, type and size but never its
 * id, so nothing past this point can fetch the file.
 *
 * Evidence is only ever narrowed here, never widened: the server's
 * `evidence_withheld` is final, and evidence the server did return is still
 * withheld when this client holds no NSFW consent for its channel (consent
 * withdrawn while the read was in flight).
 */

import type { ModerationQueueRow, ModerationReportDetail } from "@lib/api";
import { NSFW_ACKNOWLEDGEMENT_REQUIRED, nsfwContentBlocked } from "../content-consent/nsfw";

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

export interface ReportDetail {
  readonly id: string;
  readonly channelId: number | null;
  readonly detail: string;
  readonly state: string;
  readonly outcome: string;
  readonly assigneeId: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly evidence: Evidence;
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

export function mapDetail(w: ModerationReportDetail): ReportDetail {
  return {
    id: w.id,
    channelId: w.channel_id ?? null,
    detail: w.detail,
    state: w.state,
    outcome: w.outcome,
    assigneeId: w.assignee_id,
    createdAt: w.created_at,
    closedAt: w.closed_at ?? null,
    evidence: mapEvidence(w),
  };
}
