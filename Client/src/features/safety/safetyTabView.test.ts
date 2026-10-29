// The Safety tab's markup: classes and roles the stylesheet and assistive
// tech read, the per-row status line, and the tab's teardown on abort.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stores/ui.store", () => ({ openSettings: vi.fn() }));

import { expectConsole } from "../../../tests/helpers/console";
import type { OwnModerationAction } from "../../lib/api";
import { renderSafetyTab } from "./SafetyTab";
import { refreshOwnModeration, resetSafetyStore, setActiveTimeout } from "./store";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function row(over: Partial<OwnModerationAction> & { id: number }): OwnModerationAction {
  return {
    kind: "removal",
    reason: "off-topic",
    created_at: "2026-09-01T10:00:00Z",
    expires_at: null,
    lifted_at: null,
    acknowledged_at: null,
    appealable: false,
    appeal: null,
    ...over,
  };
}

interface Mounted {
  pane: HTMLDivElement;
  ac: AbortController;
  getOwnModeration: ReturnType<typeof vi.fn>;
}

async function mount(history: OwnModerationAction[] | Error): Promise<Mounted> {
  const getOwnModeration =
    history instanceof Error
      ? vi.fn().mockRejectedValue(history)
      : vi.fn().mockResolvedValue(history);
  refreshOwnModeration({ getOwnModeration });
  const ac = new AbortController();
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  renderSafetyTab(pane, ac.signal);
  await flush();
  if (history instanceof Error) expectConsole("warn", "Failed to load own moderation history");
  return { pane, ac, getOwnModeration };
}

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T =>
  root.querySelector<T>(sel)!;

beforeEach(() => {
  resetSafetyStore();
});
afterEach(() => {
  vi.useRealTimers();
  resetSafetyStore();
  document.body.replaceChildren();
});

