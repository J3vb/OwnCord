// B9-17: reviewing and deciding appeals in the Moderation Center. The server
// authorizes every read and write; the view offers only what this reader may
// do, says nothing is done before the server answers, shows the outcome the
// server recorded, and clears everything when authority is gone.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApiClientError,
  type ApiClient,
  type ModerationAppealDetail,
  type ModerationAppealRow,
  type ModerationQueueRow,
  type ModerationReportDetail,
} from "@lib/api";
import { authStore } from "@stores/auth.store";
import { setMembers } from "@stores/members.store";
import type { FeatureViewContext } from "../navigation/destinations";
import { renderModerationCenter } from "./Queue";
import { noteAppealChange, noteQueueChange } from "./store";

const ME = 7;
const OTHER = 8;
const APPELLANT = 9;

interface Call<T> {
  readonly arg: string;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

let reportLists: Call<ModerationQueueRow[]>[];
let reportDetails: Call<ModerationReportDetail>[];
let lists: Call<ModerationAppealRow[]>[];
let details: Call<ModerationAppealDetail>[];
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
  getModerationQueue: (state: string) => deferred(reportLists, state),
  getModerationReport: (id: string) => deferred(reportDetails, id),
  getModerationAppeals: (state: string) => deferred(lists, state),
  getModerationAppeal: (id: string) => deferred(details, id),
  assignModerationAppeal: (id: string) => writeCall("assign", id, undefined),
  decideModerationAppeal: (id: string, outcome: string, note: string) =>
    writeCall("decide", id, { outcome, note }),
} as unknown as ApiClient;

const flush = () => new Promise((r) => setTimeout(r, 0));

function row(id: string, over: Partial<ModerationAppealRow> = {}): ModerationAppealRow {
  return {
    id,
    action_id: 11,
    appellant_id: APPELLANT,
    state: "open",
    assignee_id: 0,
    created_at: "2026-09-20 10:00:00",
    decided_at: null,
    // What the server also sends on a row: never shown in the list.
    ...({ body: "LIST-STATEMENT", decision_note: "LIST-NOTE", decided_by: 0 } as object),
    ...over,
  };
}

function detail(id: string, over: Partial<ModerationAppealDetail> = {}): ModerationAppealDetail {
  return {
    id,
    action_id: 11,
    appellant_id: APPELLANT,
    body: "Please reconsider.",
    state: "open",
    assignee_id: 0,
    decided_by: 0,
    decision_note: "",
    created_at: "2026-09-20 10:00:00",
    decided_at: null,
    action: {
      id: 11,
      kind: "timeout",
      actor_id: OTHER,
      reason: "flooding",
      created_at: "2026-09-19 10:00:00",
      expires_at: "2099-01-01 00:00:00",
    },
    ...over,
  };
}

function linkedReport(state: string): ModerationReportDetail {
  return {
    id: "r-pub",
    reporter_id: 3,
    subject_id: APPELLANT,
    target_type: "message",
    reason: "spam",
    detail: "",
    state,
    assignee_id: 0,
    outcome: state === "closed" ? "actioned" : "",
    created_at: "2026-09-19 09:00:00",
    evidence: [],
    notes: [],
    events: [],
    actions: [],
  };
}

const held = (id: string, over: Partial<ModerationAppealDetail> = {}) =>
  detail(id, { state: "assigned", assignee_id: ME, ...over });

function mount(): HTMLElement {
  const outer = document.createElement("div");
  outer.className = "feature-view";
  const title = document.createElement("h2");
  title.className = "feature-view-title";
  title.tabIndex = -1;
  const root = document.createElement("div");
  outer.append(title, root);
  document.body.appendChild(outer);
  const ctx: FeatureViewContext = { signal: view.signal, close: () => {}, api };
  renderModerationCenter(root, ctx);
  return root;
}

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const tab = (root: HTMLElement, name: string) =>
  q<HTMLButtonElement>(root, `[data-testid=mod-tab-${name}]`)!;
