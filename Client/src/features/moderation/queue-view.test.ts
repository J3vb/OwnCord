// The Moderation Center's report view: its tabs, regions, rows, filters,
// request ordering, focus and the way each write is told apart from the next.
// The server authorizes every read and write; these tests pin what the view
// shows, keeps and discards around those answers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  type ApiClient,
  type ModerationQueueRow,
  type ModerationReportDetail,
} from "@lib/api";
import { Permission } from "@lib/types";
import { authStore } from "@stores/auth.store";
import {
  resetChannelsStore,
  setChannels,
  setNsfwAcknowledged,
  setRoles,
} from "@stores/channels.store";
import { setMembers } from "@stores/members.store";
import { setConnectionStatus, uiStore } from "@stores/ui.store";
import { moderationText as t } from "../../i18n/moderation";
import type { FeatureViewContext } from "../navigation/destinations";
import { renderModerationCenter } from "./Queue";
import { noteQueueChange } from "./store";
import { pinZone } from "../../../tests/helpers/tz-pin";

const ME = 7;
const SUBJECT = 4;
const SPICY = 9;

interface Call<T> {
  readonly arg: string;
  readonly signal: AbortSignal | undefined;
  readonly body?: unknown;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

let lists: Call<ModerationQueueRow[]>[];
let details: Call<ModerationReportDetail>[];
let appealLists: Call<unknown[]>[];
let appealDetails: Call<unknown>[];
let writes: (Call<unknown> & { readonly op: string })[];
let view: AbortController;
let restoreTZ: () => void;

function deferred<T>(bucket: Call<T>[], arg: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => bucket.push({ arg, signal, resolve, reject }));
}

function writeCall(op: string, arg: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) =>
    writes.push({ op, arg, signal: undefined, body, resolve, reject }),
  );
}

const api = {
  getModerationQueue: (state: string, signal?: AbortSignal) => deferred(lists, state, signal),
  getModerationReport: (id: string, signal?: AbortSignal) => deferred(details, id, signal),
  getModerationAppeals: (state: string, signal?: AbortSignal) =>
    deferred(appealLists, state, signal),
  getModerationAppeal: (id: string, signal?: AbortSignal) => deferred(appealDetails, id, signal),
  assignModerationReport: (id: string) => writeCall("assign", id),
  addModerationNote: (id: string, body: string) => writeCall("note", id, body),
  closeModerationReport: (id: string, outcome: string) => writeCall("close", id, outcome),
  actOnModerationReport: (id: string, body: unknown) => writeCall("act", id, body),
  liftTimeout: (userId: number) => writeCall("lift", String(userId)),
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
    subject_id: SUBJECT,
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

/** A report this reader is reviewing. */
const held = (id: string, over: Partial<ModerationReportDetail> = {}) =>
  detail(id, { state: "assigned", assignee_id: ME, ...over });
const heldRow = (id: string, over: Partial<ModerationQueueRow> = {}) =>
  row(id, { state: "assigned", assignee_id: ME, ...over });

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
const tabEls = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>("[role=tab]")];
const panelEls = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[role=tabpanel]")];
const reportsPanel = (root: HTMLElement) => panelEls(root)[0]!;
const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>(".mod-queue-row")];
const rowBtn = (root: HTMLElement, id: string) =>
  rows(root).find((b) => b.dataset.reportId === id)!;
/** The three live regions: the list's, the open report's and the write's. */
const statuses = (root: HTMLElement) =>
  [...reportsPanel(root).querySelectorAll("[role=status]")].map((p) => p.textContent);
const alertEls = (root: HTMLElement) => [...reportsPanel(root).querySelectorAll("[role=alert]")];
const alerts = (root: HTMLElement) =>
  alertEls(root)
    .map((a) => a.textContent)
    .filter(Boolean)
    .join("|");
const selectEl = (root: HTMLElement) => q<HTMLSelectElement>(root, "[data-testid=mod-filter]")!;
const retryButtons = (root: HTMLElement) =>
  [...reportsPanel(root).querySelectorAll<HTMLButtonElement>("button.btn-modal-save")].filter(
    (b) => b.textContent === t("retry"),
  );
const detailRetry = (root: HTMLElement) => retryButtons(root)[1]!;
const listRetry = (root: HTMLElement) => retryButtons(root)[0]!;
const heading = (root: HTMLElement) => q<HTMLElement>(root, "[data-testid=mod-report] h3");
const focusEl = (root: HTMLElement, key: string) =>
  q<HTMLInputElement & HTMLTextAreaElement & HTMLButtonElement>(root, `[data-focus="${key}"]`)!;

async function queueFrame(): Promise<void> {
  noteQueueChange();
  await flush();
}

async function withQueue(rowList: ModerationQueueRow[]): Promise<HTMLElement> {
  const root = mount();
  lists.at(-1)!.resolve(rowList);
  await flush();
  return root;
}

async function opened(d: ModerationReportDetail, r?: ModerationQueueRow): Promise<HTMLElement> {
  const root = await withQueue([r ?? row(d.id, { state: d.state, assignee_id: d.assignee_id })]);
  rowBtn(root, d.id).click();
  details.at(-1)!.resolve(d);
  await flush();
  return root;
}

/** The re-read that follows a write: the queue, then the report. */
async function reread(d: ModerationReportDetail): Promise<void> {
  lists.at(-1)!.resolve([row(d.id, { state: d.state, assignee_id: d.assignee_id })]);
  await flush();
  details.at(-1)!.resolve(d);
  await flush();
}

function typeInto(el: Element | null | undefined, value: string): void {
  const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input"));
}

const submitOf = (el: Element | null | undefined) =>
  el!.closest("form")!.dispatchEvent(new Event("submit", { cancelable: true }));

const ALL_BITS = Permission.MANAGE_MESSAGES | Permission.KICK_MEMBERS | Permission.BAN_MEMBERS;
const grantAll = () => setRoles([{ id: 3, name: "Moderator", color: null, permissions: ALL_BITS }]);

type Kind = "note" | "warning" | "timeout" | "removal" | "kick" | "ban";
const ENFORCE_LABEL = { removal: "Remove message", kick: "Log out", ban: "Ban" } as const;

