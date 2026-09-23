import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stores/ui.store", () => ({ openSettings: vi.fn() }));

import { expectConsole } from "../../../tests/helpers/console";
import { ApiClientError, type MyAppeal, type OwnModerationAction } from "../../lib/api";
import { appealBody } from "./Appeals";
import { renderSafetyTab } from "./SafetyTab";
import { applyAppealStatus, refreshOwnModeration, resetSafetyStore, safetyStore } from "./store";
import { handleAppealStatus } from "./wsHandlers";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function row(over: Partial<OwnModerationAction> & { id: number }): OwnModerationAction {
  return {
    kind: "timeout",
    reason: "flood",
    created_at: "2026-09-01T10:00:00Z",
    expires_at: "2026-09-01T11:00:00Z",
    lifted_at: null,
    acknowledged_at: null,
    appealable: true,
    appeal: null,
    ...over,
  };
}

function appeal(over: Partial<MyAppeal> & { id: string }): MyAppeal {
  return {
    action_kind: "timeout",
    action_reason: "flood",
    action_created_at: "2026-09-01T10:00:00Z",
    state: "open",
    decision_note: null,
    created_at: "2026-09-02T10:00:00Z",
    decided_at: null,
    ...over,
  };
}

interface Harness {
  pane: HTMLDivElement;
  ac: AbortController;
  api: {
    getOwnModeration: ReturnType<typeof vi.fn>;
    getMyAppeals: ReturnType<typeof vi.fn>;
    fileAppeal: ReturnType<typeof vi.fn>;
    withdrawAppeal: ReturnType<typeof vi.fn>;
  };
}

async function mount(
  history: OwnModerationAction[],
  appeals: MyAppeal[] = [],
  withApi = true,
): Promise<Harness> {
  const api = {
    getOwnModeration: vi.fn().mockResolvedValue(history),
    getMyAppeals: vi.fn().mockResolvedValue(appeals),
    fileAppeal: vi.fn().mockResolvedValue({ id: "new" }),
    withdrawAppeal: vi.fn().mockResolvedValue(undefined),
  };
  refreshOwnModeration(api);
  const ac = new AbortController();
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  renderSafetyTab(pane, ac.signal, withApi ? api : null);
  await flush();
  return { pane, ac, api };
}

const q = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T =>
  root.querySelector<T>(sel)!;
const panelOf = (pane: HTMLElement) => q(pane, "[data-testid='safety-appeal-panel']");
const bodyOf = (pane: HTMLElement) => q<HTMLTextAreaElement>(pane, "#safety-appeal-body");
const primaryOf = (pane: HTMLElement) =>
  q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-primary']");
const errorOf = (pane: HTMLElement) => q(pane, "#safety-appeal-error");

beforeEach(() => {
  resetSafetyStore();
  vi.clearAllMocks();
});
afterEach(() => {
  resetSafetyStore();
  document.body.replaceChildren();
});

describe("appeals store", () => {
  it("reads appeals with the history, and a failure is its own", async () => {
    const getMyAppeals = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([appeal({ id: "A" })]);
    const getOwnModeration = vi.fn().mockResolvedValue([row({ id: 1 })]);
    refreshOwnModeration({ getOwnModeration, getMyAppeals });
    await flush();
    expectConsole("warn", "Failed to load own appeals");
    expect(safetyStore.getState()).toMatchObject({ appealsFailed: true, historyFailed: false });

    refreshOwnModeration();
    await flush();
    expect(safetyStore.getState().appeals?.map((a) => a.id)).toEqual(["A"]);
    expect(safetyStore.getState().appealsFailed).toBe(false);
  });

  it("drops an appeals answer that lands after sign-out", async () => {
    let resolve!: (v: MyAppeal[]) => void;
    const getMyAppeals = vi.fn(() => new Promise<MyAppeal[]>((r) => (resolve = r)));
    refreshOwnModeration({ getOwnModeration: vi.fn().mockResolvedValue([]), getMyAppeals });
    resetSafetyStore();
    resolve([appeal({ id: "A" })]);
    await flush();
    expect(safetyStore.getState().appeals).toBeNull();
  });

  it("appeal_status patches the appeal and its history row, then re-reads", async () => {
    const getOwnModeration = vi
      .fn()
      .mockResolvedValue([row({ id: 1, appealable: false, appeal: { id: "A", state: "open" } })]);
    const getMyAppeals = vi.fn().mockResolvedValue([appeal({ id: "A" }), appeal({ id: "B" })]);
    refreshOwnModeration({ getOwnModeration, getMyAppeals });
    await flush();

    applyAppealStatus({ id: "A", state: "upheld", decision_note: "stands" });
    const s = safetyStore.getState();
    expect(s.appeals?.[0]).toMatchObject({ state: "upheld", decision_note: "stands" });
    expect(s.appeals?.[1]?.state).toBe("open");
    expect(s.history?.[0]?.appeal).toEqual({ id: "A", state: "upheld" });

    getOwnModeration.mockClear();
    getMyAppeals.mockClear();
    const api = { getOwnModeration, getMyAppeals, listBlocks: vi.fn() };
    handleAppealStatus(api, {
      id: "B",
      state: "withdrawn",
      decision_note: null,
    });
    expect(safetyStore.getState().appeals?.[1]?.state).toBe("withdrawn");
    expect(getOwnModeration).toHaveBeenCalledTimes(1);
    expect(getMyAppeals).toHaveBeenCalledTimes(1);
  });
});

