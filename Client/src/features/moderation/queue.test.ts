// B9-11: the Moderation Center's queue and detail lifecycle. The server
// authorizes every read; the view renders only what came back for the filter
// and selection it asked about, and drops private content when the server
// refuses, consent is withdrawn or the view goes away.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  type ApiClient,
  type ModerationQueueRow,
  type ModerationReportDetail,
} from "@lib/api";
import type { ReadyChannel } from "@lib/types";
import { resetChannelsStore, setChannels, setNsfwAcknowledged } from "@stores/channels.store";
import { setConnectionStatus, uiStore } from "@stores/ui.store";
import type { FeatureViewContext } from "../navigation/destinations";
import { renderModerationCenter } from "./Queue";
import { noteQueueChange } from "./store";
import { buildModerationCenter } from "./view";

const SPICY = 7;

interface Call<T> {
  readonly arg: string;
  readonly signal: AbortSignal | undefined;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

let lists: Call<ModerationQueueRow[]>[];
let details: Call<ModerationReportDetail>[];
let acks: number[];
let ackResult: Promise<void>;
let view: AbortController;
let closed: number;

function deferred<T>(bucket: Call<T>[], arg: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => bucket.push({ arg, signal, resolve, reject }));
}

const api = {
  getModerationQueue: (state: string, signal?: AbortSignal) => deferred(lists, state, signal),
  getModerationReport: (id: string, signal?: AbortSignal) => deferred(details, id, signal),
  acknowledgeNsfw: (channelId: number) => {
    acks.push(channelId);
    return ackResult;
  },
} as unknown as ApiClient;

const flush = () => new Promise((r) => setTimeout(r, 0));

function row(id: string, over: Partial<ModerationQueueRow> = {}): ModerationQueueRow {
  return {
    id,
    reporter_name: "bob",
    subject_name: "alice",
    target_type: "message",
    target_ref: "42",
    reason: "spam",
    state: "open",
    assignee_id: 0,
    outcome: "",
    created_at: "2026-09-05T10:00:00Z",
    updated_at: "2026-09-05T10:00:00Z",
    ...over,
  };
}

function detail(id: string, over: Partial<ModerationReportDetail> = {}): ModerationReportDetail {
  return {
    id,
    reporter_id: 3,
    subject_id: 4,
    notes: [],
    events: [],
    actions: [],
    target_type: "message",
    reason: "spam",
    detail: "",
    state: "open",
    assignee_id: 0,
    outcome: "",
    created_at: "2026-09-05T10:00:00Z",
    evidence: [
      {
        seq: 0,
        author_id: 2,
        content: `evidence of ${id}`,
        attachments: "[]",
        captured_at: "2026-09-05T10:00:00Z",
      },
    ],
    ...over,
  };
}

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const ctx: FeatureViewContext = {
    signal: view.signal,
    close: () => {
      closed++;
    },
    api,
  };
  renderModerationCenter(root, ctx);
  return root;
}

const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLButtonElement>(".mod-queue-row")];
const status = (root: HTMLElement) => root.querySelector("[data-testid=mod-status]")!.textContent;
const alerts = (root: HTMLElement) =>
  [...root.querySelectorAll("[role=alert]")]
    .map((a) => a.textContent)
    .filter(Boolean)
    .join("|");

/** A mod_queue frame, as the dispatcher applies it. */
async function queueFrame(): Promise<void> {
  noteQueueChange();
  await flush();
}

async function withQueue(ids: string[]): Promise<HTMLElement> {
  const root = mount();
  lists.at(-1)!.resolve(ids.map((id) => row(id)));
  await flush();
  return root;
}

async function openReport(root: HTMLElement, id: string, d = detail(id)): Promise<void> {
  rows(root)
    .find((b) => b.dataset.reportId === id)!
    .click();
  details.at(-1)!.resolve(d);
  await flush();
}

beforeEach(() => {
  lists = [];
  details = [];
  acks = [];
  ackResult = Promise.resolve();
  closed = 0;
  view = new AbortController();
  resetChannelsStore();
  const spicy: ReadyChannel = {
    id: SPICY,
    name: "spicy",
    type: "text",
    category: null,
    position: 0,
    nsfw: true,
    nsfw_acknowledged: true,
  };
  setChannels([spicy]);
});