/** Fill one field of every kind on the open report. */
function fillAll(root: HTMLElement, suffix: string): void {
  typeInto(q(root, "[data-testid=mod-note-input]"), `note-${suffix}`);
  typeInto(focusEl(root, "warn"), `warn-${suffix}`);
  typeInto(focusEl(root, "reason"), `reason-${suffix}`);
  typeInto(focusEl(root, "amount"), "6");
  typeInto(focusEl(root, "enforce"), `enforce-${suffix}`);
}

/** Send the write of `kind` from the open report. */
function trigger(root: HTMLElement, kind: Kind): void {
  if (kind === "note") submitOf(q(root, "[data-testid=mod-note-input]"));
  else if (kind === "warning") submitOf(focusEl(root, "warn"));
  else if (kind === "timeout") submitOf(focusEl(root, "amount"));
  else {
    focusEl(root, kind).click();
    const dialog = document.querySelector("[role=dialog]")!;
    [...dialog.querySelectorAll("button")]
      .find((b) => b.textContent === ENFORCE_LABEL[kind])!
      .click();
  }
}

const fieldValues = (root: HTMLElement) => ({
  note: q<HTMLTextAreaElement>(root, "[data-testid=mod-note-input]")!.value,
  warn: focusEl(root, "warn").value,
  reason: focusEl(root, "reason").value,
  amount: focusEl(root, "amount").value,
  enforce: focusEl(root, "enforce").value,
});

beforeEach(() => {
  restoreTZ = pinZone("UTC");
  lists = [];
  details = [];
  appealLists = [];
  appealDetails = [];
  writes = [];
  view = new AbortController();
  resetChannelsStore();
  setChannels([
    {
      id: SPICY,
      name: "spicy",
      type: "text",
      category: null,
      position: 0,
      nsfw: true,
      nsfw_acknowledged: true,
    },
  ]);
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
  vi.restoreAllMocks();
  resetChannelsStore();
  document.body.replaceChildren();
  restoreTZ();
});

const selected = (root: HTMLElement) =>
  tabEls(root).findIndex((x) => x.getAttribute("aria-selected") === "true");

function press(root: HTMLElement, from: number, key: string): KeyboardEvent {
  const tabs = tabEls(root);
  tabs[from]!.focus();
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  tabs[from]!.dispatchEvent(e);
  return e;
}

describe("the tabs", () => {
  it("labels the tabs and panels and ties each tab to its panel", () => {
    const root = mount();
    const list = q<HTMLElement>(root, "[role=tablist]")!;
    expect(list.className).toBe("mod-tabs");
    expect(list.getAttribute("aria-label")).toBe(t("tabs.label"));
    const tabs = tabEls(root);
    const panels = panelEls(root);
    expect(tabs.map((x) => x.textContent)).toEqual([t("tabs.reports"), t("tabs.appeals")]);
    const names = ["reports", "appeals"];
    tabs.forEach((tab, i) => {
      expect(tab.type).toBe("button");
      expect(tab.className).toBe("mod-tab");
      expect(tab.id).toMatch(new RegExp(`^mod-tab-\\d+-${names[i]}$`));
      expect(tab.getAttribute("aria-controls")).toBe(panels[i]!.id);
      expect(panels[i]!.id).toMatch(new RegExp(`^mod-panel-\\d+-${names[i]}$`));
      expect(panels[i]!.getAttribute("aria-labelledby")).toBe(tab.id);
      expect(panels[i]!.className).toBe("mod-panel");
    });
  });

  it("gives two open views no id in common", () => {
    const first = mount();
    const second = mount();
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const root of [first, second]) {
      const select = selectEl(root);
      expect(select.id).not.toBe("");
      expect(q(root, `label[for="${select.id}"]`)?.textContent).toBe(t("filter.label"));
    }
  });

  it("shows only the chosen panel and marks its tab", async () => {
    const root = mount();
    const [reports, appeals] = tabEls(root);
    const [reportsBody, appealsBody] = panelEls(root);
    expect([
      reports!.getAttribute("aria-selected"),
      appeals!.getAttribute("aria-selected"),
    ]).toEqual(["true", "false"]);
    expect([reports!.tabIndex, appeals!.tabIndex]).toEqual([0, -1]);
    expect([reportsBody!.hidden, appealsBody!.hidden]).toEqual([false, true]);
    // The appeals queue is not read until its tab is chosen.
    expect(appealLists).toHaveLength(0);

    appeals!.click();
    expect([
      reports!.getAttribute("aria-selected"),
      appeals!.getAttribute("aria-selected"),
    ]).toEqual(["false", "true"]);
    expect([reports!.tabIndex, appeals!.tabIndex]).toEqual([-1, 0]);
    expect([reportsBody!.hidden, appealsBody!.hidden]).toEqual([true, false]);
    expect(appealLists).toHaveLength(1);

    reports!.click();
    expect([reportsBody!.hidden, appealsBody!.hidden]).toEqual([false, true]);
    expect(appealLists).toHaveLength(1);
    // Coming back to the appeals does not read them a second time.
    appeals!.click();
    expect(appealLists).toHaveLength(1);
    expect(reportsBody!.hidden).toBe(true);
  });

  it.each([
    [0, "ArrowRight", 1],
    [1, "ArrowRight", 0],
    [0, "ArrowLeft", 1],
    [1, "ArrowLeft", 0],
    [1, "Home", 0],
    [0, "End", 1],
  ])("moves from tab %i to the right tab on %s and focuses it", (from, key, to) => {
    const root = mount();
    const e = press(root, from, key);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tabEls(root)[to]);
    expect(selected(root)).toBe(to);
  });

  it.each([
    [0, "a"],
    [1, "a"],
    [0, "Enter"],
    [1, "PageDown"],
  ])("leaves tab %i alone on %s", (from, key) => {
    const root = mount();
    tabEls(root)[1]!.click();
    tabEls(root)[from]!.focus();
    const before = selected(root);
    const e = press(root, from, key);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(tabEls(root)[from]);
    expect(selected(root)).toBe(before);
  });

  it("ignores arrow keys while focus is not on a tab", () => {
    const root = mount();
    tabEls(root)[1]!.click();
    (document.activeElement as HTMLElement | null)?.blur();
    const e = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    q(root, "[role=tablist]")!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(selected(root)).toBe(1);
  });

  it("stops answering clicks and keys once the view is closed", () => {
    const root = mount();
    const tabs = tabEls(root);
    const tablist = q<HTMLElement>(root, "[role=tablist]")!;
    view.abort();
    tabs[1]!.click();
    expect(appealLists).toHaveLength(0);
    vi.spyOn(document, "activeElement", "get").mockReturnValue(tabs[0]!);
    tablist.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    expect(appealLists).toHaveLength(0);
  });

  it("clears the appeals tab too when the reports are refused", async () => {
    const root = mount();
    tabEls(root)[1]!.click();
    appealLists[0]!.resolve([]);
    await flush();
    lists[0]!.reject(new ApiClientError(403, "FORBIDDEN", "missing MODERATE_MEMBERS"));
    await flush();
    expect(panelEls(root)[1]!.textContent).toContain(t("denied"));
  });
});