describe("appealBody", () => {
  it("sends line breaks and tabs as spaces, since the server refuses control characters", () => {
    expect(appealBody("  I was\r\nquoting\tsomeone\u0007 ")).toBe("I was quoting someone");
  });
});

describe("filing an appeal", () => {
  it("offers Appeal only where the server says a row is appealable, a lapsed ban included", async () => {
    const { pane, ac } = await mount([
      row({ id: 1 }),
      row({ id: 2, appealable: false, appeal: { id: "A", state: "open" } }),
      row({ id: 3, kind: "ban", expires_at: null, lifted_at: "2026-09-03T00:00:00Z" }),
      row({ id: 4, kind: "warning", expires_at: null, appealable: false }),
    ]);
    const buttons = [...pane.querySelectorAll<HTMLButtonElement>(".safety-appeal-open")];
    expect(buttons.map((b) => b.dataset["testid"])).toEqual([
      "safety-appeal-open-1",
      "safety-appeal-open-3",
    ]);
    // Each Appeal names its action: several share the visible word.
    expect(buttons[1]!.getAttribute("aria-label")).toMatch(/^Appeal Ban, Sep 1, 2026/);
    // The routing disclosure and the paths that have no appeal here.
    expect(pane.textContent).toContain("goes only to this server's moderators");
    expect(pane.textContent).toContain("Kicks can't be appealed");
    expect(pane.textContent).toContain("contact the server's operator directly");
    ac.abort();
  });

  it("shows the sanction, sends its ledger id and the text, then announces and re-reads", async () => {
    const { pane, ac, api } = await mount([row({ id: 7, reason: "spam" })]);
    expect(panelOf(pane).hidden).toBe(true);
    q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-open-7']").click();
    expect(panelOf(pane).hidden).toBe(false);
    expect(panelOf(pane).textContent).toMatch(/Appeal: Timeout, Sep 1, 2026.*Reason: spam/);
    expect(document.activeElement).toBe(bodyOf(pane));

    bodyOf(pane).value = "It was a\nquote";
    api.getOwnModeration.mockClear();
    primaryOf(pane).click();
    expect(primaryOf(pane).getAttribute("aria-busy")).toBe("true");
    primaryOf(pane).click(); // pending: no second request
    await flush();
    expect(api.fileAppeal).toHaveBeenCalledTimes(1);
    expect(api.fileAppeal).toHaveBeenCalledWith(7, "It was a quote", ac.signal);
    expect(panelOf(pane).hidden).toBe(true);
    expect(pane.textContent).toContain("Appeal sent.");
    expect(document.activeElement?.id).toBe("safety-appeals-heading");
    expect(api.getOwnModeration).toHaveBeenCalledTimes(1);
    // The next action is not held up by the finished one.
    q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-open-7']").click();
    expect(panelOf(pane).hidden).toBe(false);
    expect(primaryOf(pane).hasAttribute("aria-busy")).toBe(false);
    ac.abort();
  });

  it("keeps the draft after a failed send and never resends by itself", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 })]);
    api.fileAppeal.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-open-7']").click();
    bodyOf(pane).value = "please";
    primaryOf(pane).focus();
    primaryOf(pane).click();
    await flush();
    expect(panelOf(pane).hidden).toBe(false);
    expect(bodyOf(pane).value).toBe("please");
    expect(errorOf(pane).textContent).toBe("Your appeal wasn't sent. Try again.");
    expect(errorOf(pane).getAttribute("role")).toBe("alert");
    expect(bodyOf(pane).getAttribute("aria-describedby")).toContain("safety-appeal-error");
    expect(document.activeElement).toBe(primaryOf(pane));
    expect(primaryOf(pane).hasAttribute("aria-disabled")).toBe(false);
    await flush();
    expect(api.fileAppeal).toHaveBeenCalledTimes(1);

    primaryOf(pane).click();
    await flush();
    expect(api.fileAppeal).toHaveBeenCalledTimes(2);
    expect(panelOf(pane).hidden).toBe(true);
    ac.abort();
  });

  it.each([
    [
      new ApiClientError(409, "ALREADY_APPEALED", "x"),
      "An appeal against this action already exists.",
      true,
    ],
    [
      new ApiClientError(429, "RATE_LIMITED", "x"),
      "You've filed 3 appeals in the last 24 hours.",
      false,
    ],
    [new ApiClientError(404, "NOT_FOUND", "x"), "This action can't be appealed any more.", true],
    [new ApiClientError(403, "FORBIDDEN", "x"), "This action can't be appealed any more.", false],
  ])("names the refusal %s", async (err, text, rereads) => {
    const { pane, ac, api } = await mount([row({ id: 7 })]);
    api.fileAppeal.mockRejectedValueOnce(err);
    q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-open-7']").click();
    api.getOwnModeration.mockClear();
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).textContent).toContain(text);
    expect(api.getOwnModeration).toHaveBeenCalledTimes(rereads ? 1 : 0);
    ac.abort();
  });

  it("returns focus to the text the server refused", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 })]);
    api.fileAppeal.mockRejectedValueOnce(
      new ApiClientError(400, "BAD_REQUEST", "bad request: body is too long"),
    );
    q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-open-7']").click();
    primaryOf(pane).focus();
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).textContent).toBe(
      "Your appeal wasn't accepted: bad request: body is too long",
    );
    expect(bodyOf(pane).getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(bodyOf(pane));
    ac.abort();
  });

  it("Cancel hides the form and returns focus to its Appeal", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 }), row({ id: 8 })]);
    const open = q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-open-7']");
    open.click();
    bodyOf(pane).value = "about 7";
    q<HTMLButtonElement>(pane, ".safety-appeal-cancel").click();
    expect(panelOf(pane).hidden).toBe(true);
    expect(document.activeElement).toBe(open);
    expect(api.fileAppeal).not.toHaveBeenCalled();
    // Another action's form never carries this one's text.
    q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-open-8']").click();
    expect(bodyOf(pane).value).toBe("");
    ac.abort();
  });

  it("offers no action without a client", async () => {
    const { pane, ac } = await mount([row({ id: 7 })], [appeal({ id: "A" })], false);
    expect(pane.querySelector(".safety-appeal-open, .safety-appeal-withdraw")).toBeNull();
    ac.abort();
  });
});

