/** Synthetic moderation payloads the mocked Moderation Center specs share. */

export const modRow = (
  id: string,
  state: string,
  assignee: number,
  reason: string,
  target = "user",
) => ({
  id,
  reporter_name: "synthetic-reporter",
  subject_name: "otheruser",
  target_type: target,
  target_ref: target === "message" ? "55" : "2",
  reason,
  state,
  assignee_id: assignee,
  outcome: "",
  created_at: "2026-09-05T10:00:00Z",
  updated_at: "2026-09-05T10:00:00Z",
});

export const appealRow = (id: string, over: object) => ({
  id,
  action_id: 12,
  appellant_id: 2,
  body: "",
  state: "assigned",
  assignee_id: 1,
  decided_by: 0,
  decision_note: "",
  created_at: "2026-09-06T10:00:00Z",
  decided_at: null,
  ...over,
});

export const APPEAL_ACTION = {
  id: 12,
  kind: "timeout",
  actor_id: 2,
  reason: "Synthetic timeout reason shown to the member.",
  created_at: "2026-09-05T10:50:00Z",
  expires_at: "2999-01-01T00:00:00Z",
};