afterEach(() => {
  view.abort();
  document.body.replaceChildren();
});

describe("the queue", () => {
  it("reads the open-and-in-review queue, then shows the server's rows and count", async () => {
    const root = mount();
    expect(lists.map((c) => c.arg)).toEqual([""]);
    expect(status(root)).toBe("Loading reports…");
    expect(root.querySelector(".mod-queue")?.getAttribute("aria-busy")).toBe("true");

    lists[0]!.resolve([row("a"), row("b", { state: "assigned", subject_name: "" })]);
    await flush();
    expect(status(root)).toBe("2 reports open or in review");
    expect(rows(root).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Message reported for Spam. About alice, reported by bob. Waiting for review. Sent Sep 5, 2026, 10:00 AM",
      "Message reported for Spam. About Unknown account, reported by bob. In review. Sent Sep 5, 2026, 10:00 AM",
    ]);
    expect(details).toHaveLength(0);
  });

  it("filters by the server's states and drops a result for the previous filter", async () => {
    const root = mount();
    const select = root.querySelector<HTMLSelectElement>("[data-testid=mod-filter]")!;
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ["", "Open and in review"],
      ["open", "Waiting for review"],
      ["assigned", "In review"],
      ["closed", "Closed"],
    ]);
    expect(root.querySelector(`label[for="${select.id}"]`)?.textContent).toBe("Show");

    select.value = "closed";
    select.dispatchEvent(new Event("change"));
    expect(lists.map((c) => c.arg)).toEqual(["", "closed"]);
    expect(lists[0]!.signal?.aborted).toBe(true);
    lists[0]!.resolve([row("stale")]);
    lists[1]!.resolve([row("c", { state: "resolved", outcome: "actioned" })]);
    await flush();
    expect(status(root)).toBe("1 closed report");
    expect(rows(root).map((b) => b.dataset.reportId)).toEqual(["c"]);
  });

  it("offers Retry after a failed read", async () => {
    const root = mount();
    lists[0]!.reject(new Error("offline"));
    await flush();
    expect(alerts(root)).toContain("Couldn't load reports.");
    const retry = [...root.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    expect(retry.hidden).toBe(false);
    retry.focus();
    retry.click();
    lists[1]!.resolve([row("a")]);
    await flush();
    expect(retry.hidden).toBe(true);
    expect(document.activeElement).toBe(rows(root)[0]);
  });

  it("re-reads on mod_queue and on reconnect, since neither is replayed", async () => {
    const root = await withQueue(["a"]);
    await queueFrame();
    expect(lists).toHaveLength(2);
    lists[1]!.resolve([row("a"), row("b")]);
    await flush();
    expect(rows(root)).toHaveLength(2);
    // A queue refresh is not announced as loading.
    expect(status(root)).toBe("2 reports open or in review");

    setConnectionStatus("reconnecting");
    uiStore.flush();
    setConnectionStatus("connected");
    uiStore.flush();
    expect(lists).toHaveLength(3);
  });
});