describe("tracking appeals", () => {
  it("lists each state; the note only once decided, never who decided", async () => {
    const leaky = {
      ...appeal({
        id: "D",
        state: "upheld",
        decision_note: "stands",
        decided_at: "2026-09-04T00:00:00Z",
      }),
      assignee_id: 4242,
      decided_by: 4343,
    } as MyAppeal;
    const { pane, ac } = await mount(
      [],
      [
        appeal({ id: "O" }),
        appeal({ id: "S", state: "assigned" }),
        leaky,
        appeal({ id: "R", state: "overturned", action_kind: "removal", decision_note: "" }),
        appeal({ id: "W", state: "withdrawn" }),
        appeal({ id: "E", action_kind: "", action_reason: "", action_created_at: "" }),
      ],
    );
    const text = (id: string) => q(pane, `[data-testid='safety-appeal-${id}']`).textContent;
    expect(text("O")).toContain("Status: open");
    expect(text("S")).toContain("Status: under review");
    expect(text("D")).toMatch(/Status: upheld.*Decided Sep 4, 2026/);
    expect(text("D")).toContain("Moderator's note: stands");
    expect(text("R")).toContain("doesn't restore the removed message");
    expect(text("R")).not.toContain("Moderator's note");
    expect(text("W")).toContain("Status: withdrawn");
    expect(text("E")).toContain("Deleted action");
    expect(text("E")).toContain("no longer exists");
    expect(pane.textContent).not.toMatch(/4242|4343/);
    const withdrawable = [...pane.querySelectorAll(".safety-appeal-withdraw")].map(
      (b) => b.closest("li")!.dataset["testid"],
    );
    expect(withdrawable).toEqual(["safety-appeal-O", "safety-appeal-S", "safety-appeal-E"]);
    q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-E'] .safety-appeal-withdraw").click();
    expect(panelOf(pane).textContent).toContain("no longer exists");
    expect(panelOf(pane).textContent).not.toContain("No reason was given.");
    ac.abort();
  });

  it("shows loading, then a failure with its own retry", async () => {
    const { pane, ac, api } = await mount([]);
    expect(pane.textContent).toContain("You haven't filed any appeals.");
    api.getMyAppeals.mockRejectedValueOnce(new Error("offline"));
    refreshOwnModeration();
    await flush();
    expectConsole("warn", "Failed to load own appeals");
    expect(pane.textContent).toContain("Your appeals couldn't be loaded.");
    const retry = pane.querySelectorAll<HTMLButtonElement>(".safety-retry")[1]!;
    expect(retry.hidden).toBe(false);
    api.getMyAppeals.mockResolvedValueOnce([appeal({ id: "O" })]);
    retry.click();
    await flush();
    expect(retry.hidden).toBe(true);
    expect(pane.querySelector("[data-testid='safety-appeal-O']")).not.toBeNull();
    ac.abort();
  });

  it("confirms before withdrawing, then announces and re-reads", async () => {
    const { pane, ac, api } = await mount([], [appeal({ id: "O" })]);
    q<HTMLButtonElement>(pane, ".safety-appeal-withdraw").click();
    expect(panelOf(pane).hidden).toBe(false);
    expect(panelOf(pane).textContent).toContain("You can't appeal this action again");
    expect(bodyOf(pane).closest<HTMLElement>(".safety-appeal-fields")!.hidden).toBe(true);
    expect(document.activeElement).toBe(primaryOf(pane));
    expect(api.withdrawAppeal).not.toHaveBeenCalled();

    api.getMyAppeals.mockResolvedValueOnce([appeal({ id: "O", state: "withdrawn" })]);
    primaryOf(pane).click();
    await flush();
    expect(api.withdrawAppeal).toHaveBeenCalledWith("O", ac.signal);
    expect(panelOf(pane).hidden).toBe(true);
    expect(pane.textContent).toContain("Appeal withdrawn.");
    expect(q(pane, "[data-testid='safety-appeal-O']").textContent).toContain("Status: withdrawn");
    expect(document.activeElement?.id).toBe("safety-appeals-heading");
    ac.abort();
  });

  it("says a closed appeal can no longer be withdrawn", async () => {
    const { pane, ac, api } = await mount([], [appeal({ id: "O" })]);
    api.withdrawAppeal.mockRejectedValueOnce(new ApiClientError(409, "CONFLICT", "x"));
    q<HTMLButtonElement>(pane, ".safety-appeal-withdraw").click();
    api.getMyAppeals.mockClear();
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).textContent).toBe("This appeal can no longer be withdrawn.");
    expect(api.getMyAppeals).toHaveBeenCalledTimes(1);
    ac.abort();
  });

  it("keeps focus on the same control when a live update re-renders the list", async () => {
    const { pane, ac } = await mount([], [appeal({ id: "O" }), appeal({ id: "S" })]);
    const second = () =>
      q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-S'] .safety-appeal-withdraw");
    const before = second();
    before.focus();
    applyAppealStatus({ id: "O", state: "assigned", decision_note: null });
    await flush();
    expect(second()).not.toBe(before);
    expect(document.activeElement).toBe(second());

    // Its own row leaves the withdrawable states: focus falls back to the heading.
    applyAppealStatus({ id: "S", state: "upheld", decision_note: null });
    await flush();
    expect(document.activeElement?.id).toBe("safety-appeals-heading");
    ac.abort();
  });
});
