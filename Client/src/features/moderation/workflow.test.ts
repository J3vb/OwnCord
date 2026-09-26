// B9-12: taking, noting and closing a report, and its immutable history. The
// server authorizes every write; the view offers only what this reader may do,
// sends one write at a time, reconciles every answer with a fresh read and
// drops the unsaved note once the report can't take it or authority is gone.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiClientError,
  type ApiClient,
  type ModerationQueueRow,
  type ModerationReportDetail,
} from "@lib/api";
import { authStore } from "@stores/auth.store";
import { setMembers } from "@stores/members.store";
import type { FeatureViewContext } from "../navigation/destinations";
import { renderModerationCenter } from "./Queue";
import { noteQueueChange } from "./store";

const ME = 7;
const OTHER = 8;

interface Call<T> {
  readonly arg: string;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

let lists: Call<ModerationQueueRow[]>[];
let details: Call<ModerationReportDetail>[];
let writes: (Call<void> & { readonly op: string; readonly body: unknown })[];
let view: AbortController;

function deferred<T>(bucket: Call<T>[], arg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => bucket.push({ arg, resolve, reject }));
}

function writeCall(op: string, id: string, body: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    writes.push({ op, arg: id, body, resolve, reject }),
  );
}

const api = {
  getModerationQueue: (state: string) => deferred(lists, state),
  getModerationReport: (id: string) => deferred(details, id),
  assignModerationReport: (id: string) => writeCall("assign", id, undefined),
  addModerationNote: (id: string, body: string) => writeCall("note", id, body),
  closeModerationReport: (id: string, outcome: string) => writeCall("close", id, outcome),
} as unknown as ApiClient;

const flush = () => new Promise((r) => setTimeout(r, 0));

function row(id: string, over: Partial<ModerationQueueRow> = {}): ModerationQueueRow {
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

function detail(id: string, over: Partial<ModerationReportDetail> = {}): ModerationReportDetail {
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
    events: [{ actor_id: 0, action: "created", detail: "spam", created_at: "2026-09-05 10:00:00" }],
    actions: [],
    ...over,
  };
}

