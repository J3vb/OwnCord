// The safety store's ordering, expiry timer, clock-skew and stale-answer
// rules, pinned at their edges.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectConsole } from "../../../tests/helpers/console";
import { captureLogs } from "../../../tests/helpers/log-capture";
import type { MyAppeal, OwnModerationAction } from "../../lib/api";
import {
  activeTimeoutIn,
  addNotice,
  applyAppealStatus,
  confirmTimeout,
  refreshOwnModeration,
  resetSafetyStore,
  safetyStore,
  serverTime,
  setActiveTimeout,
  setNoticeAck,
  setReadyNotices,
} from "./store";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const at = (ms: number): string => new Date(NOW + ms).toISOString();

function row(over: Partial<OwnModerationAction> & { id: number }): OwnModerationAction {
  return {
    kind: "warning",
    reason: "be kind",
    created_at: at(-DAY),
    expires_at: null,
    lifted_at: null,
    acknowledged_at: null,
    appealable: true,
    appeal: null,
    ...over,
  };
}

function appeal(id: string, over: Partial<MyAppeal> = {}): MyAppeal {
  return {
    id,
    action_kind: "warning",
    action_reason: "",
    action_created_at: at(-DAY),
    state: "open",
    decision_note: null,
    created_at: at(-DAY),
    decided_at: null,
    ...over,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  resetSafetyStore();
});
afterEach(() => {
  vi.useRealTimers();
  resetSafetyStore();
});

describe("safety store initial state", () => {
  it("starts empty with no failure flags set", () => {
    expect(safetyStore.getState()).toEqual({
      notices: [],
      timeout: null,
      history: null,
      historyFailed: false,
      appeals: null,
      appealsFailed: false,
    });
  });
});

describe("notice ordering and updates", () => {
  it("orders notices issued at the same moment by id, whichever order they arrive in", () => {
    const same = "2026-09-01T00:00:00Z";
    setReadyNotices([
      { id: 5, kind: "warning", reason: "e", created_at: same },
      { id: 2, kind: "warning", reason: "b", created_at: same },
    ]);
    expect(safetyStore.getState().notices.map((n) => n.id)).toEqual([2, 5]);
    setReadyNotices([
      { id: 2, kind: "warning", reason: "b", created_at: same },
      { id: 5, kind: "warning", reason: "e", created_at: same },
    ]);
    expect(safetyStore.getState().notices.map((n) => n.id)).toEqual([2, 5]);
  });

  it("shows a repeated action id once and still accepts a different one", () => {
    expect(addNotice(1, "a", at(-MIN))).toBe(true);
    expect(addNotice(2, "b", at(-MIN))).toBe(true);
    expect(addNotice(1, "a", at(-MIN))).toBe(false);
    expect(safetyStore.getState().notices.map((n) => n.id)).toEqual([1, 2]);
  });

  it("changes the acknowledgement state of the named notice only", () => {
    setReadyNotices([
      { id: 1, kind: "warning", reason: "a", created_at: at(-2 * MIN) },
      { id: 2, kind: "warning", reason: "b", created_at: at(-MIN) },
    ]);
    setNoticeAck(1, "pending");
    expect(safetyStore.getState().notices.map((n) => [n.id, n.ack])).toEqual([
      [1, "pending"],
      [2, "idle"],
    ]);
  });
});

describe("server time parsing", () => {
  it("reads an offset without a colon as that zone, not as UTC", () => {
    expect(serverTime("2026-09-23T12:56:05+0200")).toBe(Date.UTC(2026, 8, 23, 10, 56, 5));
    expect(serverTime("2026-09-23T12:56:05-05:30")).toBe(Date.UTC(2026, 8, 23, 18, 26, 5));
  });
});

