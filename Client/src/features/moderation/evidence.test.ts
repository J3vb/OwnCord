// B9-11: the moderation adapter and the evidence renderer. Evidence is only
// ever what the server returned, narrowed (never widened) by this client's
// NSFW consent, and rendered as inert text.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModerationReportDetail } from "@lib/api";
import type { ReadyChannel } from "@lib/types";
import { resetChannelsStore, setChannels, setNsfwAcknowledged } from "@stores/channels.store";
import { setMembers } from "@stores/members.store";
import { mapDetail, mapQueueRow, parseAttachments, type QueueItem } from "./api";
import { buildReportDetail, dateText } from "./Evidence";

const SPICY = 7;
const PLAIN = 8;

function channels(): void {
  const spicy: ReadyChannel = {
    id: SPICY,
    name: "spicy",
    type: "text",
    category: null,
    position: 0,
    nsfw: true,
    nsfw_acknowledged: true,
  };
  setChannels([spicy, { id: PLAIN, name: "plain", type: "text", category: null, position: 1 }]);
}

function wire(over: Partial<ModerationReportDetail> = {}): ModerationReportDetail {
  return {
    id: "a1b2",
    reporter_id: 3,
    subject_id: 4,
    notes: [],
    events: [],
    actions: [],
    target_type: "message",
    channel_id: PLAIN,
    reason: "harassment",
    detail: "synthetic reporter detail",
    state: "open",
    assignee_id: 0,
    outcome: "",
    created_at: "2026-09-05T10:00:00Z",
    evidence: [
      {
        seq: 1,
        author_id: 2,
        content: "after",
        attachments: "[]",
        captured_at: "2026-09-05T10:00:00Z",
      },
      {
        seq: 0,
        author_id: 2,
        content: "reported <img src=x onerror=alert(1)> https://example.invalid/pixel.png",
        attachments: JSON.stringify([
          { id: "upload-secret-id", filename: "notes.txt", mime: "text/plain", size: 2048 },
        ]),
        captured_at: "2026-09-05T10:00:00Z",
      },
      {
        seq: -1,
        author_id: 3,
        content: "",
        attachments: "[]",
        captured_at: "2026-09-05T10:00:00Z",
      },
    ],
    ...over,
  };
}

const item: QueueItem = mapQueueRow({
  id: "a1b2",
  reporter_name: "bob",
  subject_name: "alice",
  target_type: "message",
  target_ref: "42",
  channel_id: PLAIN,
  reason: "harassment",
  state: "open",
  assignee_id: 0,
  outcome: "",
  created_at: "2026-09-05T10:00:00Z",
  updated_at: "2026-09-05T10:00:00Z",
});

beforeEach(() => {
  resetChannelsStore();
  channels();
  setMembers([
    { id: 2, username: "alice", avatar: null, role: "member", status: "online" },
    { id: 3, username: "carol", avatar: null, role: "member", status: "online" },
  ]);
});

describe("parseAttachments", () => {
  it("keeps name, type and size, never the upload id", () => {
    const refs = parseAttachments(
      JSON.stringify([{ id: "x", filename: "a.png", mime: "image/png", size: 5 }]),
    );
    expect(refs).toEqual([{ filename: "a.png", mime: "image/png", size: 5 }]);
  });

  it("reads anything malformed as no attachments", () => {
    expect(parseAttachments("not json")).toEqual([]);
    expect(parseAttachments('{"filename":"a"}')).toEqual([]);
    expect(parseAttachments('[null, 1, {"mime":"x"}]')).toEqual([]);
    expect(parseAttachments('[{"filename":"a"}]')).toEqual([{ filename: "a", mime: "", size: 0 }]);
  });
});

