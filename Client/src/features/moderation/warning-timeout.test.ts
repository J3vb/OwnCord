// B9-13: warning, timeout and lifting a timeout from a report. The server
// authorizes every action; the view offers them only where it would, says
// what happened only once the server answers (a timeout's voice half as the
// server reported it), and shows a refusal as a refusal.
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
import { lengthSeconds } from "./ActionForms";
import { renderModerationCenter } from "./Queue";
import { noteQueueChange } from "./store";

const ME = 7;
const SUBJECT = 4;

interface Call<T> {
  readonly arg: string;
  readonly body?: unknown;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

let lists: Call<ModerationQueueRow[]>[];
let details: Call<ModerationReportDetail>[];
let writes: (Call<unknown> & { readonly op: string })[];
let view: AbortController;

function deferred<T>(bucket: Call<T>[], arg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => bucket.push({ arg, resolve, reject }));
}

function writeCall(op: string, arg: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => writes.push({ op, arg, body, resolve, reject }));
}

const api = {
  getModerationQueue: (state: string) => deferred(lists, state),
  getModerationReport: (id: string) => deferred(details, id),
  assignModerationReport: (id: string) => writeCall("assign", id),
  addModerationNote: (id: string, body: string) => writeCall("note", id, body),
  closeModerationReport: (id: string, outcome: string) => writeCall("close", id, outcome),
  actOnModerationReport: (id: string, body: unknown) => writeCall("act", id, body),
  liftTimeout: (userId: number) => writeCall("lift", String(userId)),
} as unknown as ApiClient;

const flush = () => new Promise((r) => setTimeout(r, 0));

const row = (id: string, over: Partial<ModerationQueueRow> = {}): ModerationQueueRow => ({
  id,
  reporter_name: "carol",
  subject_name: "dave",
  target_type: "user",
  target_ref: String(SUBJECT),
  reason: "harassment",
  state: "assigned",
  assignee_id: ME,
  outcome: "",
  created_at: "2026-09-05 10:00:00",
  updated_at: "2026-09-05 10:00:00",
  ...over,
});

const FUTURE = "2999-01-01T00:00:00Z";
const PAST = "2001-01-01T00:00:00Z";

const timeout = (over: { expires_at?: string; lifted_at?: string } = {}) => ({
  id: 11,
  kind: "timeout",
  actor_id: ME,
  reason: "cool off",
  created_at: "2026-09-05 11:00:00",
  expires_at: FUTURE,
  ...over,
});

function held(id: string, over: Partial<ModerationReportDetail> = {}): ModerationReportDetail {
  return {
    id,
    reporter_id: 3,
    subject_id: SUBJECT,
    target_type: "user",
    reason: "harassment",
    detail: "",
    state: "assigned",
    assignee_id: ME,
    outcome: "",
    created_at: "2026-09-05 10:00:00",
    evidence: [],
    notes: [],
    events: [],
    actions: [],
    ...over,
  };
}

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const ctx: FeatureViewContext = { signal: view.signal, close: () => {}, api };
  renderModerationCenter(root, ctx);
  return root;
}

