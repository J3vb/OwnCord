import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/toast", () => ({ showToast: vi.fn() }));
vi.mock("@stores/ui.store", () => ({ openSettings: vi.fn() }));

import { expectConsole } from "../../../tests/helpers/console";
import { ApiClientError, type OwnModerationAction } from "../../lib/api";
import { showToast } from "../../lib/toast";
import { openSettings } from "@stores/ui.store";
import type { Payload } from "../connection/dispatchContext";
import { buildSafetyTab, createNoticesBanner } from "./Notices";
import { renderSafetyTab } from "./SafetyTab";
import {
  activeTimeoutIn,
  addNotice,
  refreshOwnModeration,
  resetSafetyStore,
  safetyStore,
  serverTime,
  setActiveTimeout,
  setReadyNotices,
} from "./store";
import {
  applyReadySafety,
  handleModAction,
  handleTimedOutRefusal,
  refreshSafetyOnResume,
} from "./wsHandlers";

const HOUR = 3_600_000;
const later = (ms = HOUR): string => new Date(Date.now() + ms).toISOString();
const earlier = (ms = HOUR): string => new Date(Date.now() - ms).toISOString();

function row(over: Partial<OwnModerationAction> & { id: number }): OwnModerationAction {
  return {
    kind: "warning",
    reason: "be kind",
    created_at: earlier(),
    expires_at: null,
    lifted_at: null,
    acknowledged_at: null,
    appealable: true,
    appeal: null,
    ...over,
  };
}