describe("the report panel", () => {
  it("builds each region with its own role and class, with nothing to retry yet", () => {
    const root = mount();
    const panel = reportsPanel(root);
    expect(q(panel, ".mod-center-intro")?.textContent).toBe(t("intro"));
    expect(q(panel, ".mod-center-toolbar")).not.toBeNull();
    expect(selectEl(root).className).toBe("form-input");
    expect([...panel.querySelectorAll("p[role=status]")].map((p) => p.className)).toEqual([
      "mod-center-status",
      "mod-center-status",
      "mod-center-status",
    ]);
    expect([...panel.querySelectorAll("p[role=alert]")].map((p) => p.className)).toEqual([
      "form-error",
      "form-error",
      "form-error",
    ]);
    const retries = [...panel.querySelectorAll<HTMLButtonElement>("button.btn-modal-save")];
    expect(retries.map((b) => [b.type, b.hidden, b.textContent])).toEqual([
      ["button", true, t("retry")],
      ["button", true, t("retry")],
    ]);
    const list = q<HTMLElement>(panel, "ul.mod-queue")!;
    expect(list.getAttribute("aria-label")).toBe(t("list.label"));
    expect(q(panel, "div.mod-report-slot")).not.toBeNull();
  });

  it("builds a row with its button, parts and full name", async () => {
    const root = await withQueue([row("a")]);
    const button = rows(root)[0]!;
    expect(button.type).toBe("button");
    expect(button.className).toBe("mod-queue-row");
    expect(button.dataset.testid).toBe("mod-queue-row");
    const part = (cls: string) => q(button, `span.${cls}`)?.textContent;
    expect(part("mod-queue-what")).toBe("Message reported for Spam");
    expect(part("mod-queue-who")).toBe("About alice, reported by carol");
    expect(part("mod-queue-state")).toBe("Waiting for review");
    expect(part("mod-queue-when")).toBe("Sent Sep 5, 2026, 10:00 AM");
  });

  it("hides the list while it is empty and shows it again once it has rows", async () => {
    const root = await withQueue([]);
    const list = q<HTMLElement>(root, "ul.mod-queue")!;
    expect(list.hidden).toBe(true);
    await queueFrame();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    expect(list.hidden).toBe(false);
  });

  it("opens nothing from a row once the view is closed", async () => {
    const root = await withQueue([row("a")]);
    const button = rows(root)[0]!;
    view.abort();
    button.click();
    expect(details).toHaveLength(0);
  });

  it("shows each report with the names its own row carried", async () => {
    const root = await withQueue([row("a"), row("b", { subject_name: "zed" })]);
    rowBtn(root, "b").click();
    details.at(-1)!.resolve(detail("b"));
    await flush();
    expect(q(root, ".mod-report-facts dd")?.textContent).toBe("zed");
  });

  it("keeps the same row current and focused across a refresh of the queue", async () => {
    const root = await withQueue([row("a"), row("b")]);
    rowBtn(root, "b").click();
    rowBtn(root, "b").focus();
    await queueFrame();
    lists.at(-1)!.resolve([row("a"), row("b")]);
    await flush();
    expect(rowBtn(root, "b").getAttribute("aria-current")).toBe("true");
    expect(rowBtn(root, "a").hasAttribute("aria-current")).toBe(false);
    expect(document.activeElement).toBe(rowBtn(root, "b"));
  });

  it("does not announce a queue refresh as loading, but does announce a filter change or a retry", async () => {
    const root = await withQueue([row("a")]);
    await queueFrame();
    expect(statuses(root)[0]).toBe("1 report open or in review");
    lists.at(-1)!.resolve([row("a")]);
    await flush();

    typeInto(selectEl(root), "open");
    expect(statuses(root)[0]).toBe(t("list.loading"));
    lists.at(-1)!.reject(new Error("offline"));
    await flush();
    listRetry(root).click();
    expect(statuses(root)[0]).toBe(t("list.loading"));
  });

  it("reads only the queue when Try again is pressed with a report open", async () => {
    const root = await opened(detail("a"));
    await queueFrame();
    lists.at(-1)!.reject(new Error("offline"));
    await flush();
    listRetry(root).click();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    expect(details).toHaveLength(1);
  });

  it("keeps the open report when the filter changes to one that still lists it", async () => {
    const root = await opened(detail("a"));
    typeInto(selectEl(root), "open");
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    expect(details).toHaveLength(1);
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
  });

  it("ignores a queue answer for a filter that was replaced, whichever arrives last", async () => {
    const root = mount();
    typeInto(selectEl(root), "closed");
    lists[1]!.resolve([row("c", { state: "resolved", outcome: "actioned" })]);
    await flush();
    lists[0]!.resolve([row("stale")]);
    await flush();
    expect(rows(root).map((b) => b.dataset.reportId)).toEqual(["c"]);
    expect(statuses(root)[0]).toBe("1 closed report");
  });

  it("ignores a queue failure for a filter that was replaced", async () => {
    const root = mount();
    typeInto(selectEl(root), "closed");
    lists[1]!.resolve([row("c")]);
    await flush();
    lists[0]!.reject(new Error("offline"));
    await flush();
    expect(alerts(root)).toBe("");
    expect(listRetry(root).hidden).toBe(true);
    expect(statuses(root)[0]).toBe("1 closed report");
  });

  it("clears the busy mark and the old count when a refresh fails", async () => {
    const root = await withQueue([row("a")]);
    const list = q<HTMLElement>(root, "ul.mod-queue")!;
    await queueFrame();
    expect(list.getAttribute("aria-busy")).toBe("true");
    lists.at(-1)!.reject(new Error("offline"));
    await flush();
    expect(list.hasAttribute("aria-busy")).toBe(false);
    expect(statuses(root)[0]).toBe("");
    expect(alerts(root)).toBe(t("list.error"));
    expect(listRetry(root).hidden).toBe(false);
  });

  it("stops filter and retry controls once the view is closed", async () => {
    const root = mount();
    lists[0]!.reject(new Error("offline"));
    await flush();
    const select = selectEl(root);
    const retry = listRetry(root);
    view.abort();
    select.value = "closed";
    select.dispatchEvent(new Event("change"));
    retry.click();
    expect(lists).toHaveLength(1);
  });
});

