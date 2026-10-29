// A report's moderator actions: who is offered what, the markup each control
// carries, what is sent, and how the draft and the disabled state follow the
// reader's input.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "@lib/types";
import { authStore } from "@stores/auth.store";
import { resetChannelsStore, setRoles } from "@stores/channels.store";
import { moderationText as t } from "../../i18n/moderation";
import type { HistoryEntry, ReportDetail } from "./api";
import {
  buildActionForms,
  emptyActionDraft,
  lengthSeconds,
  type ActionDraft,
  type ActionOptions,
  type ActionView,
  type ActionWrite,
} from "./ActionForms";
import { dateText } from "./Evidence";

const ME = 7;
const SUBJECT = 4;
const REPORTER = 3;
const FUTURE = "2099-01-01 00:00:00";

const ALL = Permission.MANAGE_MESSAGES | Permission.KICK_MEMBERS | Permission.BAN_MEMBERS;

function report(over: Partial<ReportDetail> = {}): ReportDetail {
  return {
    id: "r1",
    reporterId: REPORTER,
    subjectId: SUBJECT,
    targetType: "user",
    channelId: null,
    detail: "",
    state: "assigned",
    outcome: "",
    assigneeId: ME,
    createdAt: "2026-09-05 10:00:00",
    closedAt: null,
    evidence: {} as ReportDetail["evidence"],
    notes: [],
    history: [],
    ...over,
  };
}

const timeoutEntry = (liftedAt: string | null = null): HistoryEntry => ({
  kind: "action",
  action: "timeout",
  reason: "flooding",
  actorId: ME,
  at: "2026-09-05 11:00:00",
  expiresAt: FUTURE,
  liftedAt,
});

const removalEntry: HistoryEntry = {
  kind: "action",
  action: "removal",
  reason: "spam",
  actorId: ME,
  at: "2026-09-05 11:00:00",
  expiresAt: null,
  liftedAt: null,
};

interface Built {
  readonly view: ActionView;
  readonly root: HTMLElement;
  readonly writes: ActionWrite[];
  readonly draft: ActionDraft;
  readonly abort: AbortController;
  readonly refocus: ReturnType<typeof vi.fn>;
}

function build(
  detail: ReportDetail,
  over: { accept?: boolean; draft?: ActionDraft; me?: number } = {},
): Built {
  const writes: ActionWrite[] = [];
  const abort = new AbortController();
  const draft = over.draft ?? emptyActionDraft();
  const refocus = vi.fn((_key: string): HTMLElement | null => null);
  const options: ActionOptions = {
    detail,
    me: over.me ?? ME,
    draft,
    onWrite: (w) => {
      writes.push(w);
      return over.accept ?? true;
    },
    signal: abort.signal,
    refocus,
    now: 0,
  };
  const view = buildActionForms(options);
  const root = view.element ?? document.createElement("div");
  document.body.appendChild(root);
  return { view, root, writes, draft, abort, refocus };
}

const q = <T extends Element>(root: ParentNode, sel: string): T => root.querySelector<T>(sel)!;
const qa = <T extends Element>(root: ParentNode, sel: string): T[] => [
  ...root.querySelectorAll<T>(sel),
];
const focusKey = (b: Built, key: string): HTMLElement =>
  q<HTMLElement>(b.root, `[data-focus=${key}]`);
const labels = (b: Built): string[] =>
  qa<HTMLButtonElement>(b.root, "button").map((x) => x.textContent);

const warnForm = (b: Built): HTMLFormElement => focusKey(b, "warn").closest("form")!;
const timeoutForm = (b: Built): HTMLFormElement => focusKey(b, "amount").closest("form")!;
const amountField = (b: Built): HTMLInputElement => focusKey(b, "amount") as HTMLInputElement;
const unitField = (b: Built): HTMLSelectElement => focusKey(b, "unit") as HTMLSelectElement;
const timeoutError = (b: Built): HTMLElement => q<HTMLElement>(timeoutForm(b), "p.form-error");
const withTimeout = (over: Partial<ReportDetail> = {}): Built =>
  build(report({ history: [timeoutEntry()], ...over }));
const enforceWrap = (b: Built): HTMLElement | null =>
  qa<HTMLElement>(b.root, "div.mod-work-form").at(-1) ?? null;
const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-testid=mod-confirm-dialog]");
const idNumber = (root: ParentNode, sel: string): number =>
  Number(q<HTMLElement>(root, sel).id.split("-").pop());