describe("Safety tab markup", () => {
  it("gives each part of the empty tab its class, role and label", async () => {
    const { pane, ac } = await mount([]);
    const standing = q(pane, "[data-testid='safety-standing']");
    expect(standing.className).toBe("summary-line");
    expect(standing.getAttribute("role")).toBe("status");

    const restrictions = q(pane, "p.setting-desc");
    expect(restrictions.hidden).toBe(true);
    expect(restrictions.textContent).toBe("");

    const status = q(pane, "p.setting-desc[role='status']");
    expect(status.className).toBe("setting-desc");
    expect(status.textContent).toBe("Nothing to show.");

    const retry = q<HTMLButtonElement>(pane, "button.safety-retry");
    expect(retry.type).toBe("button");
    expect(retry.className).toBe("ac-btn safety-retry");
    expect(retry.textContent).toBe("Try again");

    const list = q(pane, "ul");
    expect(list.className).toBe("safety-history");
    expect(list.getAttribute("aria-label")).toBe("Moderation history");

    const heading = q(pane, "h3");
    expect(heading.className).toBe("safety-heading");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(heading.textContent).toBe("Moderation history");
    ac.abort();
  });

  it("shows the history hint, and no status line, once there are rows", async () => {
    const { pane, ac } = await mount([row({ id: 1 })]);
    const hint = [...pane.querySelectorAll<HTMLElement>("p.setting-desc")].find((p) =>
      p.textContent.startsWith("Warnings, timeouts, removed messages"),
    )!;
    expect(hint.className).toBe("setting-desc");
    expect(hint.hidden).toBe(false);
    expect(q(pane, "p[role='status'].setting-desc").textContent).toBe("");
    ac.abort();
  });

  it("hides the hint and offers Try again when the history cannot load", async () => {
    const { pane, ac } = await mount(new Error("offline"));
    const hint = [...pane.querySelectorAll<HTMLElement>("p.setting-desc")].find((p) =>
      p.textContent.startsWith("Warnings, timeouts, removed messages"),
    )!;
    expect(hint.hidden).toBe(true);
    expect(q<HTMLButtonElement>(pane, ".safety-retry").hidden).toBe(false);
    expect(q(pane, "p.setting-desc[role='status']").textContent).toBe(
      "Your moderation history couldn't be loaded.",
    );
    expect(pane.querySelectorAll(".safety-history-row")).toHaveLength(0);
    ac.abort();
  });

  it("shows the active timeout in its own line and clears it when it ends", async () => {
    const { pane, ac } = await mount([]);
    const restrictions = q(pane, "p.setting-desc");
    setActiveTimeout(new Date(Date.now() + 3_600_000).toISOString());
    await flush();
    expect(restrictions.hidden).toBe(false);
    expect(restrictions.textContent).toMatch(/^You're timed out until /);
    setActiveTimeout(null);
    await flush();
    expect(restrictions.hidden).toBe(true);
    expect(restrictions.textContent).toBe("");
    ac.abort();
  });
});

describe("Safety tab history rows", () => {
  it("renders the row's test id, head, reason and a status line", async () => {
    const { pane, ac } = await mount([
      row({ id: 7, kind: "ban", lifted_at: "2026-09-02T10:00:00Z", reason: "raid" }),
    ]);
    const li = q(pane, "[data-testid='safety-history-7']");
    expect(li.className).toBe("safety-history-row");
    const head = q(li, "p.safety-history-head");
    expect(head.querySelector("strong")?.textContent).toBe("Ban");
    expect(head.textContent).toMatch(/^Ban · Sep 1, 2026/);
    expect(q(li, "p.safety-history-reason").textContent).toBe("Reason: raid");
    expect(q(li, "p.setting-desc").textContent).toMatch(/^Lifted Sep 2, 2026/);
    ac.abort();
  });

  it("joins an appeal state onto the status with a separator", async () => {
    const { pane, ac } = await mount([
      row({
        id: 8,
        kind: "ban",
        lifted_at: "2026-09-02T10:00:00Z",
        appeal: { id: "A-1", state: "open" },
      }),
    ]);
    expect(q(pane, "li p.setting-desc").textContent).toMatch(
      /^Lifted Sep 2, 2026.* · Appeal: open$/,
    );
    ac.abort();
  });

  it("says no reason was given for an empty reason", async () => {
    const { pane, ac } = await mount([row({ id: 9, reason: "" })]);
    expect(q(pane, "p.safety-history-reason").textContent).toBe("No reason was given.");
    ac.abort();
  });

  it("adds no status line to a row with nothing to say", async () => {
    const { pane, ac } = await mount([row({ id: 10, kind: "removal" })]);
    const li = q(pane, "li");
    expect(li.querySelectorAll("p")).toHaveLength(2);
    expect(li.querySelector("p.setting-desc")).toBeNull();
    ac.abort();
  });

  it("marks a warning as not yet acknowledged until it is", async () => {
    const { pane, ac } = await mount([
      row({ id: 11, kind: "warning" }),
      row({ id: 12, kind: "warning", acknowledged_at: "2026-09-02T10:00:00Z" }),
    ]);
    expect(q(pane, "[data-testid='safety-history-11'] p.setting-desc").textContent).toBe(
      "Not yet acknowledged",
    );
    expect(q(pane, "[data-testid='safety-history-12'] p.setting-desc").textContent).toBe(
      "Acknowledged",
    );
    ac.abort();
  });

  it("treats a timeout ending at this very instant as ended, not active", async () => {
    const expires = "2026-09-01T11:00:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(expires));
    const { pane, ac } = await mount([row({ id: 13, kind: "timeout", expires_at: expires })]);
    expect(q(pane, "li p.setting-desc").textContent).toMatch(/^Ended /);
    ac.abort();
  });

  it("shows a timeout that has not ended yet as active", async () => {
    const { pane, ac } = await mount([
      row({ id: 14, kind: "timeout", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
    ]);
    expect(q(pane, "li p.setting-desc").textContent).toMatch(/^Active until /);
    ac.abort();
  });
});

describe("Safety tab teardown", () => {
  it("stops following the store once the tab closes", async () => {
    const { pane, ac } = await mount([]);
    ac.abort();
    setActiveTimeout(new Date(Date.now() + 3_600_000).toISOString());
    await flush();
    expect(q(pane, "[data-testid='safety-standing']").textContent).toBe(
      "Your account is in good standing.",
    );
  });

  it("ignores Try again after the tab closes", async () => {
    const { pane, ac, getOwnModeration } = await mount(new Error("offline"));
    const calls = getOwnModeration.mock.calls.length;
    ac.abort();
    q<HTMLButtonElement>(pane, ".safety-retry").click();
    await flush();
    expect(getOwnModeration).toHaveBeenCalledTimes(calls);
  });

  it("reads again when Try again is pressed on an open tab", async () => {
    const { pane, ac, getOwnModeration } = await mount(new Error("offline"));
    const calls = getOwnModeration.mock.calls.length;
    q<HTMLButtonElement>(pane, ".safety-retry").click();
    await flush();
    expectConsole("warn", "Failed to load own moderation history");
    expect(getOwnModeration.mock.calls.length).toBeGreaterThan(calls);
    ac.abort();
  });
});