describe("a report's detail", () => {
  it("shows the loading state, then clears it and the busy mark", async () => {
    const root = await withQueue([row("a")]);
    const slot = q<HTMLElement>(root, ".mod-report-slot")!;
    rowBtn(root, "a").click();
    expect(statuses(root)[1]).toBe(t("detail.loading"));
    expect(slot.getAttribute("aria-busy")).toBe("true");
    details[0]!.resolve(detail("a"));
    await flush();
    expect(statuses(root)[1]).toBe("");
    expect(slot.hasAttribute("aria-busy")).toBe(false);
  });

  it("empties the slot while the next report loads", async () => {
    const root = await withQueue([row("a"), row("b")]);
    rowBtn(root, "a").click();
    details[0]!.resolve(detail("a"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    rowBtn(root, "b").click();
    expect(q(root, "[data-testid=mod-report]")).toBeNull();
    expect(statuses(root)[1]).toBe(t("detail.loading"));
  });

  it("offers Try again after a failed read, and reads again with focus on retry", async () => {
    const root = await withQueue([row("a")]);
    const slot = q<HTMLElement>(root, ".mod-report-slot")!;
    rowBtn(root, "a").click();
    details[0]!.reject(new Error("offline"));
    await flush();
    expect(alerts(root)).toBe(t("detail.error"));
    expect(statuses(root)[1]).toBe("");
    expect(slot.hasAttribute("aria-busy")).toBe(false);
    expect(detailRetry(root).hidden).toBe(false);

    detailRetry(root).click();
    expect(details).toHaveLength(2);
    expect(detailRetry(root).hidden).toBe(true);
    expect(alerts(root)).toBe("");
    expect(statuses(root)[1]).toBe(t("detail.loading"));
    details[1]!.resolve(detail("a"));
    await flush();
    expect(detailRetry(root).hidden).toBe(true);
    expect(document.activeElement).toBe(heading(root));
  });

  it("puts focus on the report when a background read succeeds after a failed one", async () => {
    const root = await opened(detail("a"));
    await queueFrame();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    details.at(-1)!.reject(new Error("offline"));
    await flush();
    expect(document.activeElement).toBe(detailRetry(root));
    await queueFrame();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    details.at(-1)!.resolve(detail("a"));
    await flush();
    expect(document.activeElement).toBe(heading(root));
  });

  it("does not pull focus to the report when the reader moved on while it loaded", async () => {
    const root = await withQueue([row("a")]);
    rowBtn(root, "a").click();
    selectEl(root).focus();
    details[0]!.resolve(detail("a"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    expect(document.activeElement).toBe(selectEl(root));
  });

  it("does not move focus to Try again when a failed read had nothing of the reader's focused", async () => {
    const root = await withQueue([row("a")]);
    rowBtn(root, "a").click();
    selectEl(root).focus();
    details[0]!.reject(new Error("offline"));
    await flush();
    expect(detailRetry(root).hidden).toBe(false);
    expect(document.activeElement).toBe(selectEl(root));
  });

  it("leaves focus where the reader put it when a background read succeeds", async () => {
    const root = await opened(detail("a"));
    selectEl(root).focus();
    await queueFrame();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    details.at(-1)!.resolve(detail("a"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    expect(document.activeElement).toBe(selectEl(root));
  });

  it("keeps the newer answer when an older read of the same report lands late", async () => {
    const root = await withQueue([row("a")]);
    rowBtn(root, "a").click();
    await queueFrame();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    expect(details).toHaveLength(2);
    details[1]!.resolve(detail("a", { state: "assigned", assignee_id: 9 }));
    await flush();
    details[0]!.resolve(detail("a", { state: "open" }));
    await flush();
    expect(q(root, "[data-testid=mod-report]")?.textContent).toContain("In review");
  });

  it("ignores an older failed read of the same report once a newer one answered", async () => {
    const root = await withQueue([row("a")]);
    rowBtn(root, "a").click();
    await queueFrame();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    details[1]!.resolve(detail("a"));
    await flush();
    details[0]!.reject(new Error("offline"));
    await flush();
    expect(alerts(root)).toBe("");
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
  });

  it("clears the busy mark and the loading text when the report is gone", async () => {
    const root = await withQueue([row("a")]);
    const slot = q<HTMLElement>(root, ".mod-report-slot")!;
    rowBtn(root, "a").click();
    details[0]!.reject(new ApiClientError(404, "NOT_FOUND", "report not found"));
    await flush();
    expect(slot.hasAttribute("aria-busy")).toBe(false);
    expect(statuses(root)[1]).toBe(t("detail.notFound"));
    // The queue is read again quietly.
    expect(lists).toHaveLength(2);
    expect(statuses(root)[0]).not.toBe(t("list.loading"));
  });

  it("clears the loading text and the busy mark when a report fails for another reason", async () => {
    const root = await withQueue([row("a")]);
    rowBtn(root, "a").click();
    details[0]!.reject(new ApiClientError(500, "INTERNAL", "boom"));
    await flush();
    expect(statuses(root)[1]).toBe("");
    expect(alerts(root)).toBe(t("detail.error"));
  });

  it("closes on Escape only, and not when something else already handled it", async () => {
    const root = await opened(detail("a"));
    const h = heading(root)!;
    h.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();

    h.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
    h.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
  });

  it("closes to the row it was opened from, whichever row that is, and says nothing", async () => {
    const root = await withQueue([row("a"), row("b")]);
    rowBtn(root, "b").click();
    details.at(-1)!.resolve(detail("b"));
    await flush();
    // Focus is elsewhere: closing still returns it to the row.
    selectEl(root).focus();
    heading(root)!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(q(root, "[data-testid=mod-report]")).toBeNull();
    expect(statuses(root)[1]).toBe("");
    expect(document.activeElement).toBe(rowBtn(root, "b"));
  });

  it("focuses the report instead of reading it again when its row is chosen twice", async () => {
    const root = await opened(detail("a"));
    selectEl(root).focus();
    rowBtn(root, "a").click();
    expect(details).toHaveLength(1);
    expect(document.activeElement).toBe(heading(root));
  });

  it("hands focus to the list when the open report leaves it, only if focus was in the report", async () => {
    const root = await opened(detail("a"));
    selectEl(root).focus();
    await queueFrame();
    lists.at(-1)!.resolve([row("b")]);
    await flush();
    expect(q(root, "[data-testid=mod-report]")).toBeNull();
    expect(document.activeElement).toBe(selectEl(root));
  });

  it("hands focus to the list when the retry button held it as the report left", async () => {
    const root = await opened(detail("a"));
    await queueFrame();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    details.at(-1)!.reject(new Error("offline"));
    await flush();
    expect(document.activeElement).toBe(detailRetry(root));
    await queueFrame();
    lists.at(-1)!.resolve([row("b")]);
    await flush();
    expect(detailRetry(root).hidden).toBe(true);
    expect(statuses(root)[1]).toBe(t("detail.gone"));
    expect(document.activeElement).toBe(rowBtn(root, "b"));
  });

  it("clears an open report and its unsaved reasons when it is closed, so they do not come back", async () => {
    const root = await opened(held("a"));
    typeInto(focusEl(root, "warn"), "half-written");
    heading(root)!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    rowBtn(root, "a").click();
    details.at(-1)!.resolve(held("a"));
    await flush();
    expect(focusEl(root, "warn").value).toBe("");
  });

  it("keeps the reasons typed on a report across a failed read and a second click on its row", async () => {
    const root = await opened(held("a"));
    typeInto(focusEl(root, "warn"), "half-written");
    typeInto(q(root, "[data-testid=mod-note-input]"), "half a note");
    await queueFrame();
    lists.at(-1)!.resolve([heldRow("a")]);
    await flush();
    details.at(-1)!.reject(new Error("offline"));
    await flush();
    rowBtn(root, "a").click();
    details.at(-1)!.resolve(held("a"));
    await flush();
    expect(focusEl(root, "warn").value).toBe("half-written");
    expect(q<HTMLTextAreaElement>(root, "[data-testid=mod-note-input]")!.value).toBe("half a note");
  });

  it("does not hand one report's unsaved note or reasons to another", async () => {
    const root = await withQueue([heldRow("a"), heldRow("b")]);
    rowBtn(root, "a").click();
    details.at(-1)!.resolve(held("a"));
    await flush();
    typeInto(focusEl(root, "warn"), "for a");
    typeInto(q(root, "[data-testid=mod-note-input]"), "note for a");
    rowBtn(root, "b").click();
    details.at(-1)!.resolve(held("b"));
    await flush();
    rowBtn(root, "a").click();
    details.at(-1)!.resolve(held("a"));
    await flush();
    expect(focusEl(root, "warn").value).toBe("");
    expect(q<HTMLTextAreaElement>(root, "[data-testid=mod-note-input]")!.value).toBe("");
  });

  it("offers nothing on someone's report to a reader with no signed-in user", async () => {
    authStore.setState((prev) => ({ ...prev, user: null }));
    const root = await opened(detail("a", { assignee_id: 1, state: "assigned" }));
    expect(q(root, "[data-testid=mod-note-input]")).toBeNull();
    expect(q(root, "[data-testid=mod-act]")).toBeNull();
  });
});

describe("a refusal", () => {
  it("moves focus to the view's title only when it was inside the view", async () => {
    const root = await withQueue([row("a"), row("b")]);
    rowBtn(root, "a").focus();
    rowBtn(root, "b").click();
    details.at(-1)!.reject(new ApiClientError(403, "FORBIDDEN", "missing MODERATE_MEMBERS"));
    await flush();
    expect(document.activeElement).toBe(q(document.body, ".feature-view-title"));
  });

  it("leaves focus alone when it was outside the view", async () => {
    const root = await withQueue([row("a")]);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    rowBtn(root, "a").click();
    details.at(-1)!.reject(new ApiClientError(403, "FORBIDDEN", "missing MODERATE_MEMBERS"));
    await flush();
    expect(document.activeElement).toBe(outside);
  });

  it("hides every control and empties the live regions", async () => {
    const root = await opened(detail("a"));
    await queueFrame();
    lists.at(-1)!.reject(new ApiClientError(403, "FORBIDDEN", "missing MODERATE_MEMBERS"));
    await flush();
    expect(q<HTMLElement>(root, "ul.mod-queue")!.hidden).toBe(true);
    expect(listRetry(root).hidden).toBe(true);
    expect(detailRetry(root).hidden).toBe(true);
    expect(statuses(root)).toEqual(["", "", ""]);
    expect(alerts(root)).toBe(t("denied"));
  });
});

describe("re-reads", () => {
  it("does not announce a re-read from mod_queue as loading", async () => {
    const root = await withQueue([row("a")]);
    await queueFrame();
    expect(statuses(root)[0]).not.toBe(t("list.loading"));
  });

  it("reads the open report again on a reconnect, and not while reconnecting", async () => {
    setConnectionStatus("connected");
    uiStore.flush();
    const root = await opened(detail("a"));
    setConnectionStatus("reconnecting");
    uiStore.flush();
    expect(lists).toHaveLength(1);
    setConnectionStatus("connected");
    uiStore.flush();
    expect(lists).toHaveLength(2);
    expect(statuses(root)[0]).not.toBe(t("list.loading"));
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    expect(details).toHaveLength(2);
  });

  it("reads the open report again on mod_queue, in the background", async () => {
    await opened(detail("a"));
    await queueFrame();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    expect(details).toHaveLength(2);
    expect(details[1]!.arg).toBe("a");
  });
});

describe("what the actions send and how a failure reads", () => {
  it.each([
    ["only spaces", "   ", ""],
    ["words", "real words", t("draft.lost")],
  ])("tells the reader about a discarded note holding %s as it should", async (_, text, shown) => {
    const root = await opened(held("a"));
    typeInto(q(root, "[data-testid=mod-note-input]"), text);
    await queueFrame();
    await reread(detail("a", { state: "assigned", assignee_id: 99 }));
    expect(alerts(root)).toBe(shown);
  });

  it.each([
    ["only spaces", "  ", ""],
    ["words", "real words", t("act.draftLost")],
  ])("tells the reader about discarded reasons holding %s as it should", async (_, text, shown) => {
    const root = await opened(held("a"));
    typeInto(focusEl(root, "warn"), text);
    await queueFrame();
    await reread(detail("a", { state: "assigned", assignee_id: 99 }));
    expect(alerts(root)).toBe(shown);
  });

  it("keeps a typed note through a rebuild that still takes notes", async () => {
    const root = await opened(held("a"));
    typeInto(q(root, "[data-testid=mod-note-input]"), "keep me");
    await queueFrame();
    await reread(held("a"));
    expect(q<HTMLTextAreaElement>(root, "[data-testid=mod-note-input]")!.value).toBe("keep me");
    expect(alerts(root)).toBe("");
  });

  it("keeps a typed caret in a text field and in a number field across a rebuild", async () => {
    const root = await opened(held("a"));
    const warn = focusEl(root, "warn");
    typeInto(warn, "abcdef");
    warn.focus();
    warn.setSelectionRange(1, 3);
    await queueFrame();
    await reread(held("a"));
    const again = focusEl(root, "warn");
    expect(document.activeElement).toBe(again);
    expect([again.selectionStart, again.selectionEnd]).toEqual([1, 3]);

    const amount = focusEl(root, "amount");
    typeInto(amount, "12");
    amount.focus();
    await queueFrame();
    await reread(held("a"));
    expect(document.activeElement).toBe(focusEl(root, "amount"));
    expect(focusEl(root, "amount").value).toBe("12");
  });

  it.each([
    ["warning", 403, "SELF_REVIEW", "you sent this report", t("write.selfReview")],
    ["warning", 403, "FORBIDDEN", "cannot moderate", t("act.refused")],
    ["timeout", 403, "FORBIDDEN", "cannot moderate", t("act.refused")],
    ["kick", 403, "FORBIDDEN", "cannot moderate", t("act.refusedEnforce")],
    ["ban", 403, "FORBIDDEN", "cannot moderate", t("act.refusedEnforce")],
    ["removal", 403, "FORBIDDEN", "", t("act.unknown")],
    ["removal", 403, "INTERNAL_ERROR", "boom", t("act.unknown")],
    [
      "removal",
      403,
      "FORBIDDEN",
      "forbidden: blocked",
      t("act.invalid", { message: "Forbidden: blocked" }),
    ],
    [
      "warning",
      400,
      "INVALID_INPUT",
      "reason too long",
      t("act.invalid", { message: "Reason too long" }),
    ],
    ["warning", 400, "INTERNAL_ERROR", "boom", t("act.unknown")],
    ["warning", 400, "INVALID_INPUT", "", t("act.unknown")],
    ["warning", 500, "TEAPOT", "short and stout", "Short and stout"],
    ["warning", 409, "ALREADY_DELETED", "gone", t("act.alreadyDeleted")],
  ] as const)(
    "shows a %s answered %i %s %j as the matching text",
    async (kind, status, code, message, shown) => {
      grantAll();
      const root = await opened(held("a"));
      fillAll(root, "a");
      trigger(root, kind);
      writes[0]!.reject(new ApiClientError(status, code, message));
      await flush();
      expect(alerts(root)).toBe(shown);
      expect(statuses(root)[2]).toBe("");
    },
  );

  it("does not read a failed lift as nothing to lift unless the server said it was gone", async () => {
    const root = await opened(
      held("a", {
        actions: [
          {
            id: 11,
            kind: "timeout",
            actor_id: ME,
            reason: "cool off",
            created_at: "2026-09-05 11:00:00",
            expires_at: "2999-01-01T00:00:00Z",
          },
        ],
      }),
    );
    const lift = [...q(root, "[data-testid=mod-act]")!.querySelectorAll("button")].find(
      (b) => b.textContent === t("act.lift"),
    )!;
    lift.click();
    writes[0]!.reject(new ApiClientError(500, "INTERNAL", "boom"));
    await flush();
    expect(alerts(root)).toBe(t("act.unknown"));
  });
});

describe("what a finished write leaves behind", () => {
  it.each(["note", "warning", "timeout", "removal", "kick", "ban"] as const)(
    "clears only the field a %s used",
    async (kind) => {
      grantAll();
      const root = await opened(held("a"));
      fillAll(root, "a");
      trigger(root, kind);
      writes[0]!.resolve(undefined);
      await flush();
      await reread(held("a"));
      const cleared: Record<Kind, string[]> = {
        note: ["note"],
        warning: ["warn"],
        timeout: ["reason", "amount"],
        removal: ["enforce"],
        kick: ["enforce"],
        ban: ["enforce"],
      };
      const expected = {
        note: "note-a",
        warn: "warn-a",
        reason: "reason-a",
        amount: "6",
        enforce: "enforce-a",
      };
      for (const field of cleared[kind]) expected[field as keyof typeof expected] = "";
      expect(fieldValues(root)).toEqual(expected);
    },
  );

  it.each(["note", "warning", "timeout", "removal", "kick", "ban"] as const)(
    "leaves another report's typed fields alone when a %s on this one lands after it was left",
    async (kind) => {
      grantAll();
      const root = await withQueue([heldRow("a"), heldRow("b")]);
      rowBtn(root, "a").click();
      details.at(-1)!.resolve(held("a"));
      await flush();
      fillAll(root, "a");
      trigger(root, kind);
      rowBtn(root, "b").click();
      details.at(-1)!.resolve(held("b"));
      await flush();
      fillAll(root, "b");
      const listReads = lists.length;
      const detailReads = details.length;

      writes[0]!.resolve(undefined);
      await flush();
      expect(lists).toHaveLength(listReads);
      expect(details).toHaveLength(detailReads);
      expect(statuses(root)[2]).toBe("");

      await queueFrame();
      lists.at(-1)!.resolve([heldRow("a"), heldRow("b")]);
      await flush();
      details.at(-1)!.resolve(held("b"));
      await flush();
      expect(fieldValues(root)).toEqual({
        note: "note-b",
        warn: "warn-b",
        reason: "reason-b",
        amount: "6",
        enforce: "enforce-b",
      });

      // The write that finished for the other report no longer blocks this one.
      submitOf(focusEl(root, "warn"));
      expect(writes).toHaveLength(2);
    },
  );

  it("lets the next write through after a failure for a report that was left", async () => {
    const root = await withQueue([heldRow("a"), heldRow("b")]);
    rowBtn(root, "a").click();
    details.at(-1)!.resolve(held("a"));
    await flush();
    typeInto(focusEl(root, "warn"), "x");
    submitOf(focusEl(root, "warn"));
    rowBtn(root, "b").click();
    details.at(-1)!.resolve(held("b"));
    await flush();
    const listReads = lists.length;
    const detailReads = details.length;
    writes[0]!.reject(new ApiClientError(500, "INTERNAL", "boom"));
    await flush();
    expect(alerts(root)).toBe("");
    expect(lists).toHaveLength(listReads);
    expect(details).toHaveLength(detailReads);
    typeInto(focusEl(root, "warn"), "y");
    submitOf(focusEl(root, "warn"));
    expect(writes).toHaveLength(2);
  });

  it("clears the last answer when another report is chosen", async () => {
    const root = await withQueue([heldRow("a"), heldRow("b")]);
    rowBtn(root, "a").click();
    details.at(-1)!.resolve(held("a"));
    await flush();
    typeInto(focusEl(root, "warn"), "x");
    submitOf(focusEl(root, "warn"));
    writes[0]!.resolve(undefined);
    await flush();
    expect(statuses(root)[2]).toBe(t("done.warning"));
    rowBtn(root, "b").click();
    expect(statuses(root)[2]).toBe("");
  });

  it("reads the queue again quietly after a write", async () => {
    const root = await opened(held("a"));
    typeInto(focusEl(root, "warn"), "x");
    submitOf(focusEl(root, "warn"));
    writes[0]!.resolve(undefined);
    await flush();
    expect(statuses(root)[0]).not.toBe(t("list.loading"));
    expect(lists).toHaveLength(2);
  });

  it("tells a typed note it was discarded when a refused close left the report closed", async () => {
    const root = await opened(held("a"));
    typeInto(q(root, "[data-testid=mod-note-input]"), "unsaved words");
    q<HTMLInputElement>(root, "input[value=no_action]")!.click();
    submitOf(q(root, "[data-focus=close]"));
    writes[0]!.reject(new ApiClientError(409, "CONFLICT", "already closed"));
    await flush();
    await reread(detail("a", { state: "resolved", outcome: "no_action" }));
    expect(alerts(root)).toBe(t("draft.lost"));
  });

  it("ignores a refusal of a write after the view is closed", async () => {
    const root = await opened(held("a"));
    const failure = alertEls(root)[0]!;
    typeInto(q(root, "[data-testid=mod-note-input]"), "words");
    submitOf(q(root, "[data-testid=mod-note-input]"));
    view.abort();
    writes[0]!.reject(new ApiClientError(403, "FORBIDDEN", "missing MODERATE_MEMBERS"));
    await flush();
    expect(failure.textContent).toBe("");
  });

  it("closes a report another moderator deleted and reads the queue quietly", async () => {
    const root = await opened(held("a"));
    typeInto(q(root, "[data-testid=mod-note-input]"), "too late");
    submitOf(q(root, "[data-testid=mod-note-input]"));
    writes[0]!.reject(new ApiClientError(404, "NOT_FOUND", "report not found"));
    await flush();
    expect(statuses(root)[1]).toBe(t("detail.notFound"));
    expect(lists).toHaveLength(2);
    expect(statuses(root)[0]).not.toBe(t("list.loading"));
  });
});

async function taken(): Promise<HTMLElement> {
  const root = await opened(detail("a"));
  q<HTMLButtonElement>(root, "[data-focus=assign]")!.click();
  writes[0]!.resolve(undefined);
  await flush();
  return root;
}

describe("a report the reader's own write moved out of the filter", () => {
  it("keeps it open and says so once, even when a failed read had cleared the message", async () => {
    const root = await taken();
    const reads = details.length;
    lists.at(-1)!.resolve([]);
    await flush();
    expect(statuses(root)[1]).toBe(t("detail.leftFilter"));
    expect(details).toHaveLength(reads);
    details.at(-1)!.reject(new Error("offline"));
    await flush();
    expect(statuses(root)[1]).toBe("");
    await queueFrame();
    lists.at(-1)!.resolve([]);
    await flush();
    expect(statuses(root)[1]).toBe("");
    expect(details).toHaveLength(reads + 1);
  });

  it("keeps it open through a later failed write", async () => {
    const root = await taken();
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(held("a"));
    await flush();
    typeInto(q(root, "[data-testid=mod-note-input]"), "a note");
    submitOf(q(root, "[data-testid=mod-note-input]"));
    writes[1]!.reject(new ApiClientError(500, "INTERNAL", "boom"));
    await flush();
    expect(alerts(root)).toBe(t("write.error"));
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(held("a"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    expect(statuses(root)[1]).not.toBe(t("detail.gone"));
  });

  it("withdraws the note about leaving the filter when the write that seemed to cause it failed", async () => {
    const root = await opened(detail("a"));
    q<HTMLButtonElement>(root, "[data-focus=assign]")!.click();
    await queueFrame();
    lists.at(-1)!.resolve([]);
    await flush();
    expect(statuses(root)[1]).toBe(t("detail.leftFilter"));
    writes[0]!.reject(new ApiClientError(500, "INTERNAL", "boom"));
    await flush();
    expect(statuses(root)[1]).toBe("");
    expect(alerts(root)).toBe(t("write.error"));
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(detail("a"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).toBeNull();
    expect(statuses(root)[1]).toBe(t("detail.gone"));
  });

  it("keeps the exemption for a write that is still being sent across several queue reads", async () => {
    const root = await opened(detail("a"));
    q<HTMLButtonElement>(root, "[data-focus=assign]")!.click();
    await queueFrame();
    lists.at(-1)!.resolve([row("a")]);
    await flush();
    await queueFrame();
    lists.at(-1)!.resolve([]);
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    expect(statuses(root)[1]).toBe(t("detail.leftFilter"));
  });

  it("drops the memory of the old filter's exemption when the filter changes", async () => {
    const root = await taken();
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(held("a"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    typeInto(selectEl(root), "closed");
    lists.at(-1)!.resolve([]);
    await flush();
    expect(q(root, "[data-testid=mod-report]")).toBeNull();
    expect(statuses(root)[1]).toBe(t("detail.gone"));
  });
});

describe("a report opened by id from an appeal", () => {
  const appealRow = {
    id: "ap1",
    action_id: 11,
    appellant_id: 9,
    state: "open",
    assignee_id: 0,
    created_at: "2026-09-20 10:00:00",
    decided_at: null,
  };
  const appealDetail = {
    ...appealRow,
    body: "Please reconsider.",
    decided_by: 0,
    decision_note: "",
    report_id: "r-pub",
    action: {
      id: 11,
      kind: "timeout",
      actor_id: 8,
      reason: "flooding",
      created_at: "2026-09-19 10:00:00",
      expires_at: "2099-01-01 00:00:00",
    },
  };

  async function viaAppeal(root: HTMLElement): Promise<void> {
    tabEls(root)[1]!.click();
    appealLists.at(-1)!.resolve([appealRow]);
    await flush();
    q<HTMLButtonElement>(root, "[data-testid=mod-appeal-row]")!.click();
    appealDetails.at(-1)!.resolve(appealDetail);
    await flush();
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Open the report")!.click();
  }

  it("returns to the Reports tab and keeps the report open before it has loaded, through a queue read", async () => {
    const root = mount();
    lists[0]!.resolve([]);
    await flush();
    await viaAppeal(root);
    expect(tabEls(root)[0]!.getAttribute("aria-selected")).toBe("true");
    // A queue answer lands while the report is still being read.
    await queueFrame();
    lists.at(-1)!.resolve([]);
    await flush();
    details.at(-1)!.resolve(detail("r-pub"));
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
  });

  it("takes the names from the queue's own row once the linked report is listed", async () => {
    const root = mount();
    lists[0]!.resolve([]);
    await flush();
    await viaAppeal(root);
    details.at(-1)!.resolve(detail("r-pub"));
    await flush();
    await queueFrame();
    lists.at(-1)!.resolve([row("r-pub", { subject_name: "listed-name" })]);
    await flush();
    details.at(-1)!.resolve(detail("r-pub"));
    await flush();
    expect(q(root, ".mod-report-facts dd")?.textContent).toBe("listed-name");
    // It was opened by id: leaving the list later does not close it.
    await queueFrame();
    lists.at(-1)!.resolve([]);
    await flush();
    expect(q(root, "[data-testid=mod-report]")).not.toBeNull();
    expect(statuses(root)[1]).toBe(t("detail.leftFilter"));
  });

  it("is an ordinary report once it is listed: it closes when the list no longer has it", async () => {
    const root = mount();
    lists[0]!.resolve([row("r-pub")]);
    await flush();
    await viaAppeal(root);
    details.at(-1)!.resolve(detail("r-pub"));
    await flush();
    await queueFrame();
    lists.at(-1)!.resolve([]);
    await flush();
    expect(q(root, "[data-testid=mod-report]")).toBeNull();
    expect(statuses(root)[1]).toBe(t("detail.gone"));
  });
});

describe("consent withdrawn from a shown report", () => {
  it("does not rebuild the report for a store change that leaves its evidence alone", async () => {
    const root = await opened(
      detail("a", {
        channel_id: SPICY,
        evidence: [
          {
            seq: 0,
            author_id: 2,
            content: "evidence of a",
            attachments: "[]",
            captured_at: "2026-09-05 10:00:00",
          },
        ],
      }),
    );
    const before = q(root, "[data-testid=mod-report]");
    setChannels([
      {
        id: SPICY,
        name: "spicier",
        type: "text",
        category: null,
        position: 0,
        nsfw: true,
        nsfw_acknowledged: true,
      },
    ]);
    await flush();
    expect(q(root, "[data-testid=mod-report]")).toBe(before);
  });

  it("does not move focus when consent is withdrawn", async () => {
    const root = await opened(detail("a", { channel_id: SPICY }));
    selectEl(root).focus();
    setNsfwAcknowledged(SPICY, false);
    await flush();
    expect(q(root, "[data-testid=mod-report]")?.textContent).toContain("age-restricted channel");
    expect(document.activeElement).toBe(selectEl(root));
  });
});

describe("a change of role", () => {
  it("offers or withdraws actions as the reader's roles change, whichever role ids move", async () => {
    setRoles([
      { id: 1, name: "One", color: null, permissions: Permission.MODERATE_MEMBERS },
      { id: 2, name: "Two", color: null, permissions: Permission.MODERATE_MEMBERS },
      { id: 12, name: "Twelve", color: null, permissions: Permission.KICK_MEMBERS },
    ]);
    authStore.setState((prev) => ({
      ...prev,
      user: { id: ME, username: "bob", avatar: null, role: "moderator", role_ids: [1, 2] },
    }));
    const root = await opened(held("a"));
    const labels = () =>
      [...q(root, "[data-testid=mod-act]")!.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels()).not.toContain("Log out of every session");
    authStore.setState((prev) => ({
      ...prev,
      user: { id: ME, username: "bob", avatar: null, role: "moderator", role_ids: [12] },
    }));
    await flush();
    expect(labels()).toContain("Log out of every session");
    authStore.setState((prev) => ({
      ...prev,
      user: { id: ME, username: "bob", avatar: null, role: "moderator", role_ids: [1, 2] },
    }));
    await flush();
    expect(labels()).not.toContain("Log out of every session");
  });

  it("keeps a write's controls disabled while it is being sent, and focus where it was", async () => {
    const root = await opened(held("a"));
    typeInto(focusEl(root, "warn"), "x");
    submitOf(focusEl(root, "warn"));
    expect(focusEl(root, "warn-submit").getAttribute("aria-disabled")).toBe("true");
    selectEl(root).focus();
    grantAll();
    await flush();
    expect(focusEl(root, "warn-submit").getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(selectEl(root));
  });

  it("rebuilds the report without taking focus", async () => {
    const root = await opened(held("a"));
    selectEl(root).focus();
    grantAll();
    await flush();
    expect(
      [...q(root, "[data-testid=mod-act]")!.querySelectorAll("button")].map((b) => b.textContent),
    ).toContain("Remove reported message");
    expect(document.activeElement).toBe(selectEl(root));
  });
});
