// The Appeals tab's own view: its regions, filter, queue rows, request
// ordering, focus and what survives once the view closes. The server
// authorizes every read; these tests pin what the view shows and discards
// around those answers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClientError } from "@lib/api";
import { authStore } from "@stores/auth.store";
import { setConnectionStatus } from "@stores/ui.store";
import {
  byId,
  detail,
  flush,
  h,
  heldDetail,
  loaded,
  mountAppeals,
  opened,
  q,
  qa,
  resetHarness,
  row,
  rows,
  teardownHarness,
  text,
} from "../../../tests/helpers/appeal-harness";
import { dateText } from "./Evidence";
import { noteAppealChange } from "./store";

async function push(): Promise<void> {
  noteAppealChange();
  await flush();
}

async function connection(status: "connected" | "reconnecting" | "disconnected"): Promise<void> {
  setConnectionStatus(status);
  await flush();
}

beforeEach(resetHarness);
afterEach(() => {
  teardownHarness();
  setConnectionStatus("disconnected");
});

const idOf = (r: HTMLElement) => q<HTMLSelectElement>(r, "select")!.id;

const optionLabels = (select: HTMLSelectElement) =>
  [...select.options].map((o) => [o.value, o.textContent]);

describe("regions", () => {
  it("builds the intro, the filter, the live regions and the queue with their roles and classes", () => {
    const { root } = mountAppeals();
    expect(q(root, "p.mod-center-intro")!.textContent).toContain(
      "Your own appeals are never shown",
    );
    const toolbar = q<HTMLElement>(root, "div.mod-center-toolbar")!;
    const select = q<HTMLSelectElement>(toolbar, "select.form-input")!;
    expect(select.dataset.testid).toBe("mod-appeal-filter");
    expect(optionLabels(select)).toEqual([
      ["", "Open and in review"],
      ["open", "Waiting for review"],
      ["assigned", "In review"],
      ["decided", "Decided"],
    ]);
    const label = q<HTMLLabelElement>(toolbar, "label")!;
    expect(label.textContent).toBe("Show");
    expect(label.htmlFor).toBe(select.id);
    expect(root.querySelector(`#${select.id}`)).toBe(select);

    const statuses = qa<HTMLElement>(root, "p.mod-center-status[role=status]");
    expect(statuses).toHaveLength(3);
    expect(byId(root, "mod-appeal-status").tagName).toBe("P");
    expect(byId(root, "mod-appeal-write-status").className).toBe("mod-center-status");
    expect(qa(root, "p.form-error[role=alert]")).toHaveLength(3);
    const list = byId(root, "mod-appeal-queue");
    expect(list.tagName).toBe("UL");
    expect(list.className).toBe("mod-queue");
    expect(list.getAttribute("aria-label")).toBe("Appeals");
    expect(q(root, "div.mod-report-slot")).not.toBeNull();
  });

  it("keeps both retry buttons out of sight until a read fails", () => {
    const { root } = mountAppeals();
    const retries = qa<HTMLButtonElement>(root, "button.btn-modal-save");
    expect(retries).toHaveLength(2);
    for (const b of retries) {
      expect(b.type).toBe("button");
      expect(b.textContent).toBe("Try again");
      expect(b.hidden).toBe(true);
    }
  });

  it("gives each view its own filter id", () => {
    const first = mountAppeals();
    const second = mountAppeals();
    expect(idOf(first.root)).toMatch(/^mod-appeal-filter-[1-9]\d*$/);
    expect(idOf(second.root)).toMatch(/^mod-appeal-filter-[1-9]\d*$/);
    const n = (r: HTMLElement) => Number(idOf(r).split("-").pop());
    expect(n(second.root)).toBeGreaterThan(n(first.root));
  });

  it("falls back to the member's id -1 when nobody is signed in", async () => {
    authStore.setState((s) => ({ ...s, user: null }));
    const { root } = await loaded([row("a1", { appellant_id: 1 })]);
    // Id 1 is not the signed-in account (there is none), so it is named as a member.
    expect(rows(root)[0]!.textContent).not.toContain("Appeal from You");
  });

  it("names the appellant as You when the signed-in account is listed", async () => {
    authStore.setState((s) => ({ ...s, user: { ...s.user!, id: APPELLANT_ID } }));
    const { root } = await loaded([row("a1")]);
    expect(rows(root)[0]!.textContent).toContain("Appeal from You");
  });
});