describe("mapDetail", () => {
  it("orders the snapshot around the reported message and never keeps an upload id", () => {
    const d = mapDetail({
      ...wire(),
      notes: [{ id: 1, author_id: 9, body: "internal note", created_at: "2026-09-05 11:00:00" }],
      events: [{ actor_id: 9, action: "assigned", detail: "", created_at: "2026-09-05 11:00:00" }],
    });
    expect(d.evidence.kind).toBe("shown");
    if (d.evidence.kind !== "shown") return;
    expect(d.evidence.rows.map((r) => r.seq)).toEqual([-1, 0, 1]);
    // B9-12: notes stay apart from the history; neither carries anything else.
    expect(d.notes).toEqual([
      { authorId: 9, body: "internal note", createdAt: "2026-09-05 11:00:00" },
    ]);
    expect(d.history).toEqual([
      { kind: "event", action: "assigned", detail: "", actorId: 9, at: "2026-09-05 11:00:00" },
    ]);
    expect(JSON.stringify(d)).not.toContain("upload-secret-id");
  });

  it("keeps the server's withholding", () => {
    expect(
      mapDetail(
        wire({
          channel_id: SPICY,
          evidence: [],
          evidence_withheld: "NSFW_ACKNOWLEDGEMENT_REQUIRED",
        }),
      ).evidence,
    ).toEqual({ kind: "consent", channelId: SPICY });
    expect(
      mapDetail(wire({ evidence: [], evidence_withheld: "SOURCE_CHANNEL_UNAVAILABLE" })).evidence,
    ).toEqual({ kind: "unavailable" });
    // An unknown reason, or consent with no channel to consent to, is not shown either.
    expect(mapDetail(wire({ evidence: [], evidence_withheld: "SOMETHING_NEW" })).evidence).toEqual({
      kind: "unavailable",
    });
    const { channel_id: _omit, ...noChannel } = wire();
    expect(
      mapDetail({ ...noChannel, evidence: [], evidence_withheld: "NSFW_ACKNOWLEDGEMENT_REQUIRED" })
        .evidence,
    ).toEqual({ kind: "unavailable" });
  });

  it("withholds returned evidence when this client holds no consent for its channel", () => {
    // The server answered before consent was withdrawn here: the answer is stale.
    setNsfwAcknowledged(SPICY, false);
    const d = mapDetail(wire({ channel_id: SPICY }));
    expect(d.evidence).toEqual({ kind: "consent", channelId: SPICY });
    expect(JSON.stringify(d)).not.toContain("reported <img");
  });
});

describe("buildReportDetail", () => {
  it("shows the report and its snapshot as text, with nothing loaded", () => {
    const mountGate = vi.fn();
    const view = buildReportDetail(item, mapDetail(wire()), mountGate);
    const el = view.element;
    expect(el.getAttribute("aria-labelledby")).toBe(view.heading.id);
    expect(view.heading.textContent).toBe("Message reported for Harassment");
    expect([...el.querySelectorAll("dt")].map((d) => d.textContent)).toEqual([
      "About",
      "Reported by",
      "Status",
      "Assigned to",
      "Sent",
    ]);
    expect([...el.querySelectorAll("dd")].slice(0, 4).map((d) => d.textContent)).toEqual([
      "alice",
      "bob",
      "Waiting for review",
      "No one",
    ]);
    expect(el.textContent).toContain("synthetic reporter detail");

    const rows = [...el.querySelectorAll(".mod-evidence-item")];
    expect(rows.map((r) => r.querySelector(".mod-evidence-author")?.textContent)).toEqual([
      "carol",
      "alice",
      "alice",
    ]);
    expect(rows[0]!.textContent).toContain("No text");
    expect(rows[1]!.classList.contains("mod-evidence-reported")).toBe(true);
    expect(rows[1]!.textContent).toContain("Reported message");
    expect(rows[1]!.querySelector(".mod-evidence-text")?.textContent).toBe(
      "reported <img src=x onerror=alert(1)> https://example.invalid/pixel.png",
    );
    expect(rows[1]!.querySelector(".mod-evidence-files")?.textContent).toBe(
      "notes.txt (text/plain, 2.0 KB)",
    );
    expect(el.textContent).toContain("Attachments are kept by reference only.");
    // Inert: no element that can fetch or navigate.
    expect(el.querySelectorAll("img, a, iframe, video, audio, object, embed")).toHaveLength(0);
    expect(mountGate).not.toHaveBeenCalled();
  });

  it("puts the consent gate where withheld evidence would be", () => {
    const mountGate = vi.fn();
    const detail = mapDetail(
      wire({ channel_id: SPICY, evidence: [], evidence_withheld: "NSFW_ACKNOWLEDGEMENT_REQUIRED" }),
    );
    const view = buildReportDetail(item, detail, mountGate);
    expect(mountGate).toHaveBeenCalledWith(expect.any(HTMLElement), SPICY, "spicy");
    expect(view.element.querySelector(".mod-evidence-item")).toBeNull();
    expect(view.element.textContent).toContain("age-restricted channel");
  });

  it("says why evidence is missing rather than looking empty", () => {
    const none = buildReportDetail(item, mapDetail(wire({ evidence: [] })), vi.fn());
    expect(none.element.textContent).toContain("No messages were captured with this report.");
    const gone = buildReportDetail(
      item,
      mapDetail(wire({ evidence: [], evidence_withheld: "SOURCE_CHANNEL_UNAVAILABLE" })),
      vi.fn(),
    );
    expect(gone.element.textContent).toContain("can no longer be checked");
  });

  it("names an unknown or erased account as unknown", () => {
    const erased = mapQueueRow({
      id: "c3",
      reporter_name: "",
      subject_name: "",
      target_type: "user",
      target_ref: "5",
      reason: "spam",
      state: "assigned",
      assignee_id: 99,
      outcome: "",
      created_at: "",
      updated_at: "",
    });
    const view = buildReportDetail(
      erased,
      mapDetail(wire({ assignee_id: 99, created_at: "", evidence: [] })),
      vi.fn(),
    );
    expect([...view.element.querySelectorAll("dd")].map((d) => d.textContent)).toEqual([
      "Unknown account",
      "Unknown account",
      "Waiting for review",
      "Unknown account",
      "date unavailable",
    ]);
  });
});

