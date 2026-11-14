// The list and detail logic the report and appeal tabs share, checked through
// each tab: a detail answer for a row the reader has left is dropped, and
// focus only follows the answer while the reader is still where they asked.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiClient, ModerationQueueRow, ModerationReportDetail } from "@lib/api";
import { authStore } from "@stores/auth.store";
import type { FeatureViewContext } from "../navigation/destinations";
import {
  detail as appealDetail,
  flush,
  h,
  loaded as appealsLoaded,
  resetHarness,
  row as appealRow,
  rows as appealRows,
  teardownHarness,
} from "../../../tests/helpers/appeal-harness";
import { renderReports } from "./ReportsView";

interface Held<T> {
  readonly id: string;
  readonly signal: AbortSignal | undefined;
  resolve: (v: T) => void;
}

let reportLists: Held<ModerationQueueRow[]>[];
let reportDetails: Held<ModerationReportDetail>[];
let view: AbortController;

const held = <T>(bucket: Held<T>[], id: string, signal?: AbortSignal): Promise<T> =>
  new Promise<T>((resolve) => bucket.push({ id, signal, resolve }));

const api = {
  getModerationQueue: (state: string, signal?: AbortSignal) => held(reportLists, state, signal),
  getModerationReport: (id: string, signal?: AbortSignal) => held(reportDetails, id, signal),
} as unknown as ApiClient;

function reportRow(id: string): ModerationQueueRow {
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
  };
}

function reportDetail(id: string): ModerationReportDetail {
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
  };
}

async function reportsLoaded(ids: string[]): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const ctx: FeatureViewContext = { signal: view.signal, close: () => {}, api };
  renderReports(root, ctx, () => {});
  reportLists.at(-1)!.resolve(ids.map(reportRow));
  await flush();
  return root;
}

const reportRows = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLButtonElement>("[data-testid=mod-queue-row]"),
];
const slotOf = (root: HTMLElement) => root.querySelector<HTMLElement>("div.mod-report-slot")!;
const detailStatusOf = (root: HTMLElement) =>
  root.querySelector<HTMLElement>("ul.mod-queue ~ p.mod-center-status")!;

beforeEach(() => {
  reportLists = [];
  reportDetails = [];
  view = new AbortController();
  resetHarness();
  authStore.setState((s) => ({
    ...s,
    user: { id: 7, username: "mod", avatar: null, role: "moderator" },
  }));
});

afterEach(() => {
  view.abort();
  teardownHarness();
});

interface Tab {
  readonly name: string;
  /** Mount with rows `a` and `b`; returns the view root. */
  readonly mount: () => Promise<HTMLElement>;
  readonly rows: (root: HTMLElement) => HTMLButtonElement[];
  /** The open detail requests, oldest first. */
  readonly requests: () => { id: string; signal: AbortSignal | undefined }[];
  /** Answer the `n`th detail request with the detail of its own id. */
  readonly answer: (n: number) => Promise<void>;
}

const tabs: Tab[] = [
  {
    name: "reports",
    mount: () => reportsLoaded(["a", "b"]),
    rows: reportRows,
    requests: () => reportDetails,
    answer: async (n) => {
      reportDetails[n]!.resolve(reportDetail(reportDetails[n]!.id));
      await flush();
    },
  },
  {
    name: "appeals",
    mount: async () => (await appealsLoaded([appealRow("a"), appealRow("b")])).root,
    rows: appealRows,
    requests: () => h.details.map((d) => ({ id: d.arg, signal: d.signal })),
    answer: async (n) => {
      h.details[n]!.resolve(appealDetail(h.details[n]!.arg));
      await flush();
    },
  },
];

describe.each(tabs)("the $name tab's detail read", (tab) => {
  it("drops an answer for a row the reader has since left", async () => {
    const root = await tab.mount();
    tab.rows(root)[0]!.click();
    tab.rows(root)[1]!.click();
    const [first, second] = tab.requests();
    expect([first!.id, second!.id]).toEqual(["a", "b"]);
    expect(first!.signal!.aborted).toBe(true);

    await tab.answer(0);
    expect(slotOf(root).childElementCount).toBe(0);
    expect(tab.rows(root)[0]!.hasAttribute("aria-current")).toBe(false);

    await tab.answer(1);
    expect(slotOf(root).childElementCount).toBe(1);
    expect(tab.rows(root)[1]!.getAttribute("aria-current")).toBe("true");
    expect(slotOf(root).getAttribute("aria-busy")).toBeNull();
  });

  it("moves focus to the detail when the reader is still on the row they asked from", async () => {
    const root = await tab.mount();
    const row = tab.rows(root)[0]!;
    row.click();
    row.focus();
    expect(slotOf(root).getAttribute("aria-busy")).toBe("true");
    await tab.answer(0);
    expect(document.activeElement).toBe(slotOf(root).querySelector("h3"));
  });

  it("leaves focus where the reader went while the detail was loading", async () => {
    const root = await tab.mount();
    tab.rows(root)[0]!.click();
    const filter = root.querySelector<HTMLSelectElement>("select")!;
    filter.focus();
    expect(detailStatusOf(root).textContent).not.toBe("");
    await tab.answer(0);
    expect(slotOf(root).querySelector("h3")).not.toBeNull();
    expect(document.activeElement).toBe(filter);
    expect(detailStatusOf(root).textContent).toBe("");
  });
});
