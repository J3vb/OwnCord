// B9-11: the moderation adapter and the evidence renderer. Evidence is only
// ever what the server returned, narrowed (never widened) by this client's
// NSFW consent, and rendered as inert text.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModerationReportDetail } from "@lib/api";
import type { ReadyChannel } from "@lib/types";
import { resetChannelsStore, setChannels, setNsfwAcknowledged } from "@stores/channels.store";
import { setMembers } from "@stores/members.store";
import { mapDetail, mapQueueRow, parseAttachments, type QueueItem } from "./api";
import { buildReportDetail } from "./Evidence";

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