const APPELLANT_ID = 9;

describe("queue rows", () => {
  it("describes each row in full for a screen reader and lays out what, state and when", async () => {
    const { root } = await loaded([row("a1")]);
    const b = rows(root)[0]!;
    expect(b.type).toBe("button");
    expect(b.className).toBe("mod-queue-row");
    expect(b.dataset.appealId).toBe("a1");
    const filed = `Filed ${dateText("2026-09-20 10:00:00")}`;
    expect(b.getAttribute("aria-label")).toBe(`Appeal from appy. Waiting for review. ${filed}`);
    expect(q(b, "span.mod-queue-what")!.textContent).toBe("Appeal from appy");
    expect(q(b, "span.mod-queue-state")!.textContent).toBe("Waiting for review");
    expect(q(b, "span.mod-queue-when")!.textContent).toBe(filed);
  });

  it("hides the queue while it is empty and shows it once there are rows", async () => {
    const { root } = await loaded([]);
    expect(byId(root, "mod-appeal-queue").hidden).toBe(true);
    expect(text(root, "mod-appeal-status")).toBe("0 appeals open or in review");
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    expect(byId(root, "mod-appeal-queue").hidden).toBe(false);
  });

  it("marks the queue busy while it is read and clears that on every answer", async () => {
    const { root } = mountAppeals();
    const list = byId(root, "mod-appeal-queue");
    expect(list.getAttribute("aria-busy")).toBe("true");
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    expect(list.hasAttribute("aria-busy")).toBe(false);
    await push();
    expect(list.getAttribute("aria-busy")).toBe("true");
    h.lists.at(-1)!.reject(new Error("network"));
    await flush();
    expect(list.hasAttribute("aria-busy")).toBe(false);
  });

  it("marks only the open appeal's row as current, as soon as it is chosen", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    const [first, second] = rows(root) as [HTMLButtonElement, HTMLButtonElement];
    first.click();
    expect(first.getAttribute("aria-current")).toBe("true");
    expect(second.hasAttribute("aria-current")).toBe(false);
    second.click();
    expect(first.hasAttribute("aria-current")).toBe(false);
    expect(second.getAttribute("aria-current")).toBe("true");
  });
});

describe("status line", () => {
  it("says the queue is loading on the first read and on a filter change, not on a push", async () => {
    const { root } = mountAppeals();
    expect(text(root, "mod-appeal-status")).toBe("Loading appeals…");
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    expect(text(root, "mod-appeal-status")).toBe("1 appeal open or in review");
    await push();
    expect(text(root, "mod-appeal-status")).toBe("1 appeal open or in review");
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    const select = byId(root, "mod-appeal-filter") as HTMLSelectElement;
    select.value = "open";
    select.dispatchEvent(new Event("change"));
    expect(text(root, "mod-appeal-status")).toBe("Loading appeals…");
  });

  it.each([
    ["open", "2 appeals waiting for review"],
    ["assigned", "2 appeals in review"],
    ["decided", "2 decided appeals"],
    ["", "2 appeals open or in review"],
  ])("reads the %s filter and counts its rows", async (value, count) => {
    const { root } = await loaded([]);
    const select = byId(root, "mod-appeal-filter") as HTMLSelectElement;
    select.value = value === "" ? "open" : value;
    select.dispatchEvent(new Event("change"));
    if (value === "") {
      h.lists.at(-1)!.resolve([]);
      await flush();
      select.value = "";
      select.dispatchEvent(new Event("change"));
    }
    expect(h.lists.at(-1)!.arg).toBe(value);
    h.lists.at(-1)!.resolve([row("a1"), row("a2")]);
    await flush();
    expect(text(root, "mod-appeal-status")).toBe(count);
  });

  it("counts a late answer under the filter it was asked for", async () => {
    const { root } = await loaded([]);
    const select = byId(root, "mod-appeal-filter") as HTMLSelectElement;
    select.value = "decided";
    select.dispatchEvent(new Event("change"));
    select.value = "assigned";
    select.dispatchEvent(new Event("change"));
    expect(h.lists.map((c) => c.arg)).toEqual(["", "decided", "assigned"]);
    h.lists[1]!.resolve([row("stale")]);
    await flush();
    expect(rows(root)).toHaveLength(0);
    h.lists[2]!.resolve([row("a1", { state: "assigned" })]);
    await flush();
    expect(text(root, "mod-appeal-status")).toBe("1 appeal in review");
    expect(rows(root).map((b) => b.dataset.appealId)).toEqual(["a1"]);
  });

  it("drops an answer for a read that a newer one replaced, rows and failures alike", async () => {
    const { root } = await loaded([row("a1")]);
    await push();
    await push();
    expect(h.lists).toHaveLength(3);
    h.lists[1]!.reject(new Error("old failure"));
    await flush();
    expect(byId(root, "mod-appeal-queue").getAttribute("aria-busy")).toBe("true");
    expect(q(root, "p.form-error")!.textContent).toBe("");
    h.lists[2]!.resolve([row("a2")]);
    await flush();
    expect(rows(root).map((b) => b.dataset.appealId)).toEqual(["a2"]);
  });

  it("reads the filter back as the first one when the select holds no known value", async () => {
    const { root } = await loaded([]);
    const select = byId(root, "mod-appeal-filter") as HTMLSelectElement;
    select.value = "decided";
    select.dispatchEvent(new Event("change"));
    h.lists.at(-1)!.resolve([]);
    await flush();
    select.selectedIndex = -1;
    select.dispatchEvent(new Event("change"));
    expect(h.lists.at(-1)!.arg).toBe("");
    expect(text(root, "mod-appeal-status")).toBe("Loading appeals…");
  });
});