describe("a report's detail", () => {
  it("loads on selection and takes focus once it is there", async () => {
    const root = await withQueue(["a", "b"]);
    const button = rows(root)[0]!;
    button.focus();
    button.click();
    expect(details.map((c) => c.arg)).toEqual(["a"]);
    expect(button.getAttribute("aria-current")).toBe("true");
    expect(root.textContent).toContain("Loading report…");
    details[0]!.resolve(detail("a"));
    await flush();
    const heading = root.querySelector(".mod-report h3");
    expect(document.activeElement).toBe(heading);
    expect(root.querySelector(".mod-evidence-text")?.textContent).toBe("evidence of a");
  });

  it("drops a detail that lands after another report was chosen", async () => {
    const root = await withQueue(["a", "b"]);
    rows(root)[0]!.click();
    rows(root)[1]!.click();
    expect(details[0]!.signal?.aborted).toBe(true);
    details[1]!.resolve(detail("b"));
    details[0]!.resolve(detail("a"));
    await flush();
    expect(root.querySelector(".mod-evidence-text")?.textContent).toBe("evidence of b");
    expect(root.textContent).not.toContain("evidence of a");
  });

  it("closes on Escape back to its row, without closing the view", async () => {
    const root = await withQueue(["a"]);
    await openReport(root, "a");
    const heading = root.querySelector<HTMLElement>(".mod-report h3")!;
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    heading.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(root.querySelector(".mod-report")).toBeNull();
    expect(document.activeElement).toBe(rows(root)[0]);
    expect(rows(root)[0]!.hasAttribute("aria-current")).toBe(false);
  });

  it("says so when a report is gone, and re-reads the queue", async () => {
    const root = await withQueue(["a"]);
    rows(root)[0]!.click();
    details[0]!.reject(new ApiClientError(404, "NOT_FOUND", "report not found"));
    await flush();
    expect(root.textContent).toContain("This report is no longer available.");
    expect(lists).toHaveLength(2);
  });

  it("closes the open report when a refresh no longer lists it", async () => {
    const root = await withQueue(["a"]);
    await openReport(root, "a");
    expect(document.activeElement?.tagName).toBe("H3");
    await queueFrame();
    lists[1]!.resolve([row("b")]);
    await flush();
    expect(root.querySelector(".mod-report")).toBeNull();
    expect(root.textContent).not.toContain("evidence of a");
    expect(root.textContent).toContain("The report you had open is no longer in this list.");
    // Focus stays in the view.
    expect(document.activeElement).toBe(rows(root)[0]);
  });

  it("re-reads the open report on mod_queue", async () => {
    const root = await withQueue(["a"]);
    await openReport(root, "a");
    await queueFrame();
    lists[1]!.resolve([row("a", { state: "assigned" })]);
    await flush();
    expect(details.map((c) => c.arg)).toEqual(["a", "a"]);
    details[1]!.resolve(detail("a", { state: "assigned", assignee_id: 9 }));
    await flush();
    expect(root.querySelector(".mod-report")?.textContent).toContain("In review");
  });

  it("keeps focus in the view when a background re-read of the open report fails", async () => {
    const root = await withQueue(["a"]);
    await openReport(root, "a");
    expect(document.activeElement?.tagName).toBe("H3");
    await queueFrame();
    lists[1]!.resolve([row("a")]);
    await flush();
    details[1]!.reject(new Error("offline"));
    await flush();
    expect(root.querySelector(".mod-report")).toBeNull();
    expect(alerts(root)).toContain("Couldn't load this report.");
    const retry = document.activeElement as HTMLButtonElement;
    expect(root.contains(retry)).toBe(true);
    expect(retry.textContent).toBe("Try again");
    expect(retry.hidden).toBe(false);
  });

  it("still takes focus when a mod_queue refresh replaces the read a click started", async () => {
    const root = await withQueue(["a"]);
    rows(root)[0]!.focus();
    rows(root)[0]!.click();
    await queueFrame();
    lists[1]!.resolve([row("a")]);
    await flush();
    expect(details.map((c) => c.arg)).toEqual(["a", "a"]);
    expect(details[0]!.signal?.aborted).toBe(true);
    details[1]!.resolve(detail("a"));
    await flush();
    expect(document.activeElement).toBe(root.querySelector(".mod-report h3"));
  });
});

describe("authority", () => {
  it("a viewer the server refuses sees no queue at all", async () => {
    const root = mount();
    lists[0]!.reject(new ApiClientError(403, "FORBIDDEN", "missing MODERATE_MEMBERS"));
    await flush();
    expect(rows(root)).toHaveLength(0);
    expect(alerts(root)).toBe("You no longer have permission to moderate on this server.");
    expect(root.querySelector<HTMLElement>(".mod-center-toolbar")?.hidden).toBe(true);
    // Nothing more is asked of the server after a refusal.
    await queueFrame();
    expect(lists).toHaveLength(1);
  });

  it("a refusal on a detail read clears every report already on screen", async () => {
    const root = await withQueue(["a", "b"]);
    await openReport(root, "a");
    rows(root)[1]!.click();
    details[1]!.reject(new ApiClientError(403, "FORBIDDEN", "missing MODERATE_MEMBERS"));
    await flush();
    expect(rows(root)).toHaveLength(0);
    expect(root.querySelector(".mod-report")).toBeNull();
    expect(root.textContent).not.toContain("evidence of a");
    expect(root.textContent).not.toContain("alice");
  });

  it("closing the view removes everything and drops late results", async () => {
    const root = await withQueue(["a"]);
    rows(root)[0]!.click();
    view.abort();
    expect(details[0]!.signal?.aborted).toBe(true);
    expect(root.childElementCount).toBe(0);
    details[0]!.resolve(detail("a"));
    await flush();
    expect(root.childElementCount).toBe(0);
    await queueFrame();
    expect(lists).toHaveLength(1);
  });
});

