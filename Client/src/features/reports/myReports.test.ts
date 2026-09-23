// B9-10: My reports in the Safety tab — the reporter's own summary only,
// with loading, empty, error/retry and late-result states.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnReportSummary } from "@lib/api";
import { buildMyReportsSection, reportStateKey } from "./myReports";
import { buildSafetyPane } from "./safetyPane";

interface Deferred {
  resolve: (rows: OwnReportSummary[]) => void;
  reject: (e: unknown) => void;
}

let pending: Deferred[];
let signals: (AbortSignal | undefined)[];
const api = {
  getMyReports: (signal?: AbortSignal) => {
    signals.push(signal);
    return new Promise<OwnReportSummary[]>((resolve, reject) => pending.push({ resolve, reject }));
  },
};
let tab: AbortController;

beforeEach(() => {
  pending = [];
  signals = [];
  tab = new AbortController();
});
afterEach(() => {
  tab.abort();
  document.body.replaceChildren();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function row(over: Partial<OwnReportSummary> = {}): OwnReportSummary {
  return {
    id: "9f1c2e7a4b6d5031c8e0a2f6b1d4c7e9",
    target_type: "message",
    reason: "harassment",
    state: "open",
    outcome: "",
    created_at: "2026-09-05T10:00:00Z",
    closed_at: null,
    ...over,
  };
}

function mount(): HTMLElement {
  const section = buildMyReportsSection(tab.signal, api);
  document.body.appendChild(section);
  return section;
}

describe("My reports", () => {
  it("is a labelled section that announces loading, then lists each report", async () => {
    const section = mount();
    const heading = document.getElementById(section.getAttribute("aria-labelledby")!);
    expect(heading?.textContent).toBe("My reports");
    const status = section.querySelector("[role=status]")!;
    expect(status.textContent).toBe("Loading your reports…");
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(signals).toEqual([tab.signal]);

    pending[0]!.resolve([
      row(),
      row({
        target_type: "attachment",
        reason: "spam",
        state: "dismissed",
        outcome: "duplicate",
        closed_at: "2026-09-06 11:30:00",
      }),
    ]);
    await flush();
    expect(section.hasAttribute("aria-busy")).toBe(false);
    expect(status.textContent).toBe("");
    const items = [...section.querySelectorAll(".my-reports-item")];
    expect(items.map((i) => i.querySelector(".my-reports-what")?.textContent)).toEqual([
      "Message reported for Harassment",
      "Attachment reported for Spam",
    ]);
    expect(items.map((i) => i.querySelector(".my-reports-state")?.textContent)).toEqual([
      "Waiting for review",
      "Closed: already reported",
    ]);
    expect(items[0]?.querySelector(".my-reports-when")?.textContent).toMatch(/^Sent Sep 5, 2026/);
    expect(items[1]?.querySelector(".my-reports-when")?.textContent).toMatch(
      /· Closed Sep 6, 2026/,
    );
    // The summary never carries the public id or anything a moderator sees.
    expect(section.textContent).not.toContain("9f1c2e7a");
  });

  it("says so when there is nothing to show", async () => {
    const section = mount();
    pending[0]!.resolve([]);
    await flush();
    expect(section.querySelector("[role=status]")?.textContent).toBe(
      "You haven't reported anything on this server.",
    );
    expect(section.querySelectorAll("li")).toHaveLength(0);
  });

  it("shows unavailable rather than guessing a missing or unknown field", async () => {
    const section = mount();
    pending[0]!.resolve([row({ state: "resolved", outcome: "", created_at: "" })]);
    await flush();
    expect(section.querySelector(".my-reports-state")?.textContent).toBe("Status unavailable");
    expect(section.querySelector(".my-reports-when")?.textContent).toBe("Sent date unavailable");
  });

  it("alerts on failure and retries in place, keeping focus in the section", async () => {
    const section = mount();
    pending[0]!.reject(new Error("offline"));
    await flush();
    const alert = section.querySelector("[role=alert]")!;
    expect(alert.textContent).toBe("Couldn't load your reports.");
    const retry = section.querySelector<HTMLButtonElement>("button")!;
    expect(retry.hidden).toBe(false);
    expect(retry.textContent).toBe("Try again");
    retry.focus();
    retry.click();
    retry.click(); // one request at a time
    expect(pending).toHaveLength(2);
    expect(alert.textContent).toBe("");
    pending[1]!.resolve([row()]);
    await flush();
    expect(retry.hidden).toBe(true);
    expect(document.activeElement).toBe(section.querySelector("h2"));
    expect(section.querySelectorAll("li")).toHaveLength(1);
  });

  it("drops a result that lands after the tab is closed", async () => {
    const section = mount();
    tab.abort();
    pending[0]!.resolve([row()]);
    await flush();
    expect(section.querySelectorAll("li")).toHaveLength(0);
    expect(section.getAttribute("aria-busy")).toBe("true");
  });

  it("follows the restrictions and history in the Safety tab, loaded on open", async () => {
    const pane = buildSafetyPane(tab.signal, api);
    expect(pane.className).toBe("settings-pane active safety-tab");
    await vi.waitFor(() => expect(pane.querySelector("section.my-reports")).not.toBeNull());
    expect(pane.lastElementChild?.matches("section.my-reports")).toBe(true);
    expect(signals).toEqual([tab.signal]);
  });

  it("says so in the pane when the section fails to load", async () => {
    vi.doMock("./myReports", () => Promise.reject(new Error("chunk failed")));
    try {
      const pane = buildSafetyPane(tab.signal, api);
      // Other Safety sections keep their own (empty) alert regions; find ours.
      await vi.waitFor(() =>
        expect([...pane.querySelectorAll("[role=alert]")].map((a) => a.textContent)).toContain(
          "Couldn't load the Safety tab. Close Settings and try again.",
        ),
      );
      expect(signals).toEqual([]);
    } finally {
      vi.doUnmock("./myReports");
    }
  });

  it("adds nothing to a pane closed before its section loads", async () => {
    const pane = buildSafetyPane(tab.signal, api);
    tab.abort();
    await import("./myReports");
    await flush();
    expect(pane.querySelector("section.my-reports")).toBeNull();
    expect(pane.textContent).toBe("");
    expect(signals).toEqual([]);
  });
});

describe("reportStateKey", () => {
  it.each([
    ["open", "", "state.open"],
    ["assigned", "", "state.assigned"],
    ["resolved", "actioned", "state.actioned"],
    ["dismissed", "no_action", "state.no_action"],
    ["dismissed", "duplicate", "state.duplicate"],
    ["subject_erased", "subject_erased", "state.subject_erased"],
    ["resolved", "", "state.unknown"],
    ["archived", "", "state.unknown"],
  ])("%s/%s → %s", (state, outcome, key) => {
    expect(reportStateKey({ state, outcome })).toBe(key);
  });
});