describe("a failed queue read", () => {
  it("says so, offers Retry and replaces both once the read goes through", async () => {
    const { root } = mountAppeals();
    h.lists[0]!.reject(new Error("network"));
    await flush();
    const failure = q<HTMLElement>(root, "p.form-error")!;
    const retry = q<HTMLButtonElement>(root, "button.btn-modal-save")!;
    expect(failure.textContent).toBe("Couldn't load appeals.");
    expect(text(root, "mod-appeal-status")).toBe("");
    expect(retry.hidden).toBe(false);
    retry.click();
    expect(h.lists).toHaveLength(2);
    expect(text(root, "mod-appeal-status")).toBe("Loading appeals…");
    h.lists[1]!.resolve([row("a1")]);
    await flush();
    expect(failure.textContent).toBe("");
    expect(retry.hidden).toBe(true);
    expect(text(root, "mod-appeal-status")).toBe("1 appeal open or in review");
  });

  it("hides Retry again after a push brings the queue back", async () => {
    const { root } = mountAppeals();
    h.lists[0]!.reject(new ApiClientError(500, "INTERNAL", "boom"));
    await flush();
    await push();
    h.lists[1]!.resolve([]);
    await flush();
    expect(q<HTMLButtonElement>(root, "button.btn-modal-save")!.hidden).toBe(true);
  });

  it("moves focus to the first row when the focused Retry button gives way", async () => {
    const { root } = mountAppeals();
    h.lists[0]!.reject(new Error("network"));
    await flush();
    const retry = q<HTMLButtonElement>(root, "button.btn-modal-save")!;
    retry.focus();
    retry.click();
    h.lists[1]!.resolve([row("a1"), row("a2")]);
    await flush();
    expect(document.activeElement).toBe(rows(root)[0]);
  });

  it("leaves focus alone when Retry was not the focused control", async () => {
    const { root } = mountAppeals();
    h.lists[0]!.reject(new Error("network"));
    await flush();
    q<HTMLButtonElement>(root, "button.btn-modal-save")!.click();
    h.lists[1]!.resolve([row("a1")]);
    await flush();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("focus in the queue", () => {
  it("keeps focus on the same row across a re-read", async () => {
    const { root } = await loaded([row("a1"), row("a2"), row("a3")]);
    rows(root)[1]!.focus();
    await push();
    h.lists.at(-1)!.resolve([row("a1"), row("a2"), row("a3")]);
    await flush();
    expect((document.activeElement as HTMLElement).dataset.appealId).toBe("a2");
  });

  it("falls back to the first row when the focused row is gone", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[1]!.focus();
    await push();
    h.lists.at(-1)!.resolve([row("a1"), row("a3")]);
    await flush();
    expect((document.activeElement as HTMLElement).dataset.appealId).toBe("a1");
  });

  it("falls back to the filter when no rows are left", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.focus();
    await push();
    h.lists.at(-1)!.resolve([]);
    await flush();
    expect(document.activeElement).toBe(byId(root, "mod-appeal-filter"));
  });

  it("does not take focus from elsewhere when the queue is re-read", async () => {
    const { root } = await loaded([row("a1")]);
    byId(root, "mod-appeal-filter").focus();
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    expect(document.activeElement).toBe(byId(root, "mod-appeal-filter"));
  });
});

describe("what triggers a re-read", () => {
  it("re-reads the queue and the open appeal on a push, without a loading message or a cleared appeal", async () => {
    const { root } = await opened(detail("a1"));
    await push();
    expect(h.lists).toHaveLength(2);
    expect(text(root, "mod-appeal-status")).toBe("1 appeal open or in review");
    h.lists[1]!.resolve([row("a1")]);
    await flush();
    expect(h.details).toHaveLength(2);
    // The appeal stays on screen while its own read is open.
    expect(q(root, "[data-testid=mod-appeal]")).not.toBeNull();
    expect(root.querySelector(".mod-report-slot")!.getAttribute("aria-busy")).toBe("true");
    expect(qa(root, "p.mod-center-status")[1]!.textContent).toBe("");
  });

  it("re-reads on reconnect but not on any other connection change", async () => {
    const { root } = await opened(detail("a1"));
    await connection("reconnecting");
    await connection("disconnected");
    expect(h.lists).toHaveLength(1);
    await connection("connected");
    expect(h.lists).toHaveLength(2);
    expect(text(root, "mod-appeal-status")).toBe("1 appeal open or in review");
    h.lists[1]!.resolve([row("a1")]);
    await flush();
    expect(h.details).toHaveLength(2);
  });

  it("does not re-read the open appeal after a filter change or a Retry", async () => {
    const { root } = await opened(detail("a1"));
    const select = byId(root, "mod-appeal-filter") as HTMLSelectElement;
    select.value = "open";
    select.dispatchEvent(new Event("change"));
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    expect(h.details).toHaveLength(1);
    expect(q(root, "[data-testid=mod-appeal]")).not.toBeNull();
  });

  it("keeps the open appeal when a Retry brings the queue back", async () => {
    const { root } = await opened(detail("a1"));
    await push();
    h.lists[1]!.reject(new Error("network"));
    await flush();
    q<HTMLButtonElement>(root, "button.btn-modal-save")!.click();
    h.lists[2]!.resolve([row("a1")]);
    await flush();
    expect(h.details).toHaveLength(1);
    expect(q(root, "[data-testid=mod-appeal]")).not.toBeNull();
  });
});

describe("when the view closes", () => {
  it("stops answering clicks, changes, retries and pushes, and cancels what is open", async () => {
    const { root } = await opened(detail("a1"), row("a1"));
    const rowButton = rows(root)[0]!;
    const select = byId(root, "mod-appeal-filter") as HTMLSelectElement;
    const retry = q<HTMLButtonElement>(root, "button.btn-modal-save")!;
    const detailRetry = qa<HTMLButtonElement>(root, "button.btn-modal-save")[1]!;
    await push();
    const pending = h.lists.at(-1)!;
    h.view.abort();
    expect(pending.signal!.aborted).toBe(true);
    expect(root.childElementCount).toBe(0);
    const reads = [h.lists.length, h.details.length];
    rowButton.click();
    select.value = "open";
    select.dispatchEvent(new Event("change"));
    retry.click();
    detailRetry.click();
    await push();
    await connection("reconnecting");
    await connection("connected");
    expect([h.lists.length, h.details.length]).toEqual(reads);
  });

  it("cancels the appeal read that is still open", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    const pending = h.details.at(-1)!;
    h.view.abort();
    expect(pending.signal!.aborted).toBe(true);
  });

  it("ignores a queue answer that arrives afterwards", async () => {
    const { root } = await loaded([row("a1")]);
    const list = byId(root, "mod-appeal-queue");
    const status = byId(root, "mod-appeal-status");
    await push();
    const late = h.lists.at(-1)!;
    h.view.abort();
    late.resolve([row("a9")]);
    await flush();
    expect(rows(list).map((b) => b.dataset.appealId)).toEqual(["a1"]);
    expect(status.textContent).toBe("1 appeal open or in review");
  });

  it("ignores a queue failure that arrives afterwards", async () => {
    const { root } = await loaded([row("a1")]);
    const failure = q<HTMLElement>(root, "p.form-error")!;
    const retry = q<HTMLButtonElement>(root, "button.btn-modal-save")!;
    await push();
    const late = h.lists.at(-1)!;
    h.view.abort();
    late.reject(new Error("network"));
    await flush();
    expect(failure.textContent).toBe("");
    expect(retry.hidden).toBe(true);
  });

  it("ignores an appeal answer that arrives afterwards", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    const slot = q<HTMLElement>(root, "div.mod-report-slot")!;
    const late = h.details.at(-1)!;
    h.view.abort();
    late.resolve(detail("a1"));
    await flush();
    expect(slot.childElementCount).toBe(0);
  });

  it("ignores an appeal failure that arrives afterwards", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    const failure = qa<HTMLElement>(root, "p.form-error")[1]!;
    const late = h.details.at(-1)!;
    h.view.abort();
    late.reject(new Error("network"));
    await flush();
    expect(failure.textContent).toBe("");
  });
});