describe("active timeout lookup", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  it("finds nothing when the only timeout has already expired", () => {
    expect(activeTimeoutIn([row({ id: 1, kind: "timeout", expires_at: at(-MIN) })])).toBeNull();
  });

  it("treats a timeout expiring this very instant as over", () => {
    expect(activeTimeoutIn([row({ id: 1, kind: "timeout", expires_at: at(0) })])).toBeNull();
  });

  it("picks the latest expiry whatever order the rows come in", () => {
    const near = at(5 * MIN);
    const far = at(20 * MIN);
    expect(
      activeTimeoutIn([
        row({ id: 1, kind: "timeout", expires_at: near }),
        row({ id: 2, kind: "timeout", expires_at: far }),
      ]),
    ).toBe(far);
    expect(
      activeTimeoutIn([
        row({ id: 1, kind: "timeout", expires_at: far }),
        row({ id: 2, kind: "timeout", expires_at: near }),
      ]),
    ).toBe(far);
  });

  it("keeps the first of two rows that expire at the same instant", () => {
    const first = "2026-09-23T12:10:00Z";
    const second = "2026-09-23T12:10:00.000+00:00";
    expect(
      activeTimeoutIn([
        row({ id: 1, kind: "timeout", expires_at: first }),
        row({ id: 2, kind: "timeout", expires_at: second }),
      ]),
    ).toBe(first);
  });
});

describe("expiry timer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  it("does not start for a timeout that is already over or ends this instant", () => {
    setActiveTimeout(at(-MIN));
    expect(safetyStore.getState().timeout).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    setActiveTimeout(at(0));
    expect(safetyStore.getState().timeout).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one timer: a new expiry replaces the old, clearing drops it", () => {
    setActiveTimeout(at(5 * MIN));
    setActiveTimeout(at(9 * MIN));
    expect(vi.getTimerCount()).toBe(1);
    setActiveTimeout(null);
    expect(vi.getTimerCount()).toBe(0);
    expect(safetyStore.getState().timeout).toBeNull();
  });

  it("drops the timer on sign-out", () => {
    setActiveTimeout(at(5 * MIN));
    resetSafetyStore();
    expect(vi.getTimerCount()).toBe(0);
    expect(safetyStore.getState().timeout).toBeNull();
  });

  it("holds a timeout longer than the timer limit until its real expiry", async () => {
    const until = at(40 * DAY);
    setActiveTimeout(until);
    await vi.advanceTimersByTimeAsync(25 * DAY);
    expect(safetyStore.getState().timeout).toEqual({ expiresAt: until });
    await vi.advanceTimersByTimeAsync(14 * DAY);
    expect(safetyStore.getState().timeout).toEqual({ expiresAt: until });
    await vi.advanceTimersByTimeAsync(DAY + 1);
    expect(safetyStore.getState().timeout).toBeNull();
  });

  it("leaves a newer timeout alone when an older timer fires", async () => {
    setActiveTimeout(at(5 * MIN));
    const newer = { expiresAt: at(30 * MIN) };
    safetyStore.setState((prev) => ({ ...prev, timeout: newer }));
    await vi.advanceTimersByTimeAsync(5 * MIN + 1);
    expect(safetyStore.getState().timeout).toEqual(newer);
  });
});

describe("clock skew from a refused send", () => {
  const FAST = 15 * MIN;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW + FAST });
  });

  it("measures from the newest timeout, not from a later warning", async () => {
    const until = at(10 * MIN);
    const getOwnModeration = vi
      .fn()
      .mockResolvedValue([
        row({ id: 4, kind: "timeout", created_at: at(-MIN), expires_at: until }),
        row({ id: 5, kind: "warning", created_at: at(-30_000) }),
      ]);
    confirmTimeout(null);
    refreshOwnModeration({ getOwnModeration });
    await settle();
    expect(safetyStore.getState().timeout).toEqual({ expiresAt: until });
  });

  it("measures from the newest timeout when an older one comes first", async () => {
    const old = row({
      id: 1,
      kind: "timeout",
      created_at: at(-3 * DAY),
      expires_at: at(-3 * DAY + 10 * MIN),
    });
    const lifted = row({
      id: 2,
      kind: "timeout",
      created_at: at(-MIN),
      expires_at: at(9 * MIN),
      lifted_at: at(0),
    });
    confirmTimeout(null);
    refreshOwnModeration({ getOwnModeration: () => Promise.resolve([old, lifted]) });
    await settle();
    // No skew was learned from the lifted timeout, so a later one is judged by
    // the local clock alone.
    refreshOwnModeration({
      getOwnModeration: () =>
        Promise.resolve([
          row({ id: 3, kind: "timeout", created_at: at(0), expires_at: at(10 * MIN) }),
        ]),
    });
    await settle();
    expect(safetyStore.getState().timeout).toBeNull();
  });

  it("takes the first of two timeouts issued at the same moment as the newest", async () => {
    const until = at(10 * MIN);
    const created = at(-MIN);
    confirmTimeout(null);
    refreshOwnModeration({
      getOwnModeration: () =>
        Promise.resolve([
          row({ id: 1, kind: "timeout", created_at: created, expires_at: until }),
          row({ id: 2, kind: "timeout", created_at: created, expires_at: until, lifted_at: at(0) }),
        ]),
    });
    await settle();
    expect(safetyStore.getState().timeout).toEqual({ expiresAt: until });
  });

  it("ignores a lifted timeout when the clock reads fast", async () => {
    confirmTimeout(null);
    refreshOwnModeration({
      getOwnModeration: () =>
        Promise.resolve([
          row({
            id: 2,
            kind: "timeout",
            created_at: at(-MIN),
            expires_at: at(9 * MIN),
            lifted_at: at(0),
          }),
        ]),
    });
    await settle();
    refreshOwnModeration({
      getOwnModeration: () =>
        Promise.resolve([
          row({ id: 3, kind: "timeout", created_at: at(0), expires_at: at(10 * MIN) }),
        ]),
    });
    await settle();
    expect(safetyStore.getState().timeout).toBeNull();
  });
});

