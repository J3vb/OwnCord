// B9-12: a report's internal notes and its immutable history, built from the
// server's detail. Both are read-only text; absent facts are said, not hidden.
import { describe, expect, it } from "vitest";
import type { HistoryEntry, ReportDetail } from "./api";
import { dateText } from "./Evidence";
import { buildHistory, muted } from "./History";

const ME = 5;
const AT = "2026-09-20 10:00:00";
const LATER = "2026-09-21 12:30:00";

function report(over: Partial<ReportDetail> = {}): ReportDetail {
  return {
    id: "r1",
    reporterId: 3,
    subjectId: 4,
    targetType: "message",
    channelId: 1,
    detail: "",
    state: "open",
    outcome: "",
    assigneeId: 0,
    createdAt: AT,
    closedAt: null,
    evidence: { kind: "unavailable" },
    notes: [],
    history: [],
    ...over,
  };
}

function event(action: string, detail = ""): HistoryEntry {
  return { kind: "event", action, detail, actorId: 0, at: AT };
}

function actionEntry(over: Partial<Extract<HistoryEntry, { kind: "action" }>> = {}): HistoryEntry {
  return {
    kind: "action",
    action: "warning",
    reason: "",
    actorId: ME,
    at: AT,
    expiresAt: null,
    liftedAt: null,
    ...over,
  };
}

const attrs = (el: Element): Record<string, string> =>
  Object.fromEntries(el.getAttributeNames().map((n) => [n, el.getAttribute(n) ?? ""]));

/** The notes section's explanatory line, or null when notes are listed. */
function notesLine(detail: ReportDetail): string | null {
  const [heading, body] = buildHistory(detail, ME);
  expect(heading!.textContent).toBe("Internal notes");
  return body!.tagName === "P" ? body!.textContent : null;
}

function itemOf(entry: HistoryEntry): HTMLElement {
  const items = buildHistory(report({ history: [entry] }), ME).at(-1)!;
  return items.querySelector<HTMLElement>("li")!;
}

describe("muted", () => {
  it("is a paragraph in the muted style", () => {
    const p = muted("hello");
    expect(p.tagName).toBe("P");
    expect(attrs(p)).toEqual({ class: "mod-evidence-status" });
    expect(p.textContent).toBe("hello");
  });
});

describe("history entries", () => {
  it("lists each step with who did what and when", () => {
    const [, , , , list] = [
      ...buildHistory(report({ history: [event("created", "spam"), event("assigned")] }), ME),
    ];
    expect(attrs(list!)).toEqual({ class: "mod-history", "data-testid": "mod-history" });
    const items = [...list!.querySelectorAll("li")];
    expect(items.map((li) => attrs(li))).toEqual([
      { class: "mod-history-item" },
      { class: "mod-history-item" },
    ]);
    const parts = [...items[0]!.children];
    expect(parts.map((p) => attrs(p))).toEqual([
      { class: "mod-history-what" },
      { class: "mod-history-when" },
    ]);
    expect(parts[1]!.textContent).toBe(dateText(AT));
  });

  it("says when nothing was recorded, in the muted style", () => {
    const last = buildHistory(report(), ME).at(-1)!;
    expect(last.tagName).toBe("P");
    expect(attrs(last)).toEqual({ class: "mod-evidence-status" });
    expect(last.textContent).toBe("No history recorded.");
  });

  it("shows the reason given to the member only when there is one", () => {
    expect(itemOf(actionEntry({ reason: "" })).querySelector(".mod-history-reason")).toBeNull();
    const reason = itemOf(actionEntry({ reason: "flooding" })).querySelector(
      ".mod-history-reason",
    )!;
    expect(reason.tagName).toBe("P");
    expect(reason.textContent).toBe("Reason shown to the member: flooding");
  });

  it.each([
    ["no end and not lifted", null, null, []],
    ["an end that has not been lifted", LATER, null, ["Until " + dateText(LATER)]],
    ["lifted before its end", LATER, AT, ["Lifted " + dateText(AT)]],
    ["lifted with no end", null, AT, ["Lifted " + dateText(AT)]],
  ])("dates an action with %s", (_name, expiresAt, liftedAt, expected) => {
    const li = itemOf(actionEntry({ action: "timeout", expiresAt, liftedAt }));
    const extra = [...li.children].slice(2).filter((c) => c.tagName === "SPAN");
    expect(extra.map((c) => c.textContent)).toEqual(expected);
    expect(extra.map((c) => attrs(c))).toEqual(expected.map(() => ({ class: "mod-history-when" })));
  });

  it("adds nothing beyond what and when for a report event", () => {
    const li = itemOf(event("assigned"));
    expect([...li.children]).toHaveLength(2);
  });
});

describe("internal notes", () => {
  it("lists each note with its author and date, in order", () => {
    const [, list] = buildHistory(
      report({
        notes: [
          { authorId: ME, body: "first", createdAt: AT },
          { authorId: 0, body: "second", createdAt: LATER },
        ],
      }),
      ME,
    );
    expect(list!.tagName).toBe("OL");
    expect(attrs(list!)).toEqual({ class: "mod-notes" });
    const notes = [...list!.querySelectorAll("li")];
    expect(notes.map((li) => attrs(li))).toEqual([{ class: "mod-note" }, { class: "mod-note" }]);
    const first = [...notes[0]!.children];
    expect(attrs(first[0]!)).toEqual({ class: "mod-history-when" });
    expect(first[0]!.textContent).toBe(`You, ${dateText(AT)}`);
    expect(attrs(first[1]!)).toEqual({ class: "mod-note-body" });
    expect(first[1]!.textContent).toBe("first");
    expect(notes[1]!.textContent).toContain("second");
  });

  it("hides the notes from the reporter", () => {
    expect(
      notesLine(report({ reporterId: ME, notes: [{ authorId: 9, body: "x", createdAt: AT }] })),
    ).toBe("Internal notes are hidden from you because you sent this report.");
  });

  it("says there are none when no note was ever added", () => {
    expect(notesLine(report({ closedAt: LATER, history: [event("created")] }))).toBe(
      "No notes yet.",
    );
  });

  it("says there are none yet while a report with a note event is still open", () => {
    expect(notesLine(report({ history: [event("created"), event("noted")] }))).toBe(
      "No notes yet.",
    );
  });

  it("does not take another kind of entry for an added note", () => {
    expect(
      notesLine(
        report({ closedAt: LATER, history: [event("assigned"), actionEntry({ action: "noted" })] }),
      ),
    ).toBe("No notes yet.");
  });

  it("explains that note text was removed once a closed report had notes added", () => {
    const history = [event("created"), event("assigned"), event("noted")];
    expect(notesLine(report({ closedAt: LATER, state: "closed", history }))).toContain(
      "Note text is no longer kept",
    );
    expect(notesLine(report({ closedAt: LATER, state: "subject_erased", history }))).toBe(
      "Note text was deleted along with the reported account.",
    );
  });
});