describe("a view that is denied", () => {
  it("clears and hides everything and tells the other tab once", async () => {
    const { root, appeals } = await opened(heldDetail("a1"));
    q<HTMLButtonElement>(root, "button[data-focus=assign]");
    appeals.deny();
    appeals.deny();
    expect(h.denied).toBe(1);
    expect(byId(root, "mod-appeal-queue").hidden).toBe(true);
    expect(byId(root, "mod-appeal-queue").childElementCount).toBe(0);
    expect(
      byId(root, "mod-appeal-filter").closest(".mod-center-toolbar")!.hasAttribute("hidden"),
    ).toBe(true);
    for (const b of qa<HTMLButtonElement>(root, "button.btn-modal-save"))
      expect(b.hidden).toBe(true);
    expect(q(root, "[data-testid=mod-appeal]")).toBeNull();
    expect(q<HTMLElement>(root, "p.form-error")!.textContent).toBe(
      "You no longer have permission to moderate on this server.",
    );
  });

  it("empties every message the view had been showing", async () => {
    const { root, appeals } = await opened(detail("a1"));
    q<HTMLButtonElement>(work(root), "button")!.click();
    h.writes[0]!.reject(new Error("network"));
    await flush();
    expect(text(root, "mod-appeal-write-status")).toBe("");
    expect(q(root, "[data-testid=mod-appeal-work]")).not.toBeNull();
    appeals.deny();
    for (const p of qa<HTMLElement>(root, "p.mod-center-status")) expect(p.textContent).toBe("");
    expect(qa(root, "p.form-error").map((p) => p.textContent)).toEqual([
      "You no longer have permission to moderate on this server.",
      "",
      "",
    ]);
  });

  it("moves focus to the view's title when focus was inside it, and only then", async () => {
    const inside = await loaded([row("a1")]);
    rows(inside.root)[0]!.focus();
    inside.appeals.deny();
    expect(document.activeElement).toBe(inside.title);

    const outside = await loaded([row("a1")]);
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    outside.appeals.deny();
    expect(document.activeElement).toBe(elsewhere);
  });

  it("reads nothing more once denied", async () => {
    const { root, appeals } = await opened(detail("a1"));
    const rowButton = rows(root)[0]!;
    appeals.deny();
    rowButton.click();
    await push();
    await connection("reconnecting");
    await connection("connected");
    expect(h.lists).toHaveLength(1);
    expect(h.details).toHaveLength(1);
  });
});

function work(root: ParentNode): HTMLElement {
  return byId(root, "mod-appeal-work");
}