describe("dateText", () => {
  it("reads a missing, empty or unreadable time as unavailable", () => {
    expect(dateText(null)).toBe("date unavailable");
    expect(dateText("")).toBe("date unavailable");
    expect(dateText("not a time")).toBe("date unavailable");
  });

  it("formats a readable time", () => {
    const text = dateText("2026-09-05T10:00:00Z");
    expect(text).not.toBe("date unavailable");
    expect(text).toMatch(/2026/);
  });
});

const sectionOf = (over: Partial<ModerationReportDetail> = {}, gate = vi.fn()): HTMLElement =>
  buildReportDetail(item, mapDetail(wire(over)), gate).element;

const plainRow = (seq: number, over: Record<string, unknown> = {}) => ({
  seq,
  author_id: 2,
  content: `row ${seq}`,
  attachments: "[]",
  captured_at: "2026-09-05T10:00:00Z",
  ...over,
});

const reportNumber = (id: string): number => Number(id.replace("mod-report-", ""));

const statusLines = (el: HTMLElement): string[] =>
  [...el.querySelectorAll("p.mod-evidence-status")].map((p) => p.textContent ?? "");

const factLabels = (el: HTMLElement): string[] =>
  [...el.querySelectorAll("dt")].map((d) => d.textContent ?? "");

