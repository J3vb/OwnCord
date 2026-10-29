import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stores/ui.store", () => ({ openSettings: vi.fn() }));

import { expectConsole } from "../../../tests/helpers/console";
import { pinZone } from "../../../tests/helpers/tz-pin";
import { ApiClientError, type MyAppeal, type OwnModerationAction } from "../../lib/api";
import { appealBody, fitsAppealLimit } from "./Appeals";
import { renderSafetyTab } from "./SafetyTab";
import { applyAppealStatus, refreshOwnModeration, resetSafetyStore, safetyStore } from "./store";
import { handleAppealStatus } from "./wsHandlers";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let restoreTZ: () => void;

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
  restoreTZ = pinZone("UTC");
  resetSafetyStore();
  vi.clearAllMocks();
});
afterEach(() => {
  resetSafetyStore();
  document.body.replaceChildren();
  restoreTZ();
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
    // Those rules wait behind a closed "How appeals work" disclosure.
    const rules = [...pane.querySelectorAll("details")].find((d) =>
      d.querySelector("summary")!.textContent.startsWith("How appeals work"),
    )!;
    expect(rules.open).toBe(false);
    expect(rules.textContent).toContain("Kicks can't be appealed");
    expect(rules.textContent).toContain("goes only to this server's moderators");
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
      "Your appeal wasn't accepted: Bad request: body is too long",
    );
    expect(bodyOf(pane).getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(bodyOf(pane));
    ac.abort();
  });

  it("keeps a draft over the server's byte limit, says so and sends nothing", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 })]);
    q<HTMLButtonElement>(pane, "[data-testid='safety-appeal-open-7']").click();
    const draft = "誤".repeat(3000);
    expect(draft.length).toBeLessThanOrEqual(4000);
    bodyOf(pane).value = draft;
    primaryOf(pane).focus();
    primaryOf(pane).click();
    await flush();
    expect(api.fileAppeal).not.toHaveBeenCalled();
    expect(errorOf(pane).textContent).toBe(
      "Your appeal is too long to send. Shorten it and try again.",
    );
    expect(bodyOf(pane).value).toBe(draft);
    expect(bodyOf(pane).getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(bodyOf(pane));
    ac.abort();
  });

  it("measures the request the server reads, in UTF-8 bytes of its JSON", () => {
    expect(fitsAppealLimit(7, "a".repeat(4000))).toBe(true);
    expect(fitsAppealLimit(7, "誤".repeat(2720))).toBe(true);
    expect(fitsAppealLimit(7, "誤".repeat(2740))).toBe(false);
    expect(fitsAppealLimit(7, '"'.repeat(4000))).toBe(true);
    expect(fitsAppealLimit(7, '"'.repeat(4096))).toBe(false);
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

const attrsOf = (el: Element): Record<string, string> =>
  Object.fromEntries(el.getAttributeNames().map((n) => [n, el.getAttribute(n) ?? ""]));

const openBtn = (pane: HTMLElement, id: number) =>
  q<HTMLButtonElement>(pane, `[data-testid='safety-appeal-open-${id}']`);
const cancelOf = (pane: HTMLElement) => q<HTMLButtonElement>(pane, ".safety-appeal-cancel");

describe("appeals section markup", () => {
  it("builds the section, panel and list with their classes, roles and labels", async () => {
    const { pane, ac } = await mount([row({ id: 7 })], [appeal({ id: "O" })]);
    const section = q(pane, "section.safety-appeals");
    expect(attrsOf(section)).toMatchObject({
      class: "safety-appeals",
      "aria-labelledby": "safety-appeals-heading",
    });
    expect(attrsOf(q(section, "h3"))).toMatchObject({
      class: "safety-heading",
      id: "safety-appeals-heading",
      tabindex: "-1",
    });
    const status = q(section, ":scope > p.setting-desc");
    expect(attrsOf(status)).toEqual({ class: "setting-desc", role: "status" });
    const retry = q(section, ":scope > button");
    expect(attrsOf(retry)).toMatchObject({ type: "button", class: "ac-btn safety-retry" });
    expect(attrsOf(q(section, ":scope > ul"))).toEqual({
      class: "safety-history safety-appeals-list",
      "aria-label": "Your appeals",
    });
    expect(attrsOf(q(section, ":scope > div.sr-only"))).toEqual({
      class: "sr-only",
      role: "status",
    });

    const panel = panelOf(pane);
    expect(attrsOf(panel)).toMatchObject({
      class: "safety-appeal-panel",
      role: "group",
      "aria-labelledby": "safety-appeal-panel-title",
    });
    expect(attrsOf(q(panel, "#safety-appeal-panel-title"))).toEqual({
      class: "safety-appeal-title",
      id: "safety-appeal-panel-title",
    });
    const kids = [...panel.children];
    expect(kids[1]!.tagName).toBe("P");
    expect(attrsOf(kids[1]!)).toEqual({ class: "setting-desc" });
    expect(attrsOf(q(panel, "label"))).toEqual({ for: "safety-appeal-body" });
    expect(attrsOf(bodyOf(pane))).toEqual({
      id: "safety-appeal-body",
      class: "form-input safety-appeal-body",
      rows: "4",
      maxlength: "4000",
      "aria-describedby": "safety-appeal-body-hint safety-appeal-error",
      "data-testid": "safety-appeal-body",
    });
    expect(attrsOf(q(panel, "#safety-appeal-body-hint"))).toEqual({
      class: "setting-desc",
      id: "safety-appeal-body-hint",
    });
    expect(attrsOf(q(panel, ".safety-appeal-fields"))).toMatchObject({
      class: "safety-appeal-fields",
    });
    expect(attrsOf(kids[3]!)).toMatchObject({ class: "setting-desc" });
    expect(kids[3]!.textContent).toBe("You can't appeal this action again after withdrawing.");
    expect(attrsOf(errorOf(pane))).toEqual({
      class: "safety-appeal-status",
      id: "safety-appeal-error",
      role: "alert",
    });
    expect(attrsOf(primaryOf(pane))).toEqual({
      type: "button",
      class: "ac-btn",
      "data-testid": "safety-appeal-primary",
    });
    expect(attrsOf(cancelOf(pane))).toEqual({
      type: "button",
      class: "ac-btn safety-appeal-cancel",
    });
    expect(attrsOf(q(panel, ".safety-appeal-actions"))).toEqual({ class: "safety-appeal-actions" });

    const rules = [...section.querySelectorAll("details p")];
    expect(rules.map((p) => attrsOf(p))).toEqual([
      { class: "setting-desc" },
      { class: "setting-desc" },
    ]);
    expect(attrsOf(openBtn(pane, 7))).toEqual({
      type: "button",
      class: "ac-btn safety-appeal-open",
      "data-focus-key": "appeal-7",
      "aria-label": "Appeal Timeout, Sep 1, 2026, 10:00 AM",
      "data-testid": "safety-appeal-open-7",
    });
    expect(attrsOf(q(pane, "[data-testid='safety-appeal-O'] .safety-appeal-withdraw"))).toEqual({
      type: "button",
      class: "ac-btn safety-appeal-withdraw",
      "data-focus-key": "withdraw-O",
      "aria-label": "Withdraw appeal (Timeout, Sep 1, 2026, 10:00 AM)",
    });
    ac.abort();
  });

  it("shows a row's action, status line, decision and the note's own styling", async () => {
    const { pane, ac } = await mount(
      [],
      [
        appeal({ id: "A", state: "assigned" }),
        appeal({
          id: "D",
          state: "overturned",
          action_kind: "removal",
          decision_note: "my mistake",
          decided_at: "2026-09-04T00:00:00Z",
        }),
        appeal({ id: "T", state: "overturned", decision_note: null }),
        appeal({ id: "U", state: "upheld", action_kind: "removal" }),
        appeal({ id: "E", action_kind: "", action_reason: "", action_created_at: "" }),
      ],
    );
    const li = (id: string) => q(pane, `[data-testid='safety-appeal-${id}']`);
    expect(attrsOf(li("A"))).toEqual({
      class: "safety-history-row",
      "data-testid": "safety-appeal-A",
    });
    const [head, reason, parts] = [...li("A").children];
    expect(attrsOf(head!)).toEqual({ class: "safety-history-head" });
    expect(head!.textContent).toBe("Timeout · Sep 1, 2026, 10:00 AM");
    expect(attrsOf(reason!)).toEqual({ class: "safety-history-reason" });
    expect(reason!.textContent).toBe("Reason: flood");
    expect(attrsOf(parts!)).toEqual({ class: "setting-desc" });
    expect(parts!.textContent).toBe("Status: under review · Filed Sep 2, 2026, 10:00 AM");

    expect([...li("D").children][2]!.textContent).toBe(
      "Status: overturned · Filed Sep 2, 2026, 10:00 AM · Decided Sep 4, 2026, 12:00 AM",
    );
    const note = [...li("D").children][3]!;
    expect(attrsOf(note)).toEqual({ class: "setting-desc" });
    expect(note.textContent).toBe("Moderator's note: my mistake");
    const overturned = [...li("D").children][4]!;
    expect(attrsOf(overturned)).toEqual({ class: "setting-desc" });
    expect(overturned.textContent).toContain("doesn't restore the removed message");

    // The removal notice needs both an overturned appeal and a removal.
    expect(li("T").textContent).not.toContain("doesn't restore");
    expect(li("U").textContent).not.toContain("doesn't restore");

    // A deleted action shows no date beside its kind.
    expect([...li("E").children][0]!.textContent).toBe("Deleted action");
    ac.abort();
  });

  it("says no reason was given for a sanction without one, and quotes a given one", async () => {
    const { pane, ac } = await mount([row({ id: 1, reason: "" }), row({ id: 2, reason: "spam" })]);
    openBtn(pane, 1).click();
    expect(panelOf(pane).textContent).toContain("No reason was given.");
    expect(panelOf(pane).textContent).not.toContain("Reason: ");
    cancelOf(pane).click();
    openBtn(pane, 2).click();
    expect(panelOf(pane).textContent).toContain("Reason: spam");
    expect(panelOf(pane).textContent).not.toContain("No reason was given.");
    ac.abort();
  });

  it("lists the appeals already in the store when it is first built", () => {
    safetyStore.setState((s) => ({ ...s, appeals: [appeal({ id: "P" })] }));
    safetyStore.flush();
    const ac = new AbortController();
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    renderSafetyTab(pane, ac.signal, null);
    expect(pane.querySelector("[data-testid='safety-appeal-P']")).not.toBeNull();
    // Listed appeals leave the status line empty.
    expect(q(pane, "section.safety-appeals > p[role='status']").textContent).toBe("");
    ac.abort();
  });

  it("keeps its rows when something unrelated to appeals changes", async () => {
    const { pane, ac } = await mount([], [appeal({ id: "O" })]);
    const before = q(pane, "[data-testid='safety-appeal-O']");
    safetyStore.setState((s) => ({ ...s, historyFailed: !s.historyFailed }));
    safetyStore.flush();
    expect(q(pane, "[data-testid='safety-appeal-O']")).toBe(before);
    ac.abort();
  });

  it("stops following the store and ignores clicks once its signal aborts", async () => {
    const { pane, ac, api } = await mount(
      [row({ id: 7 }), row({ id: 8, kind: "ban" })],
      [appeal({ id: "O" })],
    );
    const withdrawBtn = q<HTMLButtonElement>(pane, ".safety-appeal-withdraw");
    const retry = q<HTMLButtonElement>(pane, "section.safety-appeals > button");
    openBtn(pane, 7).click();
    ac.abort();

    safetyStore.setState((s) => ({ ...s, appeals: [] }));
    safetyStore.flush();
    expect(pane.querySelector("[data-testid='safety-appeal-O']")).not.toBeNull();

    api.getOwnModeration.mockClear();
    retry.click();
    expect(api.getOwnModeration).not.toHaveBeenCalled();
    cancelOf(pane).click();
    expect(panelOf(pane).hidden).toBe(false);
    primaryOf(pane).click();
    expect(api.fileAppeal).not.toHaveBeenCalled();
    withdrawBtn.click();
    expect(panelOf(pane).textContent).toContain("Appeal: Timeout");
    openBtn(pane, 8).click();
    expect(panelOf(pane).textContent).toContain("Appeal: Timeout");
    expect(panelOf(pane).textContent).not.toContain("Ban");
  });

  it("returns focus to the Appeal that was used, not the first one", async () => {
    const { pane, ac } = await mount([row({ id: 7 }), row({ id: 8 })]);
    openBtn(pane, 8).click();
    cancelOf(pane).click();
    expect(document.activeElement).toBe(openBtn(pane, 8));
    ac.abort();
  });
});

describe("appeal form while a request is in flight", () => {
  it("labels and locks both buttons, clears an old error, and unlocks after a failure", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 })]);
    api.fileAppeal.mockRejectedValueOnce(new TypeError("offline"));
    openBtn(pane, 7).click();
    expect(primaryOf(pane).textContent).toBe("Send appeal");
    expect(cancelOf(pane).textContent).toBe("Cancel");
    expect(primaryOf(pane).hasAttribute("aria-disabled")).toBe(false);
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).classList.contains("form-error")).toBe(true);
    expect(bodyOf(pane).hasAttribute("aria-invalid")).toBe(false);

    const gate = deferred<{ id: string }>();
    api.fileAppeal.mockReturnValueOnce(gate.promise);
    primaryOf(pane).click();
    expect(errorOf(pane).textContent).toBe("");
    expect(errorOf(pane).classList.contains("form-error")).toBe(false);
    expect(primaryOf(pane).textContent).toBe("Sending…");
    expect(primaryOf(pane).getAttribute("aria-busy")).toBe("true");
    expect(primaryOf(pane).getAttribute("aria-disabled")).toBe("true");
    expect(cancelOf(pane).getAttribute("aria-disabled")).toBe("true");

    // Cancel and the other controls do nothing until the request ends.
    cancelOf(pane).click();
    expect(panelOf(pane).hidden).toBe(false);
    gate.reject(new TypeError("offline"));
    await flush();
    expect(primaryOf(pane).textContent).toBe("Send appeal");
    expect(primaryOf(pane).hasAttribute("aria-busy")).toBe(false);
    expect(primaryOf(pane).hasAttribute("aria-disabled")).toBe(false);
    expect(cancelOf(pane).hasAttribute("aria-disabled")).toBe(false);
    ac.abort();
  });

  it("ignores Appeal and Withdraw clicks while a send is pending", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 }), row({ id: 8 })], [appeal({ id: "O" })]);
    const gate = deferred<{ id: string }>();
    api.fileAppeal.mockReturnValueOnce(gate.promise);
    openBtn(pane, 7).click();
    bodyOf(pane).value = "my draft";
    primaryOf(pane).click();
    openBtn(pane, 8).click();
    q<HTMLButtonElement>(pane, ".safety-appeal-withdraw").click();
    expect(panelOf(pane).textContent).toContain("Appeal: Timeout");
    expect(bodyOf(pane).value).toBe("my draft");
    expect(primaryOf(pane).textContent).toBe("Sending…");
    gate.resolve({ id: "x" });
    await flush();
    ac.abort();
  });

  it("clears the invalid mark when a later failure is not about the text", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 })]);
    api.fileAppeal
      .mockRejectedValueOnce(new ApiClientError(400, "BAD_REQUEST", "bad body"))
      .mockRejectedValueOnce(new ApiClientError(429, "RATE_LIMITED", "x"));
    openBtn(pane, 7).click();
    primaryOf(pane).click();
    await flush();
    expect(bodyOf(pane).getAttribute("aria-invalid")).toBe("true");
    primaryOf(pane).focus();
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).textContent).toContain("filed 3 appeals");
    expect(bodyOf(pane).hasAttribute("aria-invalid")).toBe(false);
    expect(document.activeElement).toBe(primaryOf(pane));
    ac.abort();
  });

  it("opens fresh: no old error, no invalid mark, and the text cleared for a new form", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 })], [appeal({ id: "O" })]);
    api.fileAppeal.mockRejectedValueOnce(new ApiClientError(400, "BAD_REQUEST", "bad body"));
    openBtn(pane, 7).click();
    bodyOf(pane).value = "draft";
    primaryOf(pane).click();
    await flush();
    cancelOf(pane).click();

    q<HTMLButtonElement>(pane, ".safety-appeal-withdraw").click();
    expect(errorOf(pane).textContent).toBe("");
    expect(errorOf(pane).classList.contains("form-error")).toBe(false);
    expect(bodyOf(pane).hasAttribute("aria-invalid")).toBe(false);
    // The confirmation leaves the form's text as it was.
    expect(bodyOf(pane).value).toBe("draft");
    cancelOf(pane).click();

    openBtn(pane, 7).click();
    expect(bodyOf(pane).value).toBe("");
    expect(errorOf(pane).textContent).toBe("");
    ac.abort();
  });

  it("drops the outcome of a request whose section was closed meanwhile", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 })]);
    const gate = deferred<{ id: string }>();
    api.fileAppeal.mockReturnValueOnce(gate.promise);
    openBtn(pane, 7).click();
    primaryOf(pane).click();
    ac.abort();
    api.getOwnModeration.mockClear();
    gate.resolve({ id: "x" });
    await flush();
    expect(panelOf(pane).hidden).toBe(false);
    expect(pane.textContent).not.toContain("Appeal sent.");
    expect(api.getOwnModeration).not.toHaveBeenCalled();
  });

  it("drops a failure that lands after the section was closed", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 })]);
    const gate = deferred<{ id: string }>();
    api.fileAppeal.mockReturnValueOnce(gate.promise);
    openBtn(pane, 7).click();
    primaryOf(pane).click();
    ac.abort();
    api.getOwnModeration.mockClear();
    gate.reject(new ApiClientError(404, "NOT_FOUND", "x"));
    await flush();
    expect(errorOf(pane).textContent).toBe("");
    expect(primaryOf(pane).getAttribute("aria-busy")).toBe("true");
    expect(api.getOwnModeration).not.toHaveBeenCalled();
  });
});