const work = (root: HTMLElement) => q<HTMLElement>(root, "[data-testid=mod-appeal-work]");
const buttons = (el: Element | null) =>
  [...(el?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
const writeStatus = (root: HTMLElement) =>
  q<HTMLElement>(root, "[data-testid=mod-appeal-write-status]")!.textContent;
const alerts = (root: HTMLElement) =>
  [...root.querySelectorAll("[role=alert]")]
    .map((a) => a.textContent)
    .filter(Boolean)
    .join("|");

/** The Appeals tab chosen, its queue answered with `rows`. */
async function appealsTab(rows: ModerationAppealRow[]): Promise<HTMLElement> {
  const root = mount();
  tab(root, "appeals").click();
  lists.at(-1)!.resolve(rows);
  await flush();
  return root;
}

/** An appeal opened and answered with `d`. */
async function opened(d: ModerationAppealDetail, r = row(d.id)): Promise<HTMLElement> {
  const root = await appealsTab([r]);
  q<HTMLButtonElement>(root, "[data-testid=mod-appeal-row]")!.click();
  details.at(-1)!.resolve(d);
  await flush();
  return root;
}

/** The re-read that follows a write: the queue, then the appeal. */
async function reread(d: ModerationAppealDetail): Promise<void> {
  lists.at(-1)!.resolve([row(d.id, { state: d.state, assignee_id: d.assignee_id })]);
  await flush();
  details.at(-1)!.resolve(d);
  await flush();
}

function decide(root: HTMLElement, outcome: "upheld" | "overturned", note = ""): void {
  q<HTMLInputElement>(root, `input[value=${outcome}]`)!.click();
  const input = q<HTMLTextAreaElement>(root, "[data-testid=mod-appeal-note]")!;
  input.value = note;
  input.dispatchEvent(new Event("input"));
  q<HTMLFormElement>(work(root)!, "form")!.requestSubmit();
}

beforeEach(() => {
  reportLists = [];
  reportDetails = [];
  lists = [];
  details = [];
  writes = [];
  view = new AbortController();
  authStore.setState((s) => ({
    ...s,
    user: { id: ME, username: "mod", avatar: null, role: "moderator" },
  }));
  setMembers([
    { id: OTHER, username: "otto", avatar: null, role: "moderator", status: "online" },
    { id: APPELLANT, username: "appy", avatar: null, role: "member", status: "online" },
  ]);
});

afterEach(() => {
  view.abort();
  document.body.replaceChildren();
});

describe("Appeals tab", () => {
  it("reads nothing about appeals until its tab is chosen", async () => {
    const root = mount();
    expect(tab(root, "reports").getAttribute("aria-selected")).toBe("true");
    expect(lists).toHaveLength(0);
    tab(root, "appeals").click();
    expect(lists).toHaveLength(1);
    expect(lists[0]!.arg).toBe("");
    expect(tab(root, "appeals").getAttribute("aria-selected")).toBe("true");
    expect(tab(root, "reports").tabIndex).toBe(-1);
  });

  it("moves between tabs with the arrow keys, Home and End", () => {
    const root = mount();
    tab(root, "reports").focus();
    tab(root, "reports").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(document.activeElement).toBe(tab(root, "appeals"));
    expect(tab(root, "appeals").getAttribute("aria-selected")).toBe("true");
    tab(root, "appeals").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    expect(document.activeElement).toBe(tab(root, "reports"));
  });

  it("lists who appealed, the state and when, never the statement or a decision note", async () => {
    const root = await appealsTab([
      row("a1"),
      row("a2", { state: "assigned", assignee_id: OTHER }),
    ]);
    const list = q<HTMLElement>(root, "[data-testid=mod-appeal-queue]")!;
    expect(list.textContent).toContain("Appeal from appy");
    expect(list.textContent).toContain("In review");
    expect(list.textContent).not.toContain("LIST-STATEMENT");
    expect(list.textContent).not.toContain("LIST-NOTE");
    expect(q(root, "[data-testid=mod-appeal-status]")!.textContent).toBe(
      "2 appeals open or in review",
    );
  });

  it("shows the action and statement, and a linked report only when the server returned one", async () => {
    const root = await opened(detail("a1"));
    const appeal = q<HTMLElement>(root, "[data-testid=mod-appeal]")!;
    expect(appeal.textContent).toContain("Appeal: Timeout");
    expect(appeal.textContent).toContain("flooding");
    expect(appeal.textContent).toContain("Please reconsider.");
    expect(buttons(appeal)).not.toContain("Open the report");
    expect(document.activeElement).toBe(q(appeal, "h3"));
  });

  it("opens a linked report in Reports, read by id with its own authorization", async () => {
    const root = await opened(detail("a1", { report_id: "r-pub" }));
    reportLists.at(-1)!.resolve([]);
    await flush();
    const link = [...root.querySelectorAll("button")].find(
      (b) => b.textContent === "Open the report",
    )!;
    link.click();
    expect(tab(root, "reports").getAttribute("aria-selected")).toBe("true");
    expect(reportDetails.at(-1)!.arg).toBe("r-pub");
    reportDetails.at(-1)!.resolve(linkedReport("closed"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    // A list re-read without it keeps it open: it was opened by id.
    noteQueueChange();
    await flush();
    reportLists.at(-1)!.resolve([]);
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
  });

  it("keeps re-reading a linked report after the Reports filter changes", async () => {
    const root = await opened(detail("a1", { report_id: "r-pub" }));
    reportLists.at(-1)!.resolve([]);
    await flush();
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Open the report")!.click();
    reportDetails.at(-1)!.resolve(linkedReport("open"));
    await flush();
    const filter = q<HTMLSelectElement>(root, "[data-testid=mod-filter]")!;
    filter.value = "closed";
    filter.dispatchEvent(new Event("change"));
    reportLists.at(-1)!.resolve([]);
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    const reads = reportDetails.length;
    noteQueueChange();
    await flush();
    reportLists.at(-1)!.resolve([]);
    await flush();
    expect(reportDetails.length).toBe(reads + 1);
    expect(reportDetails.at(-1)!.arg).toBe("r-pub");
    reportDetails.at(-1)!.resolve(linkedReport("closed"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
  });
});

describe("taking and deciding", () => {
  it("offers Take on an unassigned appeal and reports success only after the server answers", async () => {
    const root = await opened(detail("a1"));
    expect(buttons(work(root))).toEqual(["Take this appeal"]);
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    expect(writes).toMatchObject([{ op: "assign", arg: "a1" }]);
    expect(writeStatus(root)).toBe("");
    // A second press while the first is in flight sends nothing.
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    expect(writes).toHaveLength(1);
    writes[0]!.resolve();
    await flush();
    expect(writeStatus(root)).toBe("You're now reviewing this appeal.");
    await reread(held("a1"));
    expect(q(root, "[data-testid=mod-appeal-note]")).not.toBeNull();
  });

  it("offers nothing on an appeal another moderator holds", async () => {
    const root = await opened(detail("a1", { state: "assigned", assignee_id: OTHER }));
    expect(buttons(work(root))).toEqual([]);
    expect(work(root)!.textContent).toContain("Only they can decide it");
  });

  it("labels the note as the appellant's to read and requires an outcome", async () => {
    const root = await opened(held("a1"));
    expect(work(root)!.textContent).toContain("Note to the appellant");
    expect(work(root)!.textContent).toContain("isn't an internal note");
    q<HTMLFormElement>(work(root)!, "form")!.requestSubmit();
    expect(writes).toHaveLength(0);
    expect(alerts(root)).toContain("Choose uphold or overturn first.");
  });

  it("sends the decision, then shows the outcome the server recorded", async () => {
    const root = await opened(
      held("a1", { action: { ...detail("a1").action, kind: "removal", expires_at: undefined } }),
    );
    expect(work(root)!.textContent).toContain("the removed message isn't restored");
    decide(root, "overturned", "You were right.\nSorry.");
    expect(writes).toMatchObject([
      { op: "decide", arg: "a1", body: { outcome: "overturned", note: "You were right. Sorry." } },
    ]);
    expect(writeStatus(root)).toBe("");
    writes[0]!.resolve();
    await flush();
    expect(writeStatus(root)).toContain("Decision recorded");
    await reread(
      held("a1", {
        state: "overturned",
        decided_by: ME,
        decided_at: "2026-09-21 10:00:00",
        decision_note: "You were right. Sorry.",
        action: { ...detail("a1").action, kind: "removal", expires_at: undefined },
      }),
    );
    const result = work(root)!;
    expect(q(result, "[data-testid=mod-appeal-result]")!.textContent).toBe("Overturned.");
    expect(result.textContent).toContain("the removed message wasn't restored");
    expect(result.textContent).toContain("You were right. Sorry.");
    expect(buttons(result)).toEqual([]);
    expect(alerts(root)).toBe("");
  });

  it("names the moderator who issued the action and still lets the server decide", async () => {
    const root = await opened(detail("a1", { action: { ...detail("a1").action, actor_id: ME } }));
    expect(work(root)!.textContent).toContain("only when no other moderator can");
    q<HTMLButtonElement>(work(root)!, "button")!.click();
    writes[0]!.reject(new ApiClientError(403, "SELF_REVIEW", "self review"));
    await flush();
    expect(alerts(root)).toContain("The server refused");
    expect(writeStatus(root)).toBe("");
    await reread(detail("a1", { action: { ...detail("a1").action, actor_id: ME } }));
    expect(q(root, "[data-testid=mod-appeal]")).not.toBeNull();
  });
});

describe("refusals", () => {
  it("says nothing was recorded when the reversal fails, and keeps the draft", async () => {
    const root = await opened(held("a1"));
    decide(root, "overturned", "note");
    writes[0]!.reject(new ApiClientError(409, "REVERSAL_FAILED", "could not apply"));
    await flush();
    expect(alerts(root)).toContain("Nothing was recorded");
    expect(writeStatus(root)).toBe("");
    await reread(held("a1"));
    expect(q<HTMLTextAreaElement>(root, "[data-testid=mod-appeal-note]")!.value).toBe("note");
    expect(q<HTMLInputElement>(root, "input[value=overturned]")!.checked).toBe(true);
  });

  it("shows the server's state after a conflict, not the reader's guess", async () => {
    const root = await opened(held("a1"));
    decide(root, "upheld");
    writes[0]!.reject(new ApiClientError(409, "CONFLICT", "already decided"));
    await flush();
    expect(alerts(root)).toContain("this appeal changed first");
    await reread(
      detail("a1", { state: "overturned", assignee_id: OTHER, decided_by: OTHER, decided_at: "x" }),
    );
    expect(q(root, "[data-testid=mod-appeal-result]")!.textContent).toBe("Overturned.");
  });

  it("clears both tabs when a demoted moderator's decision is refused", async () => {
    const root = await opened(held("a1"));
    decide(root, "upheld", "private words");
    writes[0]!.reject(new ApiClientError(403, "FORBIDDEN", "missing permission"));
    await flush();
    expect(q(root, "[data-testid=mod-appeal]")).toBeNull();
    expect(root.textContent).not.toContain("Please reconsider.");
    expect(root.textContent).not.toContain("Appeal from");
    expect(alerts(root)).toContain("You no longer have permission");
    expect(q<HTMLElement>(root, "[data-testid=mod-queue]")!.hidden).toBe(true);
    expect(writeStatus(root)).toBe("");
    // Nothing more is read or sent.
    noteAppealChange();
    await flush();
    expect(lists).toHaveLength(1);
    expect(details).toHaveLength(1);
  });

  it("clears both tabs when the appeal queue itself is refused", async () => {
    const root = mount();
    tab(root, "appeals").click();
    lists[0]!.reject(new ApiClientError(403, "FORBIDDEN", "no"));
    await flush();
    expect(alerts(root)).toContain("You no longer have permission");
    expect(
      q<HTMLElement>(root, "[data-testid=mod-appeal-filter]")!.closest("[hidden]"),
    ).not.toBeNull();
  });

  it("does not clear the view when the reader opens their own appeal", async () => {
    const root = await appealsTab([row("a1")]);
    q<HTMLButtonElement>(root, "[data-testid=mod-appeal-row]")!.click();
    details[0]!.reject(new ApiClientError(403, "SELF_REVIEW", "own"));
    await flush();
    expect(root.textContent).toContain("You filed this appeal");
    expect(q(root, "[data-testid=mod-appeal-row]")).not.toBeNull();
  });

  it("drops an appeal that is gone", async () => {
    const root = await opened(held("a1"));
    decide(root, "upheld");
    writes[0]!.reject(new ApiClientError(404, "NOT_FOUND", "gone"));
    await flush();
    expect(q(root, "[data-testid=mod-appeal]")).toBeNull();
    expect(root.textContent).toContain("This appeal is no longer available.");
  });
});

describe("lifetime", () => {
  it("re-reads on an appeal frame and removes everything when the view closes", async () => {
    const root = await opened(held("a1"));
    noteAppealChange();
    await flush();
    expect(lists).toHaveLength(2);
    lists[1]!.resolve([row("a1", { state: "assigned", assignee_id: ME })]);
    await flush();
    expect(details).toHaveLength(2);
    view.abort();
    expect(root.childElementCount).toBe(0);
  });
});
