// One moderation report as the queue lists it and as its detail answers,
// shared by the report-tab tests so each does not carry its own copy.
import type { ModerationQueueRow, ModerationReportDetail } from "@lib/api";

export function reportRow(id: string, over: Partial<ModerationQueueRow> = {}): ModerationQueueRow {
  return {
    id,
    reporter_name: "carol",
    subject_name: "alice",
    target_type: "message",
    target_ref: "42",
    reason: "spam",
    state: "open",
    assignee_id: 0,
    outcome: "",
    created_at: "2026-09-05 10:00:00",
    updated_at: "2026-09-05 10:00:00",
    ...over,
  };
}

export function reportDetail(
  id: string,
  over: Partial<ModerationReportDetail> = {},
): ModerationReportDetail {
  return {
    id,
    reporter_id: 3,
    subject_id: 4,
    target_type: "message",
    reason: "spam",
    detail: "",
    state: "open",
    assignee_id: 0,
    outcome: "",
    created_at: "2026-09-05 10:00:00",
    evidence: [],
    notes: [],
    events: [],
    actions: [],
    ...over,
  };
}