const mine = (id: string, over: Partial<ModerationReportDetail> = {}) =>
  detail(id, { state: "assigned", assignee_id: ME, ...over });

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const ctx: FeatureViewContext = { signal: view.signal, close: () => {}, api };
  renderModerationCenter(root, ctx);
  return root;
}

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const work = (root: HTMLElement) => q<HTMLElement>(root, "[data-testid=mod-work]");
const buttons = (el: Element | null) =>
  [...(el?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
const note = (root: HTMLElement) => q<HTMLTextAreaElement>(root, "[data-testid=mod-note-input]");
const writeStatus = (root: HTMLElement) =>
  q<HTMLElement>(root, "[data-testid=mod-write-status]")!.textContent;
const alerts = (root: HTMLElement) =>
  [...root.querySelectorAll("[role=alert]")]
    .map((a) => a.textContent)
    .filter(Boolean)
    .join("|");
const history = (root: HTMLElement) =>
  [...root.querySelectorAll(".mod-history-what")].map((span) => span.textContent);

/** A queue with one report, opened and answered with `d`. */
async function opened(d: ModerationReportDetail, r = row(d.id)): Promise<HTMLElement> {
  const root = mount();
  lists.at(-1)!.resolve([r]);
  await flush();
  q<HTMLButtonElement>(root, ".mod-queue-row")!.click();
  details.at(-1)!.resolve(d);
  await flush();
  return root;
}

/** The re-read that follows a write: the queue, then the report. */
async function reread(d: ModerationReportDetail | null, r?: ModerationQueueRow): Promise<void> {
  lists.at(-1)!.resolve(d === null ? [] : [r ?? row(d.id, { state: d.state })]);
  await flush();
  if (d !== null) {
    details.at(-1)!.resolve(d);
    await flush();
  }
}

function type(root: HTMLElement, text: string): void {
  const input = note(root)!;
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input"));
}

function submit(el: Element | null): void {
  el!.closest("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
}

beforeEach(() => {
  lists = [];
  details = [];
  writes = [];
  view = new AbortController();
  authStore.setState((prev) => ({
    ...prev,
    token: "tok",
    user: { id: ME, username: "bob", avatar: null, role: "moderator" },
    isAuthenticated: true,
  }));
  setMembers([
    { id: ME, username: "bob", avatar: null, role: "moderator", status: "online" },
    { id: OTHER, username: "dave", avatar: null, role: "moderator", status: "online" },
  ]);
});

afterEach(() => {
  view.abort();
  document.body.replaceChildren();
});

describe("what the review offers", () => {
  it("offers only taking an unassigned report, and sends it once", async () => {
    const root = await opened(detail("r1"));
    expect(buttons(work(root))).toEqual(["Take this report"]);
    expect(note(root)).toBeNull();

    const take = q<HTMLButtonElement>(work(root)!, "button")!;
    take.focus();
    take.click();
    take.click();
    expect(writes.map((w) => [w.op, w.arg])).toEqual([["assign", "r1"]]);
    expect(take.getAttribute("aria-disabled")).toBe("true");

    writes[0]!.resolve();
    await flush();
    expect(writeStatus(root)).toBe("You're now reviewing this report.");
    await reread(mine("r1"), row("r1", { state: "assigned", assignee_id: ME }));
    expect(buttons(work(root))).toEqual(["Add note", "Close report"]);
    // The button it was on is gone: focus lands on the report, not <body>.
    expect(document.activeElement?.tagName).toBe("H3");
  });

  it("sends one write at a time, even when a re-read rebuilds the controls", async () => {
    const root = await opened(detail("r1"));
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    noteQueueChange();
    await flush();
    await reread(detail("r1"));
    const again = q<HTMLButtonElement>(work(root)!, "button")!;
    expect(again.textContent).toBe("Take this report");
    again.click();
    expect(writes).toHaveLength(1);
  });

  it("sends no second take while the report is read again after the first", async () => {
    const root = await opened(detail("r1"));
    const take = q<HTMLButtonElement>(work(root)!, "button")!;
    take.click();
    writes[0]!.resolve();
    await flush();
    take.click();
    expect(writes).toHaveLength(1);
    await reread(mine("r1"), row("r1", { state: "assigned", assignee_id: ME }));
    type(root, "after the take");
    submit(note(root));
    expect(writes.map((w) => w.op)).toEqual(["assign", "note"]);
  });

  it("sends a saved note once, even before the re-read replaces the field", async () => {
    const root = await opened(mine("r1"));
    type(root, "only once");
    submit(note(root));
    writes[0]!.resolve();
    await flush();
    submit(note(root));
    expect(writes).toHaveLength(1);
  });

  it("lets the next write through once a failed re-read is retried", async () => {
    const root = await opened(mine("r1"));
    type(root, "one");
    submit(note(root));
    writes[0]!.resolve();
    await flush();
    lists.at(-1)!.resolve([row("r1", { state: "assigned", assignee_id: ME })]);
    details.at(-1)!.reject(new Error("offline"));
    await flush();
    expect(alerts(root)).toBe("Couldn't load this report.");
    [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Try again" && !b.hidden)!
      .click();
    details.at(-1)!.resolve(mine("r1"));
    await flush();
    type(root, "two");
    submit(note(root));
    expect(writes.map((w) => w.body)).toEqual(["one", "two"]);
  });

  it("reads the report again after a write even when the queue read fails", async () => {
    const root = await opened(detail("r1"));
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    writes[0]!.resolve();
    await flush();
    lists.at(-1)!.reject(new Error("offline"));
    await flush();
    expect(details).toHaveLength(2);
    details.at(-1)!.resolve(mine("r1"));
    await flush();
    expect(buttons(work(root))).toEqual(["Add note", "Close report"]);
  });

  it("leaves another report's controls available when its click waits on a write", async () => {
    const root = mount();
    lists[0]!.resolve([row("r1"), row("r2")]);
    await flush();
    const rows = [...root.querySelectorAll<HTMLButtonElement>(".mod-queue-row")];
    rows[0]!.click();
    details.at(-1)!.resolve(detail("r1"));
    await flush();
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    rows[1]!.click();
    details.at(-1)!.resolve(detail("r2"));
    await flush();
    const take = q<HTMLButtonElement>(work(root)!, "button")!;
    take.click();
    expect(writes.map((w) => w.arg)).toEqual(["r1"]);
    expect(take.getAttribute("aria-disabled")).toBeNull();
  });

  it("offers nothing on a report someone else is reviewing", async () => {
    const root = await opened(detail("r1", { state: "assigned", assignee_id: OTHER }));
    expect(buttons(work(root))).toEqual([]);
    expect(work(root)!.textContent).toContain("Another moderator is reviewing this report.");
  });

  it("offers nothing to the moderator who sent the report, and says why", async () => {
    const root = await opened(detail("r1", { reporter_id: ME }));
    expect(buttons(work(root))).toEqual([]);
    expect(work(root)!.textContent).toContain("You sent this report");
    expect(root.textContent).toContain(
      "Internal notes are hidden from you because you sent this report.",
    );
  });

  it("offers nothing on a closed report: no reopen, no edit", async () => {
    const root = await opened(
      detail("r1", { state: "resolved", outcome: "actioned", closed_at: "2026-09-06 09:00:00" }),
    );
    expect(buttons(work(root))).toEqual([]);
    expect(
      root.querySelectorAll("[data-testid=mod-report] textarea, [data-testid=mod-report] input"),
    ).toHaveLength(0);
    expect(work(root)!.textContent).toContain("can't be reopened");
  });
});

describe("notes", () => {
  it("refuses an empty note locally and sends line breaks as spaces", async () => {
    const root = await opened(mine("r1"));
    type(root, "   ");
    submit(note(root));
    expect(writes).toHaveLength(0);
    expect(alerts(root)).toBe("Write a note first.");
    expect(note(root)!.getAttribute("aria-invalid")).toBe("true");

    type(root, "first line\nsecond\tline ");
    expect(alerts(root)).toBe("");
    submit(note(root));
    submit(note(root));
    expect(writes.map((w) => [w.op, w.body])).toEqual([["note", "first line second line"]]);

    writes[0]!.resolve();
    await flush();
    expect(writeStatus(root)).toBe("Note added.");
    await reread(
      mine("r1", {
        notes: [
          {
            id: 1,
            author_id: ME,
            body: "first line second line",
            created_at: "2026-09-05 11:00:00",
          },
        ],
      }),
    );
    expect(note(root)!.value).toBe("");
    expect(root.querySelector(".mod-note-body")?.textContent).toBe("first line second line");
    expect(root.querySelector(".mod-note")?.textContent).toContain("You, Sep 5, 2026");
  });

  it("keeps the draft, focus and caret through a background re-read", async () => {
    const root = await opened(mine("r1"));
    type(root, "half a thought");
    note(root)!.setSelectionRange(4, 4);
    await (async () => {
      noteQueueChange();
      await flush();
    })();
    await reread(mine("r1"), row("r1", { state: "assigned", assignee_id: ME }));
    expect(note(root)!.value).toBe("half a thought");
    expect(document.activeElement).toBe(note(root));
    expect(note(root)!.selectionStart).toBe(4);
  });

  it("keeps the chosen outcome through a background re-read", async () => {
    const root = await opened(mine("r1"));
    const chosen = q<HTMLInputElement>(root, "input[value=no_action]")!;
    chosen.checked = true;
    chosen.dispatchEvent(new Event("change"));
    noteQueueChange();
    await flush();
    await reread(mine("r1"), row("r1", { state: "assigned", assignee_id: ME }));
    expect(q<HTMLInputElement>(root, "input[value=no_action]")!.checked).toBe(true);
    submit(q(root, "input[value=no_action]"));
    expect(writes.map((w) => [w.op, w.body])).toEqual([["close", "no_action"]]);
  });

  it("discards the draft, and says so, when the report stops taking notes", async () => {
    const root = await opened(mine("r1"));
    type(root, "unsaved");
    noteQueueChange();
    await flush();
    await reread(detail("r1", { state: "assigned", assignee_id: OTHER }));
    expect(note(root)).toBeNull();
    expect(alerts(root)).toBe(
      "This report can no longer take your note, so the unsaved note was discarded.",
    );
  });

  it("does not carry a draft to another report", async () => {
    const root = mount();
    lists[0]!.resolve([row("r1"), row("r2")]);
    await flush();
    const rows = [...root.querySelectorAll<HTMLButtonElement>(".mod-queue-row")];
    rows[0]!.click();
    details.at(-1)!.resolve(mine("r1"));
    await flush();
    type(root, "for r1 only");
    rows[1]!.click();
    details.at(-1)!.resolve(mine("r2"));
    await flush();
    expect(note(root)!.value).toBe("");
    // Nor back: leaving a report drops its unsaved note.
    rows[0]!.click();
    details.at(-1)!.resolve(mine("r1"));
    await flush();
    expect(note(root)!.value).toBe("");
  });
});

describe("conflicts and refusals", () => {
  it("shows another moderator's claim after a 409 instead of guessing", async () => {
    const root = await opened(detail("r1"));
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    writes[0]!.reject(new ApiClientError(409, "CONFLICT", "already assigned"));
    await flush();
    expect(alerts(root)).toBe("Another moderator took this report first.");
    expect(details).toHaveLength(2);
    await reread(detail("r1", { state: "assigned", assignee_id: OTHER }));
    expect(details).toHaveLength(2);
    expect(buttons(work(root))).toEqual([]);
    expect(root.querySelector(".mod-report-facts")?.textContent).toContain("dave");
  });

  it("says a racing close won, and the report leaves the list", async () => {
    const root = await opened(mine("r1"));
    q<HTMLInputElement>(root, "input[value=no_action]")!.checked = true;
    submit(q(root, "input[value=no_action]"));
    writes[0]!.reject(new ApiClientError(409, "CONFLICT", "report is already closed"));
    await flush();
    expect(alerts(root)).toContain("This report was already closed by another moderator.");
    await reread(null);
    expect(root.querySelector("[data-testid=mod-report]")).toBeNull();
  });

  it("keeps the note when the save fails, for another try", async () => {
    const root = await opened(mine("r1"));
    type(root, "keep me");
    submit(note(root));
    writes[0]!.reject(new Error("offline"));
    await flush();
    expect(alerts(root)).toBe("Couldn't save this change. Try again.");
    await reread(mine("r1"), row("r1", { state: "assigned", assignee_id: ME }));
    expect(note(root)!.value).toBe("keep me");
    expect(q(work(root)!, "button")?.getAttribute("aria-disabled")).toBeNull();
  });

  it("answers a self-review refusal without taking the view away", async () => {
    const root = await opened(detail("r1"));
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    writes[0]!.reject(new ApiClientError(403, "SELF_REVIEW", "cannot act on your own report"));
    await flush();
    expect(alerts(root)).toBe("You sent this report, so you can't review it.");
    expect(root.querySelectorAll(".mod-queue-row")).toHaveLength(1);
  });

  it("drops the draft and every report when a demoted moderator writes", async () => {
    const root = await opened(
      mine("r1", { notes: [{ id: 1, author_id: OTHER, body: "private", created_at: "" }] }),
    );
    type(root, "secret draft");
    submit(note(root));
    writes[0]!.reject(new ApiClientError(403, "FORBIDDEN", "missing MODERATE_MEMBERS permission"));
    await flush();
    expect(alerts(root)).toBe("You no longer have permission to moderate on this server.");
    expect(root.textContent).not.toContain("private");
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelectorAll(".mod-queue-row")).toHaveLength(0);
    // Nothing is sent or read after the refusal.
    noteQueueChange();
    await flush();
    expect(lists).toHaveLength(1);
  });

  it("closes a report deleted while a note was being written", async () => {
    const root = await opened(mine("r1"));
    type(root, "too late");
    submit(note(root));
    writes[0]!.reject(new ApiClientError(404, "NOT_FOUND", "report not found"));
    await flush();
    expect(root.querySelector("[data-testid=mod-report]")).toBeNull();
    expect(root.textContent).toContain("This report is no longer available.");
    expect(lists).toHaveLength(2);
    // The draft went with it.
    lists[1]!.resolve([row("r1", { state: "assigned", assignee_id: ME })]);
    await flush();
    q<HTMLButtonElement>(root, ".mod-queue-row")!.click();
    details.at(-1)!.resolve(mine("r1"));
    await flush();
    expect(note(root)!.value).toBe("");
  });

  it("ignores a write answer after the view is gone", async () => {
    const root = await opened(detail("r1"));
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    view.abort();
    writes[0]!.resolve();
    await flush();
    expect(root.childElementCount).toBe(0);
    expect(lists).toHaveLength(1);
  });
});

describe("closing", () => {
  it("asks for an outcome, then closes without a 'gone' message", async () => {
    const root = await opened(mine("r1"));
    const legend = root.querySelector("legend")?.textContent;
    expect(legend).toBe("Outcome");
    const radios = [...root.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    expect(radios.map((r) => [r.value, r.checked, r.labels?.[0]?.textContent])).toEqual([
      ["actioned", false, "Action taken"],
      ["no_action", false, "No action needed"],
      ["duplicate", false, "Already reported"],
    ]);
    const close = [...work(root)!.querySelectorAll("button")].find(
      (b) => b.textContent === "Close report",
    )!;
    expect(document.getElementById(close.getAttribute("aria-describedby")!)?.textContent).toContain(
      "can't be reopened",
    );
    submit(close);
    expect(writes).toHaveLength(0);
    expect(alerts(root)).toBe("Choose an outcome first.");
    expect(document.activeElement).toBe(radios[0]);

    radios[2]!.checked = true;
    radios[2]!.dispatchEvent(new Event("change"));
    close.focus();
    submit(close);
    expect(writes.map((w) => [w.op, w.body])).toEqual([["close", "duplicate"]]);
    writes[0]!.resolve();
    await flush();
    await reread(null);
    expect(writeStatus(root)).toBe(
      "Report closed. It is listed under Show: Closed, with its history.",
    );
    expect(root.textContent).not.toContain("no longer in this list");
    expect(root.contains(document.activeElement)).toBe(true);
    // The closed report stays open, as the server now reads it.
    details
      .at(-1)!
      .resolve(
        mine("r1", { state: "resolved", outcome: "duplicate", closed_at: "2026-09-06 09:00:00" }),
      );
    await flush();
    expect(root.querySelector(".mod-report-facts")?.textContent).toContain(
      "Closed: already reported",
    );
    expect(buttons(work(root))).toEqual([]);
    expect(root.contains(document.activeElement)).toBe(true);
  });

  it("keeps the report through take, note and close under Waiting for review", async () => {
    const root = mount();
    lists[0]!.resolve([row("r1")]);
    await flush();
    const filter = q<HTMLSelectElement>(root, "[data-testid=mod-filter]")!;
    filter.value = "open";
    filter.dispatchEvent(new Event("change"));
    expect(lists.at(-1)!.arg).toBe("open");
    lists.at(-1)!.resolve([row("r1")]);
    await flush();
    q<HTMLButtonElement>(root, ".mod-queue-row")!.click();
    details.at(-1)!.resolve(detail("r1"));
    await flush();
    const report = () => root.querySelector("[data-testid=mod-report]");
    const moved = "Your change moved this report out of the current filter. It stays open here.";

    // Take: the report is now assigned, so the open filter no longer lists it.
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    writes[0]!.resolve();
    await flush();
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(mine("r1"));
    await flush();
    expect(report()).not.toBeNull();
    expect(root.querySelectorAll(".mod-queue-row")).toHaveLength(0);
    expect(buttons(work(root))).toEqual(["Add note", "Close report"]);
    const said = [...root.querySelectorAll("[role=status]")].find((s) => s.textContent === moved);
    expect(said).toBeDefined();
    expect(alerts(root)).toBe("");

    // The server's mod_queue after the take reads the report again by id.
    noteQueueChange();
    await flush();
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(mine("r1"));
    await flush();
    expect(report()).not.toBeNull();

    type(root, "checked");
    submit(note(root));
    writes[1]!.resolve();
    await flush();
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(
      mine("r1", {
        notes: [{ id: 1, author_id: ME, body: "checked", created_at: "2026-09-05 11:00:00" }],
      }),
    );
    await flush();
    expect(root.querySelector(".mod-note-body")?.textContent).toBe("checked");

    q<HTMLInputElement>(root, "input[value=actioned]")!.checked = true;
    submit(q(root, "input[value=actioned]"));
    expect(writes.map((w) => w.op)).toEqual(["assign", "note", "close"]);
    writes[2]!.resolve();
    await flush();
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(
      mine("r1", {
        state: "resolved",
        outcome: "actioned",
        closed_at: "2026-09-05 12:00:00",
        events: [
          { actor_id: 0, action: "created", detail: "spam", created_at: "2026-09-05 10:00:00" },
          { actor_id: ME, action: "assigned", detail: "", created_at: "2026-09-05 10:30:00" },
          { actor_id: ME, action: "noted", detail: "", created_at: "2026-09-05 11:00:00" },
          {
            actor_id: ME,
            action: "closed",
            detail: "actioned",
            created_at: "2026-09-05 12:00:00",
          },
        ],
      }),
    );
    await flush();
    expect(report()).not.toBeNull();
    expect(history(root)).toEqual([
      "Report sent for Spam",
      "You took the report",
      "You added an internal note",
      "You closed the report: Action taken",
    ]);
    expect(buttons(work(root))).toEqual([]);
    expect(root.textContent).not.toContain("no longer in this list");
  });

  it("keeps the report open when mod_queue's re-read beats the take's 204", async () => {
    const root = mount();
    lists[0]!.resolve([row("r1")]);
    await flush();
    const filter = q<HTMLSelectElement>(root, "[data-testid=mod-filter]")!;
    filter.value = "open";
    filter.dispatchEvent(new Event("change"));
    lists.at(-1)!.resolve([row("r1")]);
    await flush();
    q<HTMLButtonElement>(root, ".mod-queue-row")!.click();
    details.at(-1)!.resolve(detail("r1"));
    await flush();
    const report = () => root.querySelector("[data-testid=mod-report]");

    q<HTMLButtonElement>(work(root)!, "button")!.click();
    // The server broadcasts mod_queue before it answers the POST.
    noteQueueChange();
    await flush();
    lists.at(-1)!.resolve([]);
    await flush();
    expect(report()).not.toBeNull();
    expect(root.textContent).not.toContain("no longer in this list");
    details.at(-1)!.resolve(mine("r1"));
    await flush();

    writes[0]!.resolve();
    await flush();
    expect(writeStatus(root)).toBe("You're now reviewing this report.");
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(mine("r1"));
    await flush();
    expect(report()).not.toBeNull();
    expect(buttons(work(root))).toEqual(["Add note", "Close report"]);
    expect(alerts(root)).toBe("");
  });

  it("closes the report when mod_queue's re-read beats a take that loses with 409", async () => {
    const root = mount();
    lists[0]!.resolve([row("r1")]);
    await flush();
    const filter = q<HTMLSelectElement>(root, "[data-testid=mod-filter]")!;
    filter.value = "open";
    filter.dispatchEvent(new Event("change"));
    lists.at(-1)!.resolve([row("r1")]);
    await flush();
    q<HTMLButtonElement>(root, ".mod-queue-row")!.click();
    details.at(-1)!.resolve(detail("r1"));
    await flush();
    const moved = "Your change moved this report out of the current filter. It stays open here.";

    q<HTMLButtonElement>(work(root)!, "button")!.click();
    // Another moderator's take lands first; its mod_queue arrives before our answer.
    noteQueueChange();
    await flush();
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(detail("r1", { state: "assigned", assignee_id: OTHER }));
    await flush();

    writes[0]!.reject(new ApiClientError(409, "CONFLICT", "already assigned"));
    await flush();
    expect(alerts(root)).toBe("Another moderator took this report first.");
    expect(root.textContent).not.toContain(moved);
    lists.at(-1)!.resolve([]);
    await flush();
    expect(root.querySelector("[data-testid=mod-report]")).toBeNull();
    expect(root.textContent).toContain("The report you had open is no longer in this list.");
    expect(root.textContent).not.toContain(moved);
  });

  it("still closes a report that leaves the filter through someone else's change", async () => {
    const root = mount();
    lists[0]!.resolve([row("r1")]);
    await flush();
    q<HTMLButtonElement>(root, ".mod-queue-row")!.click();
    details.at(-1)!.resolve(mine("r1"));
    await flush();
    type(root, "a note");
    submit(note(root));
    writes[0]!.resolve();
    await flush();
    await reread(mine("r1"), row("r1", { state: "assigned", assignee_id: ME }));
    // Another moderator closes it; the background read no longer lists it.
    noteQueueChange();
    await flush();
    lists.at(-1)!.resolve([]);
    await flush();
    expect(root.querySelector("[data-testid=mod-report]")).toBeNull();
    expect(root.textContent).toContain("The report you had open is no longer in this list.");
  });
});

describe("history", () => {
  it("lists events and actions in time order, with notes kept apart", async () => {
    const root = await opened(
      detail("r1", {
        state: "resolved",
        outcome: "actioned",
        closed_at: "2026-09-06 09:00:00",
        notes: [
          { id: 1, author_id: 0, body: "checked the logs", created_at: "2026-09-05 11:00:00" },
        ],
        events: [
          { actor_id: 0, action: "created", detail: "spam", created_at: "2026-09-05 10:00:00" },
          { actor_id: ME, action: "assigned", detail: "", created_at: "2026-09-05 10:30:00" },
          { actor_id: 0, action: "noted", detail: "", created_at: "2026-09-05 11:00:00" },
          {
            actor_id: OTHER,
            action: "closed",
            detail: "actioned",
            created_at: "2026-09-06 09:00:00",
          },
          { actor_id: OTHER, action: "reopened", detail: "", created_at: "2026-09-06 09:30:00" },
        ],
        actions: [
          {
            id: 4,
            kind: "warning",
            actor_id: OTHER,
            reason: "Please stop.",
            created_at: "2026-09-06 08:00:00",
          },
        ],
      }),
    );
    expect(history(root)).toEqual([
      "Report sent for Spam",
      "You took the report",
      "A deleted account added an internal note",
      "dave issued: Warning",
      "dave closed the report: Action taken",
      "dave updated the report",
    ]);
    expect(root.querySelector(".mod-history .mod-history-when")?.textContent).toBe(
      "Sep 5, 2026, 10:00 AM",
    );
    // A moderator action's reason is the member-visible one, labelled as such.
    expect(root.querySelector(".mod-history-reason")?.textContent).toBe(
      "Reason shown to the member: Please stop.",
    );
    // Notes are a separate section; the history never repeats their text.
    expect(root.querySelector("[data-testid=mod-history]")?.textContent).not.toContain(
      "checked the logs",
    );
    expect(root.querySelector(".mod-note")?.textContent).toContain("A deleted account");
    // Read-only: nothing inside the notes or history can be activated.
    expect(root.querySelectorAll(".mod-history button, .mod-notes button")).toHaveLength(0);
  });

  it("says when retention removed the note text", async () => {
    const root = await opened(
      detail("r1", {
        state: "dismissed",
        outcome: "no_action",
        closed_at: "2026-06-01 09:00:00",
        events: [{ actor_id: ME, action: "noted", detail: "", created_at: "2026-05-30 09:00:00" }],
      }),
    );
    expect(root.textContent).toContain("Note text is no longer kept");
    expect(root.textContent).not.toContain("No notes yet.");
  });

  it("does not blame retention alone when an erasure could have removed the notes", async () => {
    // Erasing the subject of a closed report deletes its notes and keeps its state.
    const root = await opened(
      detail("r1", {
        state: "resolved",
        outcome: "actioned",
        closed_at: "2026-06-01 09:00:00",
        events: [{ actor_id: ME, action: "noted", detail: "", created_at: "2026-05-30 09:00:00" }],
      }),
    );
    expect(root.textContent).toContain(
      "this server removes it some time after a report closes, or when the reported account is deleted.",
    );
  });

  it("says the note text went with the erased account, not retention", async () => {
    const root = await opened(
      detail("r1", {
        state: "subject_erased",
        outcome: "subject_erased",
        closed_at: "2026-06-01 09:00:00",
        events: [{ actor_id: ME, action: "noted", detail: "", created_at: "2026-05-30 09:00:00" }],
      }),
    );
    expect(root.textContent).toContain("Note text was deleted along with the reported account.");
    expect(root.textContent).not.toContain("Note text is no longer kept");
  });
});