describe("NSFW consent", () => {
  it("withdrawing consent takes the evidence off screen at once", async () => {
    const root = await withQueue(["a"]);
    await openReport(root, "a", detail("a", { channel_id: SPICY }));
    expect(root.textContent).toContain("evidence of a");
    setNsfwAcknowledged(SPICY, false);
    await flush();
    expect(root.textContent).not.toContain("evidence of a");
    expect(root.textContent).toContain("age-restricted channel");
  });

  it("withheld evidence waits for the gate, and consent is recorded before it is read again", async () => {
    const root = await withQueue(["a"]);
    setNsfwAcknowledged(SPICY, false);
    await openReport(
      root,
      "a",
      detail("a", {
        channel_id: SPICY,
        evidence: [],
        evidence_withheld: "NSFW_ACKNOWLEDGEMENT_REQUIRED",
      }),
    );
    await vi.waitFor(() => expect(root.querySelector("[data-testid=nsfw-gate]")).not.toBeNull());
    expect(root.querySelector("[data-testid=nsfw-gate]")?.textContent).toContain("spicy");
    expect(details).toHaveLength(1);

    root.querySelector<HTMLButtonElement>("[data-testid=nsfw-gate-continue]")!.click();
    await flush();
    expect(acks).toEqual([SPICY]);
    expect(details.map((c) => c.arg)).toEqual(["a", "a"]);
    details[1]!.resolve(detail("a", { channel_id: SPICY }));
    await flush();
    expect(root.querySelector("[data-testid=nsfw-gate]")).toBeNull();
    expect(root.textContent).toContain("evidence of a");
  });

  it("an acknowledgement answered after another report was opened leaves that report alone", async () => {
    const root = await withQueue(["a", "b"]);
    setNsfwAcknowledged(SPICY, false);
    await openReport(
      root,
      "a",
      detail("a", {
        channel_id: SPICY,
        evidence: [],
        evidence_withheld: "NSFW_ACKNOWLEDGEMENT_REQUIRED",
      }),
    );
    await vi.waitFor(() => expect(root.querySelector("[data-testid=nsfw-gate]")).not.toBeNull());
    let acknowledge!: () => void;
    ackResult = new Promise<void>((r) => (acknowledge = r));
    root.querySelector<HTMLButtonElement>("[data-testid=nsfw-gate-continue]")!.click();
    await openReport(root, "b");
    expect(root.textContent).toContain("evidence of b");

    acknowledge();
    await flush();
    expect(acks).toEqual([SPICY]);
    expect(details.map((c) => c.arg)).toEqual(["a", "b"]);
    expect(root.textContent).toContain("evidence of b");
  });

  it("declining the gate closes the report", async () => {
    const root = await withQueue(["a"]);
    await openReport(
      root,
      "a",
      detail("a", {
        channel_id: SPICY,
        evidence: [],
        evidence_withheld: "NSFW_ACKNOWLEDGEMENT_REQUIRED",
      }),
    );
    await vi.waitFor(() => expect(root.querySelector("[data-testid=nsfw-gate]")).not.toBeNull());
    root.querySelector<HTMLButtonElement>("[data-testid=nsfw-gate-back]")!.click();
    expect(root.querySelector(".mod-report")).toBeNull();
    expect(acks).toEqual([]);
    expect(document.activeElement).toBe(rows(root)[0]);
  });
});

describe("the destination", () => {
  it("renders into its root once the chunk loads, and never after the view closed", async () => {
    const ctx = { signal: view.signal, close: () => closed++, api };
    const root = buildModerationCenter(ctx);
    expect(root.dataset.testid).toBe("mod-center");
    await vi.waitFor(() => expect(lists).toHaveLength(1));

    const late = new AbortController();
    late.abort();
    buildModerationCenter({ signal: late.signal, close: () => closed++, api });
    await flush();
    await flush();
    expect(lists).toHaveLength(1);
    expect(closed).toBe(0);
  });
});