describe("withdraw confirmation while a request is in flight", () => {
  it("labels the confirmation, locks it, and unlocks after a failure", async () => {
    const { pane, ac, api } = await mount([], [appeal({ id: "O" })]);
    api.withdrawAppeal.mockRejectedValueOnce(new ApiClientError(500, "INTERNAL", "x"));
    q<HTMLButtonElement>(pane, ".safety-appeal-withdraw").click();
    expect(primaryOf(pane).textContent).toBe("Withdraw appeal");
    expect(cancelOf(pane).textContent).toBe("Keep appeal");
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).textContent).toBe("Your appeal wasn't withdrawn. Try again.");
    expect(errorOf(pane).classList.contains("form-error")).toBe(true);
    expect(primaryOf(pane).textContent).toBe("Withdraw appeal");

    const gate = deferred<undefined>();
    api.withdrawAppeal.mockReturnValueOnce(gate.promise);
    api.getMyAppeals.mockClear();
    primaryOf(pane).click();
    expect(errorOf(pane).textContent).toBe("");
    expect(primaryOf(pane).textContent).toBe("Withdrawing…");
    expect(primaryOf(pane).getAttribute("aria-busy")).toBe("true");
    cancelOf(pane).click();
    expect(panelOf(pane).hidden).toBe(false);
    gate.reject(new Error("offline"));
    await flush();
    expect(errorOf(pane).textContent).toBe("Your appeal wasn't withdrawn. Try again.");
    expect(primaryOf(pane).hasAttribute("aria-busy")).toBe(false);
    expect(primaryOf(pane).textContent).toBe("Withdraw appeal");
    // An unexplained failure is not a reason to re-read.
    expect(api.getMyAppeals).not.toHaveBeenCalled();
    ac.abort();
  });

  it("names a missing appeal, and re-reads for it but not for other refusals", async () => {
    const { pane, ac, api } = await mount([], [appeal({ id: "O" })]);
    q<HTMLButtonElement>(pane, ".safety-appeal-withdraw").click();
    api.withdrawAppeal.mockRejectedValueOnce(new ApiClientError(404, "NOT_FOUND", "x"));
    api.getMyAppeals.mockClear();
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).textContent).toBe("This appeal no longer exists.");
    expect(api.getMyAppeals).toHaveBeenCalledTimes(1);

    api.withdrawAppeal.mockRejectedValueOnce(new ApiClientError(500, "INTERNAL", "x"));
    api.getMyAppeals.mockClear();
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).textContent).toBe("Your appeal wasn't withdrawn. Try again.");
    expect(api.getMyAppeals).not.toHaveBeenCalled();
    ac.abort();
  });

  it("drops the outcome of a withdrawal whose section was closed meanwhile", async () => {
    const { pane, ac, api } = await mount([], [appeal({ id: "O" }), appeal({ id: "P" })]);
    const gate = deferred<undefined>();
    api.withdrawAppeal.mockReturnValueOnce(gate.promise);
    q<HTMLButtonElement>(pane, ".safety-appeal-withdraw").click();
    primaryOf(pane).click();
    ac.abort();
    api.getMyAppeals.mockClear();
    gate.resolve(undefined);
    await flush();
    expect(panelOf(pane).hidden).toBe(false);
    expect(pane.textContent).not.toContain("Appeal withdrawn.");
    expect(api.getMyAppeals).not.toHaveBeenCalled();
  });

  it("drops a withdrawal failure that lands after the section was closed", async () => {
    const { pane, ac, api } = await mount([], [appeal({ id: "O" })]);
    const gate = deferred<undefined>();
    api.withdrawAppeal.mockReturnValueOnce(gate.promise);
    q<HTMLButtonElement>(pane, ".safety-appeal-withdraw").click();
    primaryOf(pane).click();
    ac.abort();
    api.getMyAppeals.mockClear();
    gate.reject(new ApiClientError(404, "NOT_FOUND", "x"));
    await flush();
    expect(errorOf(pane).textContent).toBe("");
    expect(api.getMyAppeals).not.toHaveBeenCalled();
  });
});

describe("fitsAppealLimit at the boundary", () => {
  it("accepts a request of exactly the limit and refuses one byte more", () => {
    const base = new TextEncoder().encode(JSON.stringify({ action_id: 7, body: "" })).length;
    expect(fitsAppealLimit(7, "a".repeat(8192 - base))).toBe(true);
    expect(fitsAppealLimit(7, "a".repeat(8193 - base))).toBe(false);
  });
});

describe("refusals to file", () => {
  it("shows the generic failure for a server error and for a bad request without text", async () => {
    const { pane, ac, api } = await mount([row({ id: 7 })]);
    openBtn(pane, 7).click();
    api.fileAppeal.mockRejectedValueOnce(new ApiClientError(500, "BAD_REQUEST", "something odd"));
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).textContent).toBe("Your appeal wasn't sent. Try again.");

    api.fileAppeal.mockRejectedValueOnce(new ApiClientError(400, "INTERNAL", ""));
    primaryOf(pane).click();
    await flush();
    expect(errorOf(pane).textContent).toBe("Your appeal wasn't sent. Try again.");
    ac.abort();
  });
});