function submitEvent(form: Element): Event {
  const e = new Event("submit", { bubbles: true, cancelable: true });
  form.dispatchEvent(e);
  return e;
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

const grant = (bits: number): void => {
  setRoles([{ id: 3, name: "Moderator", color: null, permissions: bits }]);
};

beforeEach(() => {
  authStore.setState((prev) => ({
    ...prev,
    user: { id: ME, username: "bob", avatar: null, role: "moderator" },
    isAuthenticated: true,
  }));
  grant(0);
});

afterEach(() => {
  document.body.replaceChildren();
  resetChannelsStore();
});

describe("action drafts and lengths", () => {
  it("starts empty with minutes selected", () => {
    expect(emptyActionDraft()).toStrictEqual({
      warn: "",
      reason: "",
      enforce: "",
      amount: "",
      unit: "minutes",
    });
  });

  it("accepts whole numbers of a unit within one minute to 28 days", () => {
    expect(lengthSeconds("1", "minutes")).toBe(60);
    expect(lengthSeconds(" 2 ", "hours")).toBe(7200);
    expect(lengthSeconds("28", "days")).toBe(28 * 86400);
    expect(lengthSeconds("29", "days")).toBeNull();
    expect(lengthSeconds("0", "minutes")).toBeNull();
    expect(lengthSeconds("1.5", "hours")).toBeNull();
    expect(lengthSeconds("", "days")).toBeNull();
    expect(lengthSeconds("-1", "days")).toBeNull();
  });
});

describe("who is offered the actions", () => {
  it("offers nothing on a report the reader does not hold or cannot lift", () => {
    expect(build(report({ assigneeId: 0 })).view).toEqual({ element: null, takesInput: false });
    expect(build(report({ assigneeId: 99 })).view.element).toBeNull();
    expect(build(report({ state: "closed" })).view.element).toBeNull();
  });

  it("offers nothing for an erased subject or the reader's own filing", () => {
    expect(build(report({ subjectId: 0 })).view.element).toBeNull();
    expect(build(report({ subjectId: -1 })).view.element).toBeNull();
    expect(build(report({ reporterId: ME })).view.element).toBeNull();
  });

  it("offers warning and timeout to the holder of an assigned or open report", () => {
    for (const state of ["assigned", "open"]) {
      const b = build(report({ state }));
      expect(b.view.takesInput).toBe(true);
      expect(labels(b)).toEqual([t("act.warn"), t("act.timeout")]);
    }
  });

  it("offers only the lift on a closed report whose timeout is still running", () => {
    const b = build(report({ state: "closed", history: [timeoutEntry()] }));
    expect(b.view.takesInput).toBe(false);
    expect(labels(b)).toEqual([t("act.lift")]);
  });

  it("does not offer a lift to a reader who is not the holder of an open report", () => {
    const b = build(report({ assigneeId: 99, history: [timeoutEntry()] }));
    expect(b.view.element).toBeNull();
  });

  it("offers no lift once the timeout was lifted", () => {
    const b = build(report({ history: [timeoutEntry("2026-09-06 00:00:00")] }));
    expect(labels(b)).toEqual([t("act.warn"), t("act.timeout")]);
  });
});

describe("action section markup", () => {
  it("is labelled by its heading, numbered once per render", () => {
    const first = build(report());
    const second = build(report());
    const heading = q<HTMLElement>(first.root, "h4");
    expect(first.root.tagName).toBe("SECTION");
    expect(first.root.className).toBe("mod-work");
    expect(first.root.dataset["testid"]).toBe("mod-act");
    expect(heading.textContent).toBe(t("act.title"));
    expect(heading.id).toMatch(/^mod-act-\d+$/);
    expect(first.root.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(idNumber(second.root, "h4")).toBe(idNumber(first.root, "h4") + 1);
    expect(idNumber(first.root, "h4")).toBeGreaterThan(0);
  });

  it("explains the actions before the forms", () => {
    const b = build(report());
    expect(q<HTMLElement>(b.root, ":scope > p").textContent).toBe(t("act.hint"));
  });
});

describe("warning form", () => {
  it("is a plain form with a labelled reason field and a submit button", () => {
    const b = build(report());
    expect(warnForm(b).className).toBe("mod-work-form");
    expect(warnForm(b).getAttribute("novalidate")).toBe("");
    const input = focusKey(b, "warn") as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("text");
    expect(input.className).toBe("form-input");
    expect(input.maxLength).toBe(500);
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.id).toMatch(/^mod-warn-\d+$/);
    expect(q<HTMLLabelElement>(warnForm(b), `label[for="${input.id}"]`).textContent).toBe(
      t("act.warnLabel"),
    );
    const hint = q<HTMLElement>(warnForm(b), `#${input.id}-hint`);
    expect(hint.textContent).toBe(t("act.reasonHint"));
    expect(hint.className).toBe("mod-evidence-status");
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    const submit = focusKey(b, "warn-submit") as HTMLButtonElement;
    expect(submit.type).toBe("submit");
    expect(submit.className).toBe("btn-modal-save");
    expect(submit.textContent).toBe(t("act.warn"));
  });

  it("sends the reason the reader typed, flattened to one clean line", () => {
    const b = build(report());
    const input = focusKey(b, "warn") as HTMLInputElement;
    type(input, "  stop\t\tit\u0007now ");
    expect(b.draft.warn).toBe("  stop\t\tit\u0007now ");
    const e = submitEvent(warnForm(b));
    expect(e.defaultPrevented).toBe(true);
    expect(b.writes).toEqual([{ kind: "warning", reason: "stop it now" }]);
  });

  it("restores a kept draft and stops keeping input once the view is gone", () => {
    const draft = { ...emptyActionDraft(), warn: "kept" };
    const b = build(report(), { draft });
    const input = focusKey(b, "warn") as HTMLInputElement;
    expect(input.value).toBe("kept");
    b.abort.abort();
    type(input, "later");
    expect(b.draft.warn).toBe("kept");
    submitEvent(warnForm(b));
    expect(b.writes).toEqual([]);
  });

  it("disables every control once a write is accepted, and none when it is refused", () => {
    const accepted = build(report());
    submitEvent(warnForm(accepted));
    const all = qa<HTMLButtonElement>(accepted.root, "button");
    expect(all.length).toBe(2);
    expect(all.map((x) => x.getAttribute("aria-disabled"))).toEqual(["true", "true"]);

    const refused = build(report(), { accept: false });
    submitEvent(warnForm(refused));
    expect(
      qa<HTMLButtonElement>(refused.root, "button").map((x) => x.hasAttribute("aria-disabled")),
    ).toEqual([false, false]);
  });
});

describe("timeout form", () => {
  it("is a plain form with a reason, a number and a unit", () => {
    const b = build(report());
    expect(timeoutForm(b).className).toBe("mod-work-form");
    expect(timeoutForm(b).getAttribute("novalidate")).toBe("");
    const reason = focusKey(b, "reason") as HTMLInputElement;
    expect(reason.id).toMatch(/^mod-timeout-\d+$/);
    expect(q<HTMLLabelElement>(timeoutForm(b), `label[for="${reason.id}"]`).textContent).toBe(
      t("act.timeoutLabel"),
    );
    const a = amountField(b);
    expect(a.type).toBe("number");
    expect(a.className).toBe("form-input");
    expect(a.getAttribute("min")).toBe("1");
    expect(a.getAttribute("step")).toBe("1");
    expect(a.getAttribute("inputmode")).toBe("numeric");
    expect(a.id).toMatch(/^mod-length-\d+$/);
    expect(a.getAttribute("aria-describedby")).toBe(`${a.id}-hint ${a.id}-error`);
    expect(q<HTMLLabelElement>(timeoutForm(b), `label[for="${a.id}"]`).textContent).toBe(
      t("act.lengthLabel"),
    );
    const hint = q<HTMLElement>(timeoutForm(b), `#${a.id}-hint`);
    expect(hint.textContent).toBe(t("act.timeoutHint"));
    expect(hint.className).toBe("mod-evidence-status");
    const err = timeoutError(b);
    expect(err.id).toBe(`${a.id}-error`);
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toBe("");
    const u = unitField(b);
    expect(u.id).toBe(`${a.id}-unit`);
    expect(u.className).toBe("form-input");
    expect(q<HTMLLabelElement>(timeoutForm(b), `label[for="${u.id}"]`).textContent).toBe(
      t("act.unitLabel"),
    );
    expect([...u.options].map((o) => [o.value, o.textContent])).toEqual([
      ["minutes", t("unit.minutes")],
      ["hours", t("unit.hours")],
      ["days", t("unit.days")],
    ]);
    const submit = focusKey(b, "timeout-submit") as HTMLButtonElement;
    expect(submit.type).toBe("submit");
    expect(submit.textContent).toBe(t("act.timeout"));
  });

  it("restores a kept draft's length and unit", () => {
    const b = build(report(), { draft: { ...emptyActionDraft(), amount: "5", unit: "days" } });
    expect(amountField(b).value).toBe("5");
    expect(unitField(b).value).toBe("days");
  });

  it("refuses a length outside the bounds, says so, and focuses the field", () => {
    const b = build(report());
    type(amountField(b), "0");
    const e = submitEvent(timeoutForm(b));
    expect(e.defaultPrevented).toBe(true);
    expect(timeoutError(b).textContent).toBe(t("act.lengthInvalid"));
    expect(amountField(b).getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(amountField(b));
    expect(b.writes).toEqual([]);
  });

  it("takes the refusal back as soon as the reader edits the number", () => {
    const b = build(report());
    submitEvent(timeoutForm(b));
    expect(amountField(b).getAttribute("aria-invalid")).toBe("true");
    type(amountField(b), "5");
    expect(b.draft.amount).toBe("5");
    expect(timeoutError(b).textContent).toBe("");
    expect(amountField(b).hasAttribute("aria-invalid")).toBe(false);
  });

  it("sends the length in the chosen unit with a clean reason", () => {
    const b = build(report());
    type(focusKey(b, "reason") as HTMLInputElement, "no\tspam ");
    type(amountField(b), "3");
    unitField(b).value = "hours";
    unitField(b).dispatchEvent(new Event("change"));
    expect(b.draft.unit).toBe("hours");
    const e = submitEvent(timeoutForm(b));
    expect(e.defaultPrevented).toBe(true);
    expect(b.writes).toEqual([{ kind: "timeout", reason: "no spam", amount: 3, unit: "hours" }]);
  });

  it("stops keeping input and sending once the view is gone", () => {
    const b = build(report());
    b.abort.abort();
    type(amountField(b), "5");
    unitField(b).value = "days";
    unitField(b).dispatchEvent(new Event("change"));
    expect(b.draft.amount).toBe("");
    expect(b.draft.unit).toBe("minutes");
    submitEvent(timeoutForm(b));
    expect(b.writes).toEqual([]);
    expect(timeoutError(b).textContent).toBe("");
  });
});

describe("lifting a timeout", () => {
  it("names when the timeout ends and lifts it for the reported account", () => {
    const b = withTimeout();
    const lift = focusKey(b, "lift") as HTMLButtonElement;
    expect(lift.type).toBe("button");
    expect(lift.className).toBe("btn-modal-save");
    expect(lift.textContent).toBe(t("act.lift"));
    const wrap = lift.parentElement!;
    expect(wrap.tagName).toBe("DIV");
    expect(wrap.className).toBe("mod-work-form");
    const hint = q<HTMLElement>(wrap, "p");
    expect(hint.id).toMatch(/^mod-lift-\d+$/);
    expect(hint.className).toBe("mod-evidence-status");
    expect(hint.textContent).toBe(t("act.running", { date: dateText(FUTURE) }));
    expect(lift.getAttribute("aria-describedby")).toBe(hint.id);
    lift.click();
    expect(b.writes).toEqual([{ kind: "lift", userId: SUBJECT }]);
    expect(lift.getAttribute("aria-disabled")).toBe("true");
  });

  it("does nothing once the view is gone", () => {
    const b = withTimeout();
    b.abort.abort();
    focusKey(b, "lift").click();
    expect(b.writes).toEqual([]);
  });
});

describe("removal, kick and ban", () => {
  it("offers nothing without the role's bits", () => {
    const b = build(report({ targetType: "message" }));
    expect(enforceWrap(b)).toBeNull();
    expect(labels(b)).toEqual([t("act.warn"), t("act.timeout")]);
  });

  it("offers each action the role holds, removal only on a reported message", () => {
    grant(ALL);
    const onUser = build(report());
    expect(labels(onUser).slice(2)).toEqual([t("enforce.kick"), t("enforce.ban")]);
    const onMessage = build(report({ targetType: "message" }));
    expect(labels(onMessage).slice(2)).toEqual([
      t("enforce.removal"),
      t("enforce.kick"),
      t("enforce.ban"),
    ]);
  });

  it("offers them only to the holder", () => {
    grant(ALL);
    const lifting = build(report({ assigneeId: 99, state: "closed", history: [timeoutEntry()] }));
    expect(labels(lifting)).toEqual([t("act.lift")]);
  });

  it("puts one reason field and the actions in a block of their own", () => {
    grant(ALL);
    const b = build(report());
    const wrap = enforceWrap(b)!;
    expect(wrap.tagName).toBe("DIV");
    expect(wrap.className).toBe("mod-work-form");
    const input = q<HTMLInputElement>(wrap, "input");
    expect(input.dataset["focus"]).toBe("enforce");
    expect(input.id).toMatch(/^mod-enforce-\d+$/);
    expect(q<HTMLLabelElement>(wrap, "label").textContent).toBe(t("enforce.label"));
    expect(q<HTMLElement>(wrap, `#${input.id}-hint`).textContent).toBe(t("enforce.hint"));
    expect(qa(wrap, "button").map((x) => (x as HTMLElement).dataset["focus"])).toEqual([
      "kick",
      "ban",
    ]);
    expect(qa<HTMLButtonElement>(wrap, "button").map((x) => x.type)).toEqual(["button", "button"]);
  });

  it("says a message was already removed, and does not offer to remove it again", () => {
    grant(ALL);
    const b = build(report({ targetType: "message", history: [removalEntry] }));
    const wrap = enforceWrap(b)!;
    expect(q<HTMLElement>(wrap, "p").textContent).toBe(t("enforce.removed"));
    expect(labels(b).slice(2)).toEqual([t("enforce.kick"), t("enforce.ban")]);
  });

  it("does not say it was removed because of other history", () => {
    grant(ALL);
    const event: HistoryEntry = {
      kind: "event",
      action: "removal",
      detail: "",
      actorId: ME,
      at: "2026-09-05 11:00:00",
    };
    const plain = build(report({ targetType: "message" }));
    expect(plain.root.textContent).not.toContain(t("enforce.removed"));
    const withEvent = build(report({ targetType: "message", history: [event] }));
    expect(withEvent.root.textContent).not.toContain(t("enforce.removed"));
    expect(labels(withEvent)).toContain(t("enforce.removal"));
    const withTimeoutHistory = build(report({ targetType: "message", history: [timeoutEntry()] }));
    expect(withTimeoutHistory.root.textContent).not.toContain(t("enforce.removed"));
    expect(labels(withTimeoutHistory)).toContain(t("enforce.removal"));
  });

  it("does not call a message removed when the removal is not the first action on offer", () => {
    grant(Permission.KICK_MEMBERS | Permission.BAN_MEMBERS);
    const onMessage = build(report({ targetType: "message", history: [removalEntry] }));
    expect(onMessage.root.textContent).not.toContain(t("enforce.removed"));
    expect(labels(onMessage).slice(2)).toEqual([t("enforce.kick"), t("enforce.ban")]);
    grant(ALL);
    const onUser = build(report({ history: [removalEntry] }));
    expect(onUser.root.textContent).not.toContain(t("enforce.removed"));
    expect(labels(onUser).slice(2)).toEqual([t("enforce.kick"), t("enforce.ban")]);
  });

  it("with only the removal left, shows the note and no reason field", () => {
    grant(Permission.MANAGE_MESSAGES);
    const b = build(report({ targetType: "message", history: [removalEntry] }));
    const wrap = enforceWrap(b)!;
    expect(wrap).not.toBeNull();
    expect(qa(b.root, "[data-focus=enforce]")).toHaveLength(0);
    expect(qa(wrap, "button")).toHaveLength(0);
    expect(wrap.textContent).toBe(t("enforce.removed"));
  });

  it("opens a numbered confirm dialog and sends the cleaned reason only on confirm", () => {
    grant(ALL);
    const b = build(report());
    type(focusKey(b, "enforce") as HTMLInputElement, "bad\t\tactor");
    focusKey(b, "ban").click();
    const dlg = dialog()!;
    expect(dlg).not.toBeNull();
    const title = q<HTMLElement>(dlg, "[id^=mod-confirm-]");
    expect(title.id).toMatch(/^mod-confirm-\d+$/);
    expect(title.textContent).toBe(t("confirm.ban.title"));
    expect(Number(title.id.split("-").pop())).toBeGreaterThan(0);
    expect(b.writes).toEqual([]);
    q<HTMLButtonElement>(dlg, "[data-testid=mod-confirm]").click();
    expect(b.writes).toEqual([{ kind: "ban", reason: "bad actor" }]);
  });

  it("does not send when the role lost the bit before confirming", () => {
    grant(ALL);
    const b = build(report());
    focusKey(b, "kick").click();
    grant(Permission.BAN_MEMBERS);
    q<HTMLButtonElement>(dialog()!, "[data-testid=mod-confirm]").click();
    expect(b.writes).toEqual([]);
  });

  it("ignores a press on an action while a write is in flight", () => {
    grant(ALL);
    const b = build(report());
    focusKey(b, "ban").click();
    q<HTMLButtonElement>(dialog()!, "[data-testid=mod-confirm]").click();
    expect(focusKey(b, "kick").getAttribute("aria-disabled")).toBe("true");
    focusKey(b, "kick").click();
    expect(dialog()).toBeNull();
  });

  it("opens nothing once the view is gone", () => {
    grant(ALL);
    const b = build(report());
    b.abort.abort();
    focusKey(b, "ban").click();
    expect(dialog()).toBeNull();
  });
});
