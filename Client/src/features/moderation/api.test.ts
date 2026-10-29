// B9-11/B9-17: the wire-to-view adapter. These cases pin how absent fields
// from an older server read, which timeouts count as running, and which
// report an appeal links to.
import { beforeEach, describe, expect, it } from "vitest";
import type { ModerationAppealDetail, ModerationReportDetail } from "@lib/api";
import { resetChannelsStore } from "@stores/channels.store";
import {
  activeTimeoutEnd,
  itemFromDetail,
  mapAppealDetail,
  mapDetail,
  type HistoryEntry,
  type ReportDetail,
} from "./api";

beforeEach(() => resetChannelsStore());

function wire(over: Partial<ModerationReportDetail> = {}): ModerationReportDetail {
  return {
    id: "r1",
    reporter_id: 3,
    subject_id: 4,
    target_type: "user",
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

function view(history: HistoryEntry[]): ReportDetail {
  return { ...mapDetail(wire()), history };
}

const timeout = (over: Partial<Extract<HistoryEntry, { kind: "action" }>> = {}): HistoryEntry => ({
  kind: "action",
  action: "timeout",
  reason: "flooding",
  actorId: 9,
  at: "2026-09-05 10:00:00",
  expiresAt: "2026-09-05 12:00:00",
  liftedAt: null,
  ...over,
});

const name = (id: number): string => `member-${id}`;

const NOW = Date.parse("2026-09-05T11:00:00Z");

describe("activeTimeoutEnd", () => {
  it("returns the end of a timeout that is still running", () => {
    expect(activeTimeoutEnd(view([timeout()]), NOW)).toBe("2026-09-05 12:00:00");
  });

  it("ignores actions that are not timeouts, even with a future end", () => {
    expect(activeTimeoutEnd(view([timeout({ action: "warning" })]), NOW)).toBeNull();
    expect(
      activeTimeoutEnd(
        view([{ kind: "event", action: "timeout", detail: "", actorId: 9, at: "2026-09-05" }]),
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores a lifted timeout and one with no end", () => {
    expect(activeTimeoutEnd(view([timeout({ liftedAt: "2026-09-05 10:30:00" })]), NOW)).toBeNull();
    expect(activeTimeoutEnd(view([timeout({ expiresAt: null })]), NOW)).toBeNull();
  });

  it("does not count a timeout that ends exactly now or earlier", () => {
    expect(activeTimeoutEnd(view([timeout({ expiresAt: "2026-09-05 11:00:00" })]), NOW)).toBeNull();
    expect(activeTimeoutEnd(view([timeout({ expiresAt: "2026-09-05 10:59:59" })]), NOW)).toBeNull();
  });

  it("does not guess at an unreadable end", () => {
    expect(activeTimeoutEnd(view([timeout({ expiresAt: "sometime soon" })]), NOW)).toBeNull();
    expect(activeTimeoutEnd(view([timeout({ expiresAt: "" })]), NOW)).toBeNull();
  });

  it("skips past an expired one to a running one", () => {
    const history = [timeout({ expiresAt: "2026-09-05 10:30:00" }), timeout()];
    expect(activeTimeoutEnd(view(history), NOW)).toBe("2026-09-05 12:00:00");
  });
});

describe("mapDetail from an older server", () => {
  it("reads absent notes, events and actions as empty lists", () => {
    const { notes: _n, events: _e, actions: _a, ...bare } = wire();
    const d = mapDetail(bare as unknown as ModerationReportDetail);
    expect(d.notes).toEqual([]);
    expect(d.history).toEqual([]);
  });

  it("lists events and actions together, oldest first, with unreadable times last", () => {
    const d = mapDetail(
      wire({
        events: [
          { actor_id: 1, action: "noted", detail: "", created_at: "" },
          { actor_id: 1, action: "assigned", detail: "", created_at: "2026-09-05 11:00:00" },
        ],
        actions: [
          {
            id: 1,
            kind: "warning",
            reason: "r",
            actor_id: 2,
            created_at: "2026-09-05 10:00:00",
          },
        ],
      }),
    );
    expect(d.history.map((h) => [h.kind, h.action])).toEqual([
      ["action", "warning"],
      ["event", "assigned"],
      ["event", "noted"],
    ]);
    const action = d.history[0]!;
    expect(action.kind === "action" && [action.expiresAt, action.liftedAt]).toEqual([null, null]);
  });
});

describe("itemFromDetail", () => {
  it("names the reporter and subject from the report itself", () => {
    const item = itemFromDetail(wire({ reporter_id: 3, subject_id: 4 }), name);
    expect(item.reporterName).toBe("member-3");
    expect(item.subjectName).toBe("member-4");
  });

  it("leaves an erased reporter or subject unnamed", () => {
    const item = itemFromDetail(wire({ reporter_id: 0, subject_id: 0 }), name);
    expect(item.reporterName).toBe("");
    expect(item.subjectName).toBe("");
    const half = itemFromDetail(wire({ reporter_id: 0, subject_id: 4 }), name);
    expect([half.reporterName, half.subjectName]).toEqual(["", "member-4"]);
    const other = itemFromDetail(wire({ reporter_id: 3, subject_id: 0 }), name);
    expect([other.reporterName, other.subjectName]).toEqual(["member-3", ""]);
  });
});

function appeal(over: Partial<ModerationAppealDetail> = {}): ModerationAppealDetail {
  return {
    id: "ap1",
    action_id: 5,
    appellant_id: 3,
    state: "open",
    assignee_id: 0,
    created_at: "2026-09-05 10:00:00",
    decided_at: null,
    body: "please",
    decided_by: 0,
    decision_note: "",
    action: { id: 5, kind: "timeout", actor_id: 9, reason: "r", created_at: "2026-09-05" },
    ...over,
  };
}

describe("mapAppealDetail report link", () => {
  it("links the report only when the server returned one", () => {
    expect(mapAppealDetail(appeal({ report_id: "r-77" })).reportId).toBe("r-77");
    expect(mapAppealDetail(appeal({ report_id: "" })).reportId).toBeNull();
    expect(mapAppealDetail(appeal()).reportId).toBeNull();
  });
});