const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector<T>(sel);
const acts = (root: HTMLElement) => q<HTMLElement>(root, "[data-testid=mod-act]");
const buttons = (el: Element | null) =>
  [...(el?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
const status = (root: HTMLElement) => q<HTMLElement>(root, "[data-testid=mod-write-status]")!;
const alerts = (root: HTMLElement) =>
  [...root.querySelectorAll("[role=alert]")]
    .map((a) => a.textContent)
    .filter(Boolean)
    .join("|");
const field = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("label")].find((l) => l.textContent === label)
    ?.control as HTMLInputElement | null;

async function opened(d: ModerationReportDetail, r = row(d.id)): Promise<HTMLElement> {
  const root = mount();
  lists.at(-1)!.resolve([r]);
  await flush();
  q<HTMLButtonElement>(root, ".mod-queue-row")!.click();
  details.at(-1)!.resolve(d);
  await flush();
  return root;
}

async function reread(d: ModerationReportDetail): Promise<void> {
  lists.at(-1)!.resolve([row(d.id, { state: d.state, assignee_id: d.assignee_id })]);
  await flush();
  details.at(-1)!.resolve(d);
  await flush();
}

function type(el: Element | null | undefined, value: string): void {
  const input = el as HTMLInputElement | HTMLSelectElement;
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input"));
}

function press(root: HTMLElement, label: string): void {
  const b = [...acts(root)!.querySelectorAll("button")].find((x) => x.textContent === label)!;
  if (b.type === "submit")
    b.closest("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  else b.click();
}

async function timeOut(root: HTMLElement, amount: string, unit = "minutes"): Promise<void> {
  type(field(root, "Timeout length"), amount);
  type(field(root, "Unit"), unit);
  press(root, "Time out");
  await flush();
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
  setMembers([{ id: ME, username: "bob", avatar: null, role: "moderator", status: "online" }]);
});

afterEach(() => {
  view.abort();
  document.body.replaceChildren();
});

describe("what the actions offer", () => {
  it("offers warning and timeout to the moderator holding an open report", async () => {
    const root = await opened(held("r1"));
    expect(buttons(acts(root))).toEqual(["Issue warning", "Time out"]);
    expect(acts(root)!.querySelector("h4")!.textContent).toBe("Actions");
    // Q10: one number and a unit, no presets.
    const unit = field(root, "Unit") as unknown as HTMLSelectElement;
    expect([...unit.options].map((o) => o.value)).toEqual(["minutes", "hours", "days"]);
    expect(field(root, "Timeout length")!.type).toBe("number");
  });

  it.each([
    ["an unassigned report", held("r1", { state: "open", assignee_id: 0 })],
    ["a report another moderator holds", held("r1", { assignee_id: 9 })],
    ["the reader's own filing", held("r1", { reporter_id: ME })],
    ["an erased subject", held("r1", { subject_id: 0 })],
    ["a closed report with no running timeout", held("r1", { state: "resolved" })],
    [
      "another moderator's report with a running timeout",
      held("r1", { assignee_id: 9, actions: [timeout()] }),
    ],
    [
      "a closed report whose timeout ended or was lifted",
      held("r1", {
        state: "resolved",
        actions: [timeout({ expires_at: PAST }), timeout({ lifted_at: PAST })],
      }),
    ],
  ])("offers nothing on %s", async (_, d) => {
    const root = await opened(d);
    expect(acts(root)).toBeNull();
  });

  it("offers lifting this report's running timeout, even once the report is closed", async () => {
    const root = await opened(held("r1", { state: "resolved", actions: [timeout()] }));
    expect(buttons(acts(root))).toEqual(["Lift timeout"]);
    const lift = q<HTMLButtonElement>(acts(root)!, "button")!;
    const hint = document.getElementById(lift.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toMatch(/^This report's timeout runs until /);
  });

  it("shows a running timeout's end in the history", async () => {
    const root = await opened(held("r1", { actions: [timeout()] }));
    expect(q(root, ".mod-history-item")!.textContent).toContain("Until ");
  });
});

describe("the timeout length (Q10)", () => {
  it.each([
    ["1", "minutes", 60],
    ["28", "days", 2_419_200],
    ["672", "hours", 2_419_200],
    [" 3 ", "hours", 10_800],
  ] as const)("accepts %s %s", (amount, unit, seconds) => {
    expect(lengthSeconds(amount, unit)).toBe(seconds);
  });

  it.each([
    ["", "minutes"],
    ["0", "minutes"],
    ["1.5", "hours"],
    ["-1", "days"],
    ["29", "days"],
    ["40321", "minutes"],
    ["1e3", "minutes"],
  ] as const)("refuses %j %s before sending", (amount, unit) => {
    expect(lengthSeconds(amount, unit)).toBeNull();
  });

  it("says why, focuses the length and sends nothing", async () => {
    const root = await opened(held("r1"));
    await timeOut(root, "29", "days");
    expect(writes).toHaveLength(0);
    expect(alerts(root)).toBe("Enter a whole number, for a length from 1 minute to 28 days.");
    expect(document.activeElement).toBe(field(root, "Timeout length"));
    expect(field(root, "Timeout length")!.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("the committed outcome", () => {
  it("sends a timeout through the report and waits for the server before saying so", async () => {
    const root = await opened(held("r1"));
    type(field(root, "Timeout reason, shown to the member"), "  spam\tagain ");
    await timeOut(root, "2", "hours");
    expect(writes.map((w) => [w.op, w.arg, w.body])).toEqual([
      ["act", "r1", { kind: "timeout", reason: "spam again", duration_seconds: 7200 }],
    ]);
    expect(status(root).textContent).toBe("");
    expect(q(acts(root)!, "button")!.getAttribute("aria-disabled")).toBe("true");

    writes[0]!.resolve({ voice: "applied" });
    await flush();
    expect(status(root).textContent).toBe(
      "Timed out for 2 hours: they can't send messages or react. They were also server-muted in their voice channel.",
    );
    await reread(held("r1", { actions: [timeout()] }));
    // The saved form is empty; the history carries the timeout.
    expect(field(root, "Timeout reason, shown to the member")!.value).toBe("");
    expect(field(root, "Timeout length")!.value).toBe("");
    expect(buttons(acts(root))).toEqual(["Issue warning", "Time out", "Lift timeout"]);
  });

  it.each([
    ["skipped", { voice: "skipped" }],
    ["unstated", undefined],
    ["unknown", { voice: "partial" }],
  ])("never claims the voice half when the server's answer is %s", async (_, answer) => {
    const root = await opened(held("r1"));
    await timeOut(root, "1", "days");
    writes[0]!.resolve(answer);
    await flush();
    expect(status(root).textContent).toBe(
      "Timed out for 1 day: they can't send messages or react. Their voice wasn't changed: they weren't in a voice channel where you can moderate voice, or the mute didn't take effect.",
    );
  });

  it("issues a warning linked to the report and clears its reason once saved", async () => {
    const root = await opened(held("r1"));
    type(field(root, "Warning reason, shown to the member"), "be kind");
    press(root, "Issue warning");
    expect(writes.map((w) => [w.op, w.arg, w.body])).toEqual([
      ["act", "r1", { kind: "warning", reason: "be kind" }],
    ]);
    writes[0]!.resolve(undefined);
    await flush();
    expect(status(root).textContent).toBe(
      "Warning issued. The member sees it now, or the next time they sign in.",
    );
    await reread(held("r1"));
    expect(field(root, "Warning reason, shown to the member")!.value).toBe("");
  });

  it("lifts a timeout through the member's own route", async () => {
    const root = await opened(held("r1", { actions: [timeout()] }));
    press(root, "Lift timeout");
    expect(writes.map((w) => [w.op, w.arg])).toEqual([["lift", String(SUBJECT)]]);
    writes[0]!.resolve(undefined);
    await flush();
    expect(status(root).textContent).toBe(
      "Timeout lifted: they can send messages and react again.",
    );
    await reread(held("r1", { actions: [timeout({ lifted_at: "2026-09-05 12:00:00" })] }));
    expect(buttons(acts(root))).toEqual(["Issue warning", "Time out"]);
  });

  it("keeps a typed reason and length across a background re-read", async () => {
    const root = await opened(held("r1"));
    type(field(root, "Timeout reason, shown to the member"), "still typing");
    type(field(root, "Timeout length"), "5");
    noteQueueChange();
    await flush();
    await reread(held("r1"));
    expect(field(root, "Timeout reason, shown to the member")!.value).toBe("still typing");
    expect(field(root, "Timeout length")!.value).toBe("5");
  });

  it("says so when the report can no longer take the unsaved reason", async () => {
    const root = await opened(held("r1"));
    type(field(root, "Warning reason, shown to the member"), "unsent");
    noteQueueChange();
    await flush();
    await reread(held("r1", { assignee_id: 9 }));
    expect(acts(root)).toBeNull();
    expect(alerts(root)).toBe(
      "You can no longer act on this report here, so the unsaved reason was discarded.",
    );
  });

  it("sends one write at a time across the review and the actions", async () => {
    const root = await opened(held("r1"));
    await timeOut(root, "10");
    press(root, "Issue warning");
    expect(writes.map((w) => w.op)).toEqual(["act"]);
  });

  it("drops a late answer once the view is closed", async () => {
    const root = await opened(held("r1"));
    await timeOut(root, "10");
    view.abort();
    writes[0]!.resolve({ voice: "applied" });
    await flush();
    expect(root.textContent).toBe("");
    // Nothing is read again for a view that is gone.
    expect(lists).toHaveLength(1);
  });
});

const refused = (code: number, name: string, message = "") =>
  new ApiClientError(code, name, message);

describe("refusals", () => {
  it("shows a rank refusal without clearing the view, then reads the report again", async () => {
    const root = await opened(held("r1"));
    await timeOut(root, "10");
    writes[0]!.reject(
      refused(403, "FORBIDDEN", "forbidden: cannot moderate a user of equal or higher rank"),
    );
    await flush();
    expect(alerts(root)).toBe(
      "The server refused this action. You can act only on members whose role is below yours.",
    );
    expect(status(root).textContent).toBe("");
    expect(q<HTMLElement>(root, "[data-testid=mod-queue]")!.hidden).toBe(false);
    await reread(held("r1"));
    expect(acts(root)).not.toBeNull();
    expect(alerts(root)).toContain("The server refused this action.");
  });

  it("clears everything when the refusal came from a lost permission", async () => {
    const root = await opened(held("r1"));
    type(field(root, "Warning reason, shown to the member"), "unsent");
    press(root, "Issue warning");
    writes[0]!.reject(refused(403, "FORBIDDEN", "forbidden: missing MODERATE_MEMBERS permission"));
    await flush();
    // The re-read is refused too: the reader was demoted.
    lists.at(-1)!.reject(refused(403, "FORBIDDEN"));
    await flush();
    expect(alerts(root)).toBe("You no longer have permission to moderate on this server.");
    expect(acts(root)).toBeNull();
    expect(q(root, "[data-testid=mod-report]")).toBeNull();
    expect(root.textContent).not.toContain("unsent");
  });

  it("shows the server's own words for input it refused", async () => {
    const root = await opened(held("r1"));
    await timeOut(root, "10");
    writes[0]!.reject(
      refused(400, "BAD_REQUEST", "bad request: duration must be between 1 minute and 28 days"),
    );
    await flush();
    expect(alerts(root)).toBe(
      "The server didn't accept this: bad request: duration must be between 1 minute and 28 days",
    );
  });

  it("does not guess when no answer came back", async () => {
    const root = await opened(held("r1"));
    await timeOut(root, "10");
    writes[0]!.reject(new TypeError("Failed to fetch"));
    await flush();
    expect(alerts(root)).toBe(
      "Couldn't confirm this action. Check the history before trying again.",
    );
    // The history is read again rather than assumed.
    expect(details.at(-1)!.arg).toBe("r1");
    expect(lists).toHaveLength(2);
  });

  it("says so when there is no timeout left to lift, and keeps the report", async () => {
    const root = await opened(held("r1", { state: "resolved", actions: [timeout()] }));
    press(root, "Lift timeout");
    writes[0]!.reject(refused(404, "NOT_FOUND", "not found: no active timeout"));
    await flush();
    expect(alerts(root)).toBe("There's no timeout to lift: it has ended or was already lifted.");
    await reread(held("r1", { state: "resolved", actions: [timeout({ lifted_at: PAST })] }));
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    expect(acts(root)).toBeNull();
  });

  it("closes the report when the act route says it is gone", async () => {
    const root = await opened(held("r1"));
    await timeOut(root, "10");
    writes[0]!.reject(refused(404, "NOT_FOUND"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).toBeNull();
  });
});