describe("buildReportDetail markup", () => {
  it("numbers each heading apart and labels the section by it", () => {
    const first = buildReportDetail(item, mapDetail(wire()), vi.fn());
    const second = buildReportDetail(item, mapDetail(wire()), vi.fn());
    expect(first.heading.id).toMatch(/^mod-report-\d+$/);
    expect(reportNumber(first.heading.id)).toBeGreaterThanOrEqual(1);
    expect(reportNumber(second.heading.id)).toBe(reportNumber(first.heading.id) + 1);
    expect(first.heading.tabIndex).toBe(-1);
    expect(first.element.className).toBe("mod-report");
    expect(first.element.dataset["testid"]).toBe("mod-report");
  });

  it("marks only the reported message, and only it gets the marker", () => {
    const el = sectionOf({ evidence: [plainRow(-1), plainRow(0), plainRow(1)] });
    const rows = [...el.querySelectorAll(".mod-evidence-item")];
    expect(rows.map((r) => r.classList.contains("mod-evidence-reported"))).toEqual([
      false,
      true,
      false,
    ]);
    expect(rows.map((r) => r.querySelectorAll(".mod-evidence-marker").length)).toEqual([0, 1, 0]);
    expect(rows[1]!.querySelector(".mod-evidence-head > .mod-evidence-marker")?.textContent).toBe(
      "Reported message",
    );
    expect(rows[1]!.querySelector(".mod-evidence-head > .mod-evidence-author")).not.toBeNull();
  });

  it("styles a message without text as empty and one with text as plain", () => {
    const el = sectionOf({ evidence: [plainRow(0, { content: "" }), plainRow(1)] });
    const texts = [...el.querySelectorAll("p.mod-evidence-text")];
    expect(texts.map((p) => p.className)).toEqual([
      "mod-evidence-text mod-evidence-empty",
      "mod-evidence-text",
    ]);
    expect(texts.map((p) => p.textContent)).toEqual(["No text", "row 1"]);
  });

  it("lists attachments only for rows that carry some, with an unknown type spelled out", () => {
    const files = JSON.stringify([
      { filename: "a.bin", mime: "", size: 1024 },
      { filename: "b.png", mime: "image/png", size: 1536 },
    ]);
    const el = sectionOf({ evidence: [plainRow(0, { attachments: files }), plainRow(1)] });
    const rows = [...el.querySelectorAll(".mod-evidence-item")];
    expect(rows[1]!.querySelector(".mod-evidence-files")).toBeNull();
    expect(
      [...rows[0]!.querySelectorAll(".mod-evidence-files > li")].map((li) => li.textContent),
    ).toEqual(["a.bin (Unknown account, 1.0 KB)", "b.png (image/png, 1.5 KB)"]);
  });

  it("notes that attachments are by reference only when some row has one", () => {
    const withFile = JSON.stringify([{ filename: "a.txt", mime: "text/plain", size: 1 }]);
    const none = sectionOf({ evidence: [plainRow(0), plainRow(1)] });
    expect(none.textContent).not.toContain("Attachments are kept by reference only.");
    const some = sectionOf({ evidence: [plainRow(0), plainRow(1, { attachments: withFile })] });
    const notes = [...some.querySelectorAll("p.mod-evidence-status")].filter((p) =>
      (p.textContent ?? "").includes("Attachments are kept by reference only."),
    );
    expect(notes).toHaveLength(1);
  });

  it("introduces the snapshot with when it was captured, above an ordered list", () => {
    const el = sectionOf({ evidence: [plainRow(0)] });
    const captured = el.querySelector("p.mod-evidence-status")!;
    expect(captured.textContent).toContain(dateText("2026-09-05T10:00:00Z"));
    const list = el.querySelector("ol.mod-evidence")!;
    expect(list.querySelectorAll(":scope > li.mod-evidence-item")).toHaveLength(1);
    expect(el.querySelector("h4:last-of-type")).not.toBeNull();
  });

  it("says in a status line why evidence is missing", () => {
    expect(statusLines(sectionOf({ evidence: [] }))).toEqual([
      "No messages were captured with this report.",
    ]);
    expect(
      statusLines(sectionOf({ evidence: [], evidence_withheld: "SOURCE_CHANNEL_UNAVAILABLE" })),
    ).toEqual([expect.stringContaining("can no longer be checked")]);
  });

  it("hands the consent gate its own slot beneath a status line", () => {
    const gate = vi.fn();
    const el = sectionOf(
      { channel_id: SPICY, evidence: [], evidence_withheld: "NSFW_ACKNOWLEDGEMENT_REQUIRED" },
      gate,
    );
    const slot = gate.mock.calls[0]![0] as HTMLElement;
    expect(slot.className).toBe("mod-evidence-gate");
    expect(el.contains(slot)).toBe(true);
    expect(slot.previousElementSibling?.className).toBe("mod-evidence-status");
    expect(slot.previousElementSibling?.textContent).toContain("age-restricted channel");
  });

  it("shows the reporter's own words only when there are some", () => {
    const quiet = sectionOf({ detail: "" });
    expect(quiet.querySelector(".mod-report-note")).toBeNull();
    expect(quiet.textContent).not.toContain("Reporter's details");
    const loud = sectionOf({ detail: "they keep following me" });
    expect(loud.querySelector("p.mod-report-note")?.textContent).toBe("they keep following me");
    expect([...loud.querySelectorAll("h4")].map((h) => h.textContent)).toEqual([
      "Reporter's details",
      "Evidence",
    ]);
  });

  it("lists when a report was closed only once it is", () => {
    expect(factLabels(sectionOf())).not.toContain("Closed");
    const closed = sectionOf({
      state: "closed",
      outcome: "actioned",
      closed_at: "2026-09-06T10:00:00Z",
    });
    expect(factLabels(closed)).toEqual([
      "About",
      "Reported by",
      "Status",
      "Assigned to",
      "Sent",
      "Closed",
    ]);
    expect([...closed.querySelectorAll("dd")].pop()?.textContent).toBe(
      dateText("2026-09-06T10:00:00Z"),
    );
  });
});