describe("history answers", () => {
  it("does not restore a warning that was already acknowledged", async () => {
    refreshOwnModeration({
      getOwnModeration: () =>
        Promise.resolve([row({ id: 9, acknowledged_at: at(-MIN) }), row({ id: 10 })]),
    });
    await flush();
    expect(safetyStore.getState().notices.map((n) => n.id)).toEqual([10]);
  });

  it("applies a live appeal state to the history row of that appeal only", async () => {
    refreshOwnModeration({
      getOwnModeration: () =>
        Promise.resolve([
          row({ id: 1, appeal: { id: "ap-1", state: "open" } }),
          row({ id: 2, appeal: { id: "ap-2", state: "open" } }),
          row({ id: 3 }),
        ]),
    });
    await flush();
    applyAppealStatus({ id: "ap-2", state: "upheld", decision_note: "ok" });
    expect(safetyStore.getState().history?.map((r) => r.appeal)).toEqual([
      { id: "ap-1", state: "open" },
      { id: "ap-2", state: "upheld" },
      null,
    ]);
  });

  it("applies a live appeal state to the appeal it names only", async () => {
    refreshOwnModeration({
      getOwnModeration: () => Promise.resolve([]),
      getMyAppeals: () => Promise.resolve([appeal("ap-1"), appeal("ap-2")]),
    });
    await flush();
    applyAppealStatus({ id: "ap-1", state: "overturned", decision_note: "n" });
    expect(safetyStore.getState().appeals?.map((a) => [a.id, a.state, a.decision_note])).toEqual([
      ["ap-1", "overturned", "n"],
      ["ap-2", "open", null],
    ]);
  });

  it("drops an answer that was superseded by a sign-out and a new read", async () => {
    const api = {
      getOwnModeration: vi.fn(),
      getMyAppeals: vi.fn(),
    };
    const stale = deferred<OwnModerationAction[]>();
    const fresh = deferred<OwnModerationAction[]>();
    const staleAppeals = deferred<MyAppeal[]>();
    api.getOwnModeration.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    api.getMyAppeals
      .mockReturnValueOnce(staleAppeals.promise)
      .mockReturnValue(new Promise(() => {}));
    refreshOwnModeration(api);
    resetSafetyStore();
    refreshOwnModeration(api);
    stale.resolve([row({ id: 1 })]);
    staleAppeals.resolve([appeal("old")]);
    await flush();
    expect(safetyStore.getState().history).toBeNull();
    expect(safetyStore.getState().appeals).toBeNull();
    expect(safetyStore.getState().notices).toEqual([]);
  });

  it("keeps the latest appeals when an earlier request answers last", async () => {
    const first = deferred<MyAppeal[]>();
    const second = deferred<MyAppeal[]>();
    const getMyAppeals = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api = { getOwnModeration: () => Promise.resolve([]), getMyAppeals };
    refreshOwnModeration(api);
    refreshOwnModeration();
    second.resolve([appeal("new")]);
    await flush();
    first.resolve([appeal("old")]);
    await flush();
    expect(safetyStore.getState().appeals?.map((a) => a.id)).toEqual(["new"]);
  });
});