/** Settle store notifications (microtasks) and any resolved fetches. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** The same under fake timers. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const authOk = (replay_source?: "none" | "buffer" | "db") =>
  ({ replay_source }) as Payload<"auth_ok">;

const ready = (notices: Payload<"ready">["notices"]): Payload<"ready"> =>
  ({ notices }) as Payload<"ready">;

beforeEach(() => {
  resetSafetyStore();
  vi.clearAllMocks();
});
afterEach(() => {
  resetSafetyStore();
  document.body.replaceChildren();
});

describe("safety store", () => {
  it("orders ready notices oldest first and keeps an in-flight acknowledgement", async () => {
    setReadyNotices([
      { id: 2, kind: "warning", reason: "b", created_at: "2026-09-02T00:00:00Z" },
      { id: 1, kind: "warning", reason: "a", created_at: "2026-09-01T00:00:00Z" },
    ]);
    expect(safetyStore.getState().notices.map((n) => n.id)).toEqual([1, 2]);

    safetyStore.setState((s) => ({
      ...s,
      notices: s.notices.map((n) => (n.id === 1 ? { ...n, ack: "pending" as const } : n)),
    }));
    // A reconnect's ready lands while the ack is in flight.
    setReadyNotices([{ id: 1, kind: "warning", reason: "a", created_at: "2026-09-01T00:00:00Z" }]);
    expect(safetyStore.getState().notices).toEqual([
      { id: 1, reason: "a", createdAt: "2026-09-01T00:00:00Z", ack: "pending" },
    ]);
  });

  it("finds only an unlifted, unexpired timeout", () => {
    const active = later();
    expect(
      activeTimeoutIn([
        row({ id: 1, kind: "timeout", expires_at: earlier() }),
        row({ id: 2, kind: "timeout", expires_at: later(), lifted_at: earlier() }),
        row({ id: 3, kind: "timeout", expires_at: active }),
        row({ id: 4, kind: "warning" }),
      ]),
    ).toBe(active);
    expect(activeTimeoutIn([row({ id: 1, kind: "ban", expires_at: later() })])).toBeNull();
  });

  it("ends a timeout locally at its expiry (advisory)", () => {
    vi.useFakeTimers();
    try {
      setActiveTimeout(new Date(Date.now() + 5_000).toISOString());
      expect(safetyStore.getState().timeout).not.toBeNull();
      vi.advanceTimersByTime(5_001);
      expect(safetyStore.getState().timeout).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies only the latest history answer, and drops notices acknowledged elsewhere", async () => {
    setReadyNotices([{ id: 7, kind: "warning", reason: "x", created_at: earlier() }]);
    const first = deferred<OwnModerationAction[]>();
    const second = deferred<OwnModerationAction[]>();
    const getOwnModeration = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    refreshOwnModeration({ getOwnModeration });
    refreshOwnModeration();

    const until = later();
    second.resolve([
      row({ id: 7, acknowledged_at: earlier(1000) }),
      row({ id: 8, kind: "timeout", expires_at: until }),
    ]);
    await flush();
    first.resolve([]); // stale: must not clear the newer answer
    await flush();

    const s = safetyStore.getState();
    expect(s.history?.map((r) => r.id)).toEqual([7, 8]);
    expect(s.notices).toEqual([]);
    expect(s.timeout).toEqual({ expiresAt: until });
  });

  it("orders the ledger's zone-less SQLite times with a live notice's ISO time", async () => {
    // Live notice received at 12:56:10Z; the ledger's missed one was issued at 12:56:05 UTC.
    addNotice(1, "live", "2026-09-23T12:56:10.000Z");
    refreshOwnModeration({
      getOwnModeration: () =>
        Promise.resolve([
          row({ id: 1, reason: "live", created_at: "2026-09-23 12:56:01" }),
          row({ id: 2, reason: "missed", created_at: "2026-09-23 12:56:05" }),
        ]),
    });
    await flush();
    expect(safetyStore.getState().notices.map((n) => [n.id, n.createdAt])).toEqual([
      [1, "2026-09-23 12:56:01"],
      [2, "2026-09-23 12:56:05"],
    ]);
    expect(serverTime("2026-09-23 12:56:05")).toBe(Date.UTC(2026, 8, 23, 12, 56, 5));
    expect(serverTime("2026-09-23T12:56:05+02:00")).toBe(Date.UTC(2026, 8, 23, 10, 56, 5));
  });

  it("history restores an unacknowledged warning whose live frame was missed", async () => {
    refreshOwnModeration({
      getOwnModeration: () =>
        Promise.resolve([row({ id: 21, reason: "missed", created_at: "2026-09-01T00:00:00Z" })]),
    });
    await flush();
    expect(safetyStore.getState().notices).toEqual([
      { id: 21, reason: "missed", createdAt: "2026-09-01T00:00:00Z", ack: "idle" },
    ]);
  });

  it("drops a history answer that lands after sign-out", async () => {
    const pending = deferred<OwnModerationAction[]>();
    refreshOwnModeration({ getOwnModeration: () => pending.promise });
    resetSafetyStore();
    pending.resolve([row({ id: 1, kind: "timeout", expires_at: later() })]);
    await flush();
    expect(safetyStore.getState()).toMatchObject({ history: null, timeout: null, notices: [] });
  });
});

describe("safety ws handlers", () => {
  it("ready sets the notices and re-reads the authoritative history", async () => {
    const getOwnModeration = vi.fn().mockResolvedValue([]);
    applyReadySafety(
      { listBlocks: vi.fn(), getOwnModeration },
      ready([{ id: 3, kind: "warning", reason: "r", created_at: earlier() }]),
    );
    expect(safetyStore.getState().notices.map((n) => n.id)).toEqual([3]);
    expect(getOwnModeration).toHaveBeenCalledTimes(1);
    await flush();
    // An older server without notices leaves an empty list, not a crash.
    applyReadySafety(undefined, {} as Payload<"ready">);
    expect(safetyStore.getState().notices).toEqual([]);
  });

  it("a live warning shows once and announces once, even when the frame repeats", () => {
    const frame = { id: 9, kind: "warning", reason: "spam", expires_at: null } as const;
    handleModAction(undefined, frame);
    handleModAction(undefined, frame);
    expect(safetyStore.getState().notices.map((n) => n.id)).toEqual([9]);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(
      "You received a warning from the moderators: spam",
      "warning",
    );
  });

  it("a ready notice and the same live warning dedupe by action id", () => {
    setReadyNotices([{ id: 9, kind: "warning", reason: "spam", created_at: earlier() }]);
    handleModAction(undefined, { id: 9, kind: "warning", reason: "spam", expires_at: null });
    expect(safetyStore.getState().notices).toHaveLength(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("a live timeout sets the server expiry; its lift clears it without an announcement", () => {
    const until = later();
    handleModAction(undefined, { id: 4, kind: "timeout", reason: "cool off", expires_at: until });
    expect(safetyStore.getState().timeout).toEqual({ expiresAt: until });
    expect(showToast).toHaveBeenLastCalledWith(
      expect.stringMatching(/^You're timed out until /),
      "warning",
    );

    handleModAction(undefined, { id: 0, kind: "timeout", reason: "", expires_at: null });
    expect(safetyStore.getState().timeout).toBeNull();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("a resumed connection (no ready) re-reads the history; a fresh one waits for ready", () => {
    const getOwnModeration = vi.fn().mockResolvedValue([]);
    const api = { listBlocks: vi.fn(), getOwnModeration };
    refreshSafetyOnResume(api, authOk());
    refreshSafetyOnResume(api, authOk("none"));
    expect(getOwnModeration).not.toHaveBeenCalled();
    refreshSafetyOnResume(api, authOk("buffer"));
    refreshSafetyOnResume(api, authOk("db"));
    expect(getOwnModeration).toHaveBeenCalledTimes(2);
  });

  describe("on a skewed local clock", () => {
    const MIN = 60_000;
    const SERVER_NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
    const at = (ms: number): string => new Date(SERVER_NOW + ms).toISOString();
    afterEach(() => vi.useRealTimers());

    for (const [clock, skew] of [
      ["fast", 15 * MIN],
      ["slow", -15 * MIN],
    ] as const) {
      it(`a live timeout ends at the server's expiry on a ${clock} clock`, async () => {
        vi.useFakeTimers({ now: SERVER_NOW + skew });
        const until = at(10 * MIN);
        const getOwnModeration = vi.fn().mockResolvedValue([
          // The ledger's zone-less issue time: the server's clock as the frame was sent.
          row({ id: 4, kind: "timeout", created_at: "2026-09-23 12:00:00", expires_at: until }),
        ]);
        handleModAction(
          { listBlocks: vi.fn(), getOwnModeration },
          { id: 4, kind: "timeout", reason: "cool off", expires_at: until },
        );
        expect(safetyStore.getState().timeout).toEqual({ expiresAt: until });
        await settle();
        await vi.advanceTimersByTimeAsync(10 * MIN - 1_000);
        expect(safetyStore.getState().timeout).toEqual({ expiresAt: until });
        await vi.advanceTimersByTimeAsync(1_001);
        expect(safetyStore.getState().timeout).toBeNull();
      });
    }

    it("a TIMED_OUT refusal keeps a timeout a fast clock reads as expired", async () => {
      vi.useFakeTimers({ now: SERVER_NOW + 15 * MIN });
      const until = at(10 * MIN);
      const api = {
        listBlocks: vi.fn(),
        getOwnModeration: vi
          .fn()
          .mockResolvedValue([
            row({ id: 4, kind: "timeout", created_at: at(-MIN), expires_at: until }),
          ]),
      };
      // The local clock alone drops it...
      applyReadySafety(api, ready([]));
      await settle();
      expect(safetyStore.getState().timeout).toBeNull();
      // ...but the server just refused a send because of it.
      handleTimedOutRefusal(api, { code: "TIMED_OUT", message: "you are timed out" });
      await settle();
      expect(safetyStore.getState().timeout).toEqual({ expiresAt: until });
      // With no server clock to read, it stays advisory: it lapses after a minute
      // and the next refusal revalidates it.
      await vi.advanceTimersByTimeAsync(MIN + 1);
      expect(safetyStore.getState().timeout).toBeNull();
      handleTimedOutRefusal(api, { code: "TIMED_OUT", message: "you are timed out" });
      await settle();
      expect(safetyStore.getState().timeout).toEqual({ expiresAt: until });
    });
  });

  it("a TIMED_OUT refusal revalidates against the server; other errors do not", () => {
    const getOwnModeration = vi.fn().mockResolvedValue([]);
    const api = { listBlocks: vi.fn(), getOwnModeration };
    handleTimedOutRefusal(api, { code: "FORBIDDEN", message: "" });
    expect(getOwnModeration).not.toHaveBeenCalled();
    handleTimedOutRefusal(api, { code: "TIMED_OUT", message: "you are timed out" });
    expect(getOwnModeration).toHaveBeenCalledTimes(1);
  });
});

function mount(acknowledgeNotice: (id: number) => Promise<void>): {
  el: HTMLElement;
  fallback: ReturnType<typeof vi.fn>;
  ac: AbortController;
} {
  const ac = new AbortController();
  const fallback = vi.fn();
  const el = createNoticesBanner({
    api: { acknowledgeNotice, getOwnModeration: vi.fn().mockResolvedValue([]) },
    fallbackFocus: fallback,
    signal: ac.signal,
  });
  document.body.appendChild(el);
  return { el, fallback, ac };
}
const ackButtons = (el: HTMLElement) => [
  ...el.querySelectorAll<HTMLButtonElement>("[data-testid='moderation-notice-ack']"),
];

describe("notice banner", () => {
  it("stays hidden with no notices and shows them oldest first with reason and date", async () => {
    const { el, ac } = mount(vi.fn());
    expect(el.classList.contains("visible")).toBe(false);
    setReadyNotices([
      { id: 2, kind: "warning", reason: "second", created_at: "2026-09-02T10:00:00Z" },
      { id: 1, kind: "warning", reason: "", created_at: "2026-09-01T10:00:00Z" },
    ]);
    await flush();
    expect(el.classList.contains("visible")).toBe(true);
    expect(el.getAttribute("aria-label")).toBe("Moderation notices");
    const notices = [...el.querySelectorAll(".moderation-notice")];
    expect(notices.map((n) => n.getAttribute("data-testid"))).toEqual([
      "moderation-notice-1",
      "moderation-notice-2",
    ]);
    expect(notices[0]!.textContent).toContain("No reason was given.");
    expect(notices[0]!.textContent).toContain("Issued Sep 1, 2026");
    expect(notices[1]!.textContent).toContain("Reason: second");
    // Q4: Acknowledge is the only way out; nothing else dismisses.
    expect(ackButtons(el).map((b) => b.textContent)).toEqual(["Acknowledge", "Acknowledge"]);
    expect(el.querySelector("[aria-label*='ismiss'], .close, [data-testid*='close']")).toBeNull();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flush();
    expect(el.querySelectorAll(".moderation-notice")).toHaveLength(2);
    ac.abort();
  });

  it("acknowledges through the server, busy without losing focus, then moves focus on", async () => {
    const pending = deferred<void>();
    const acknowledgeNotice = vi.fn(() => pending.promise);
    const { el, ac } = mount(acknowledgeNotice);
    setReadyNotices([
      { id: 1, kind: "warning", reason: "a", created_at: earlier(2 * HOUR) },
      { id: 2, kind: "warning", reason: "b", created_at: earlier() },
    ]);
    await flush();
    const [first] = ackButtons(el);
    first!.focus();
    first!.click();
    await flush();
    expect(acknowledgeNotice).toHaveBeenCalledWith(1, ac.signal);
    expect(first!.getAttribute("aria-busy")).toBe("true");
    expect(first!.getAttribute("aria-disabled")).toBe("true");
    expect(first!.textContent).toBe("Acknowledging…");
    expect(document.activeElement).toBe(first);
    first!.click(); // a second press while pending sends nothing
    expect(acknowledgeNotice).toHaveBeenCalledTimes(1);

    pending.resolve();
    await flush();
    expect(el.querySelector("[data-testid='moderation-notice-1']")).toBeNull();
    expect(document.activeElement).toBe(ackButtons(el)[0]);
    expect(el.querySelector("[role='status'].sr-only")?.textContent).toBe("Warning acknowledged.");
    ac.abort();
  });

  it("keeps the notice with an error when the acknowledgement fails, and retries", async () => {
    const acknowledgeNotice = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(500, "INTERNAL", "boom"))
      .mockResolvedValueOnce(undefined);
    const { el, fallback, ac } = mount(acknowledgeNotice);
    setReadyNotices([{ id: 5, kind: "warning", reason: "a", created_at: earlier() }]);
    await flush();
    const button = ackButtons(el)[0]!;
    button.focus();
    button.click();
    await flush();
    expect(el.querySelector("[data-testid='moderation-notice-5']")).not.toBeNull();
    const status = el.querySelector<HTMLElement>(".moderation-notice-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("Your acknowledgement wasn't recorded. Try again.");
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(document.activeElement).toBe(button);

    button.click();
    await flush();
    expect(el.querySelector("[data-testid='moderation-notice-5']")).toBeNull();
    expect(el.classList.contains("visible")).toBe(false);
    expect(fallback).toHaveBeenCalledTimes(1);
    ac.abort();
  });

  it("treats a 404 (acknowledged on another device) as done", async () => {
    const { el, ac } = mount(vi.fn().mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "")));
    setReadyNotices([{ id: 5, kind: "warning", reason: "a", created_at: earlier() }]);
    await flush();
    ackButtons(el)[0]!.click();
    await flush();
    expect(safetyStore.getState().notices).toEqual([]);
    ac.abort();
  });

  it("links to the Safety settings tab", async () => {
    const { el, ac } = mount(vi.fn());
    setReadyNotices([{ id: 5, kind: "warning", reason: "a", created_at: earlier() }]);
    await flush();
    el.querySelector<HTMLButtonElement>(".moderation-notice-link")!.click();
    expect(openSettings).toHaveBeenCalledWith("Safety");
    ac.abort();
  });
});

describe("Safety tab", () => {
  it("loads, fails with a retry, then lists only member-safe facts", async () => {
    const leaky = {
      ...row({ id: 11, kind: "removal", reason: "off-topic" }),
      // A server that over-shares must still not reach the screen.
      actor_id: 4242,
      report_id: "RPT-SECRET",
      note: "note-SECRET-9",
    } as OwnModerationAction;
    const getOwnModeration = vi
      .fn()
      .mockResolvedValueOnce([]) // the dispatcher's read, superseded by the tab's
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([
        leaky,
        row({ id: 12, kind: "timeout", expires_at: earlier(), reason: "flood" }),
        row({
          id: 13,
          kind: "ban",
          lifted_at: "2026-09-01T10:00:00Z",
          reason: "raid",
          appeal: { id: "A-1", state: "overturned" },
        }),
        row({ id: 14, acknowledged_at: earlier() }),
      ]);
    refreshOwnModeration({ getOwnModeration });
    const ac = new AbortController();
    const pane = document.createElement("div");
    renderSafetyTab(pane, ac.signal);
    document.body.appendChild(pane);
    // Opening the tab re-reads; that first read fails.
    expect(pane.textContent).toContain("Loading your moderation history…");
    await flush();
    expect(pane.textContent).toContain("Your moderation history couldn't be loaded.");
    expectConsole("warn", "Failed to load own moderation history");
    const retry = pane.querySelector<HTMLButtonElement>(".safety-retry")!;
    expect(retry.hidden).toBe(false);

    retry.click();
    await flush();
    expect(retry.hidden).toBe(true);
    const rows = [...pane.querySelectorAll(".safety-history-row")].map((r) => r.textContent);
    expect(rows[0]).toContain("Message removed");
    expect(rows[0]).toContain("Reason: off-topic");
    expect(rows[1]).toContain("Timeout");
    expect(rows[1]).toContain("Ended");
    expect(rows[2]).toContain("Lifted Sep 1, 2026");
    expect(rows[2]).toContain("Appeal: overturned");
    expect(rows[3]).toContain("Acknowledged");
    expect(pane.textContent).not.toMatch(/4242|RPT-SECRET|note-SECRET-9/);
    expect(pane.textContent).toContain("You have no active restrictions.");

    setActiveTimeout(later());
    await flush();
    expect(pane.textContent).toMatch(/You're timed out until .+ You can't send messages/);
    ac.abort();
  });

  it("the settings entry loads its body on first open", async () => {
    refreshOwnModeration({ getOwnModeration: vi.fn().mockResolvedValue([]) });
    const ac = new AbortController();
    const pane = buildSafetyTab(ac.signal);
    expect(pane.classList.contains("safety-tab")).toBe(true);
    await vi.waitFor(() => expect(pane.textContent).toContain("Current restrictions"));
    ac.abort();
  });
});