describe("reads that outlive their source", () => {
  it("drops answers that land after the source was cleared without a newer read", async () => {
    const history = deferred<OwnModerationAction[]>();
    const appeals = deferred<MyAppeal[]>();
    refreshOwnModeration({
      getOwnModeration: () => history.promise,
      getMyAppeals: () => appeals.promise,
    });
    resetSafetyStore();
    history.resolve([row({ id: 1 })]);
    appeals.resolve([appeal("late")]);
    await flush();
    expect(safetyStore.getState().history).toBeNull();
    expect(safetyStore.getState().appeals).toBeNull();
  });

  it("ignores failures that land after the source was cleared without a newer read", async () => {
    const history = deferred<OwnModerationAction[]>();
    const appeals = deferred<MyAppeal[]>();
    refreshOwnModeration({
      getOwnModeration: () => history.promise,
      getMyAppeals: () => appeals.promise,
    });
    resetSafetyStore();
    history.reject(new Error("late"));
    appeals.reject(new Error("late"));
    await flush();
    expect(safetyStore.getState().historyFailed).toBe(false);
    expect(safetyStore.getState().appealsFailed).toBe(false);
  });
});

describe("failed reads", () => {
  it("flags a failed history read and logs it under the safety component", async () => {
    const logs = captureLogs();
    refreshOwnModeration({ getOwnModeration: () => Promise.reject(new Error("offline")) });
    await flush();
    expect(safetyStore.getState().historyFailed).toBe(true);
    expect(logs.find("Failed to load own moderation history")).toMatchObject([
      { level: "warn", component: "safety", data: { error: "Error: offline" } },
    ]);
    expectConsole("warn", "Failed to load own moderation history");
  });

  it("flags a failed appeals read and logs the error", async () => {
    const logs = captureLogs();
    refreshOwnModeration({
      getOwnModeration: () => Promise.resolve([]),
      getMyAppeals: () => Promise.reject(new Error("gone")),
    });
    await flush();
    expect(safetyStore.getState().appealsFailed).toBe(true);
    expect(logs.find("Failed to load own appeals")).toMatchObject([
      { level: "warn", component: "safety", data: { error: "Error: gone" } },
    ]);
    expectConsole("warn", "Failed to load own appeals");
  });

  it("ignores a failure that lands after a newer read began", async () => {
    const logs = captureLogs();
    const oldHistory = deferred<OwnModerationAction[]>();
    const oldAppeals = deferred<MyAppeal[]>();
    refreshOwnModeration({
      getOwnModeration: () => oldHistory.promise,
      getMyAppeals: () => oldAppeals.promise,
    });
    refreshOwnModeration({
      getOwnModeration: () => new Promise(() => {}),
      getMyAppeals: () => new Promise(() => {}),
    });
    oldHistory.reject(new Error("late"));
    oldAppeals.reject(new Error("late"));
    await flush();
    expect(safetyStore.getState().historyFailed).toBe(false);
    expect(safetyStore.getState().appealsFailed).toBe(false);
    expect(logs.entries.filter((e) => e.level === "warn")).toEqual([]);
  });

  it("ignores a failure that lands after a newer read of the same source began", async () => {
    const oldHistory = deferred<OwnModerationAction[]>();
    const oldAppeals = deferred<MyAppeal[]>();
    const getOwnModeration = vi
      .fn()
      .mockReturnValueOnce(oldHistory.promise)
      .mockReturnValue(new Promise(() => {}));
    const getMyAppeals = vi
      .fn()
      .mockReturnValueOnce(oldAppeals.promise)
      .mockReturnValue(new Promise(() => {}));
    refreshOwnModeration({ getOwnModeration, getMyAppeals });
    refreshOwnModeration();
    oldHistory.reject(new Error("late"));
    oldAppeals.reject(new Error("late"));
    await flush();
    expect(safetyStore.getState().historyFailed).toBe(false);
    expect(safetyStore.getState().appealsFailed).toBe(false);
  });
});
