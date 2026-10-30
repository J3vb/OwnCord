// B9-10: the local report form — validation, the exact request, pending,
// refusal, cancellation and teardown, against a stubbed fileReport.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@lib/ui/toast", () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

import { ApiClientError, type FileReportRequest } from "@lib/api";
import type { ModalInstance } from "@lib/ui/modalFactory";
import { openMessageReport, openUserReport } from "./openers";
import { checkReportDetail, reportFailureText } from "./reportDialog";

interface Deferred {
  resolve: (v: { id: string }) => void;
  reject: (e: unknown) => void;
}

let calls: { body: FileReportRequest; signal: AbortSignal | undefined }[];
let pending: Deferred[];
const api = {
  fileReport: (body: FileReportRequest, signal?: AbortSignal) => {
    calls.push({ body, signal });
    return new Promise<{ id: string }>((resolve, reject) => pending.push({ resolve, reject }));
  },
};

let owner: AbortController;
let opener: HTMLButtonElement;
let modal: ModalInstance | null;

beforeEach(() => {
  calls = [];
  pending = [];
  showToast.mockClear();
  owner = new AbortController();
  opener = document.createElement("button");
  opener.textContent = "Report message";
  document.body.appendChild(opener);
  opener.focus();
  modal = null;
});

afterEach(() => {
  modal?.close();
  owner.abort();
  document.body.replaceChildren();
});

const dialog = () => document.querySelector<HTMLElement>(".report-dialog");
const radio = (label: string) =>
  [...document.querySelectorAll<HTMLLabelElement>(".report-option")]
    .find((l) => l.textContent === label)
    ?.querySelector("input") as HTMLInputElement;
const submitBtn = () => document.querySelector<HTMLButtonElement>(".report-form [type=submit]")!;
const submit = () =>
  document
    .querySelector<HTMLFormElement>(".report-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A focusable member row, as MemberList renders it. */
function row(id: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "member-item";
  el.tabIndex = 0;
  el.dataset["testid"] = `member-${id}`;
  return el;
}

function openMessage(attachments: { id: string; filename: string }[] = []) {
  modal = openMessageReport({
    api,
    signal: owner.signal,
    msg: {
      id: 42,
      attachments: attachments.map((a) => ({ ...a, size: 1, mime: "image/png", url: "/x" })),
    },
  });
}

describe("report dialog", () => {
  it("is a named modal dialog that says where the report goes", () => {
    openMessage();
    const d = dialog()!;
    expect(d.getAttribute("role")).toBe("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(d.getAttribute("aria-labelledby")!);
    expect(title?.textContent).toBe("Report message");
    expect(d.textContent).toContain("goes only to this server's moderators");
    // Every B5 reason code, as English, and no target choice for a bare message.
    const labels = [...d.querySelectorAll(".report-option")].map((l) => l.textContent);
    expect(labels).toEqual([
      "Spam",
      "Harassment",
      "Adult content that isn't marked as age-restricted",
      "Illegal content",
      "Something else",
    ]);
    expect(d.querySelector("fieldset legend")?.textContent).toBe("Reason");
  });

  it("refuses to send without a reason and says so on the field", async () => {
    openMessage();
    submit();
    await flush();
    expect(calls).toHaveLength(0);
    const spam = radio("Spam");
    const error = document.getElementById(spam.getAttribute("aria-describedby")!)!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Choose a reason.");
    expect(spam.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(spam);
  });

  it("sends the actual message id, reason and detail, then closes and returns focus", async () => {
    openMessage();
    radio("Harassment").checked = true;
    document.querySelector<HTMLTextAreaElement>(".report-detail")!.value = "line one\nline two ";
    submit();
    expect(calls.map((c) => c.body)).toEqual([
      {
        target_type: "message",
        target_id: "42",
        reason: "harassment",
        detail: "line one line two",
      },
    ]);
    // Pending: busy but still focusable, and announced politely.
    expect(submitBtn().getAttribute("aria-busy")).toBe("true");
    expect(submitBtn().getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector(".report-form [role=status]")?.textContent).toBe(
      "Sending report…",
    );
    submit(); // a second submit while pending sends nothing
    expect(calls).toHaveLength(1);
    pending[0]!.resolve({ id: "abc" });
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(showToast).toHaveBeenCalledWith(
      "Report sent. You can follow it in Settings, Safety.",
      "success",
    );
  });

  it("reports an attachment by its upload id when the user picks it", async () => {
    openMessage([{ id: "up-7", filename: "cat.png" }]);
    expect(radio("This message").checked).toBe(true);
    radio("The attachment cat.png").checked = true;
    radio("Spam").checked = true;
    submit();
    expect(calls[0]?.body).toMatchObject({ target_type: "attachment", target_id: "up-7" });
  });

  it("reports a user by id", () => {
    modal = openUserReport({
      api,
      signal: owner.signal,
      userId: 9,
      name: "bob",
      list: document.body,
    });
    expect(document.getElementById(dialog()!.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Report bob",
    );
    radio("Spam").checked = true;
    submit();
    expect(calls[0]?.body).toMatchObject({ target_type: "user", target_id: "9" });
  });

  it("returns focus to the user's rebuilt row, else the list's first row", () => {
    const list = document.createElement("div");
    const first = row(3);
    const bob = row(9);
    list.append(first, bob);
    document.body.appendChild(list);
    bob.focus();
    modal = openUserReport({ api, signal: owner.signal, userId: 9, name: "bob", list });
    // The list rebuilds while the form is open: the opener is gone.
    const rebuilt = row(9);
    bob.replaceWith(rebuilt);
    document.querySelector<HTMLButtonElement>(".btn-modal-cancel")!.click();
    expect(document.activeElement).toBe(rebuilt);

    rebuilt.focus();
    modal = openUserReport({ api, signal: owner.signal, userId: 9, name: "bob", list });
    rebuilt.remove();
    document.querySelector<HTMLButtonElement>(".btn-modal-cancel")!.click();
    expect(document.activeElement).toBe(first);
  });

  it.each([
    ["DUPLICATE_REPORT", 409, "You already have an open report about this."],
    ["RATE_LIMITED", 429, "You've sent too many reports."],
    ["NOT_FOUND", 404, "it was deleted, or you can no longer see it."],
    ["INVALID_INPUT", 400, "The server refused this report."],
  ])("keeps the form open and explains a %s refusal", async (code, status, text) => {
    openMessage();
    radio("Spam").checked = true;
    submitBtn().focus();
    submit();
    pending[0]!.reject(new ApiClientError(status, code, "server wording, never shown"));
    await flush();
    const alerts = [...document.querySelectorAll(".report-form [role=alert]")];
    const shown = alerts.map((a) => a.textContent).join("|");
    expect(shown).toContain(text);
    expect(shown).not.toContain("server wording");
    expect(submitBtn().hasAttribute("aria-busy")).toBe(false);
    expect(document.activeElement).toBe(submitBtn());
    expect(showToast).not.toHaveBeenCalled();
  });

  it("cancel sends nothing and returns focus", () => {
    openMessage();
    radio("Spam").checked = true;
    document.querySelector<HTMLButtonElement>(".btn-modal-cancel")!.click();
    expect(dialog()).toBeNull();
    expect(calls).toHaveLength(0);
    expect(document.activeElement).toBe(opener);
  });

  it("Escape during a send aborts it and drops the late result", async () => {
    openMessage();
    radio("Spam").checked = true;
    submit();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog()).toBeNull();
    expect(calls[0]?.signal?.aborted).toBe(true);
    pending[0]!.resolve({ id: "late" });
    await flush();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("closes with its owner (channel switch, sign-out)", () => {
    openMessage();
    radio("Spam").checked = true;
    submit();
    owner.abort();
    expect(dialog()).toBeNull();
    expect(calls[0]?.signal?.aborted).toBe(true);
  });
});

describe("checkReportDetail", () => {
  it("turns line breaks and tabs into spaces and trims", () => {
    expect(checkReportDetail("  a\r\n\tb  ")).toEqual({ ok: true, value: "a b" });
  });
  it("refuses other control characters, as the server does", () => {
    expect(checkReportDetail("a\u0007b")).toEqual({ ok: false, error: "error.detailControl" });
  });
  it("counts code points, not UTF-16 units, against the 2,000 bound", () => {
    expect(checkReportDetail("😀".repeat(2000)).ok).toBe(true);
    expect(checkReportDetail("x".repeat(2001))).toEqual({
      ok: false,
      error: "error.detailTooLong",
    });
  });
});

describe("reportFailureText", () => {
  it("falls back to a connection message for anything unrecognised", () => {
    expect(reportFailureText(new TypeError("offline"))).toBe(
      "Couldn't send the report. Check your connection and try again.",
    );
    expect(reportFailureText(new ApiClientError(500, "INTERNAL_ERROR", "x"))).toContain(
      "Couldn't send the report",
    );
  });
});

const attrsOf = (el: Element): Record<string, string> =>
  Object.fromEntries(el.getAttributeNames().map((n) => [n, el.getAttribute(n) ?? ""]));
const q = <T extends Element = HTMLElement>(sel: string): T => dialog()!.querySelector<T>(sel)!;
const detailField = () => q<HTMLTextAreaElement>(".report-detail");
const failureBox = () => q(".report-form .modal-body > .form-error");

describe("report dialog markup", () => {
  it("names its parts with ids from one per-dialog prefix, counting up per dialog", () => {
    openMessage([{ id: "up-7", filename: "cat.png" }]);
    const d = dialog()!;
    const prefix = /^(report-\d+)-title$/.exec(q("h3").id)?.[1];
    expect(prefix).toBeDefined();
    expect(q("h3").textContent).toBe("Report message");
    expect(attrsOf(q(".modal-header"))).toEqual({ class: "modal-header" });
    expect(attrsOf(q(".modal-close"))).toEqual({
      type: "button",
      class: "modal-close",
      "aria-label": "Close",
    });
    expect(attrsOf(q(".modal-body"))).toEqual({ class: "modal-body" });
    expect(attrsOf(q(".modal-body > p"))).toEqual({ class: "report-note" });

    const sets = [...d.querySelectorAll("fieldset")];
    expect(sets.map((s) => attrsOf(s))).toEqual([
      { class: "report-choice" },
      { class: "report-choice" },
    ]);
    const legends = [...d.querySelectorAll("legend")];
    expect(legends.map((l) => attrsOf(l))).toEqual([
      { class: "form-label" },
      { class: "form-label" },
    ]);
    expect(legends.map((l) => l.textContent)).toEqual(["What are you reporting?", "Reason"]);

    const targets = [...sets[0]!.querySelectorAll("input")];
    expect(targets.map((i) => i.name)).toEqual([`${prefix}-target`, `${prefix}-target`]);
    expect(targets.map((i) => i.value)).toEqual(["0", "1"]);
    // The first target starts chosen; the attachment only when picked.
    expect(targets.map((i) => i.checked)).toEqual([true, false]);

    const reasons = [...sets[1]!.querySelectorAll("input")];
    expect(reasons.map((i) => i.name)).toEqual(reasons.map(() => `${prefix}-reason`));
    expect(reasons.every((i) => !i.checked)).toBe(true);
    const reasonError = sets[1]!.querySelector(".form-error")!;
    expect(attrsOf(reasonError)).toEqual({
      class: "form-error",
      id: `${prefix}-reason-error`,
      role: "alert",
    });
    expect(reasons.every((i) => i.getAttribute("aria-describedby") === reasonError.id)).toBe(true);

    expect(attrsOf(q(".form-group"))).toEqual({ class: "form-group" });
    expect(attrsOf(q(".form-group label"))).toEqual({
      class: "form-label",
      for: `${prefix}-detail`,
    });
    expect(q(".form-group label").textContent).toBe("Details (optional)");
    expect(attrsOf(detailField())).toEqual({
      class: "form-input report-detail",
      id: `${prefix}-detail`,
      rows: "3",
      "aria-describedby": `${prefix}-detail-hint ${prefix}-detail-error`,
    });
    const hint = q(`#${prefix}-detail-hint`);
    expect(attrsOf(hint)).toEqual({ class: "report-note", id: `${prefix}-detail-hint` });
    expect(hint.textContent).toBe("Up to 2,000 characters.");
    expect(attrsOf(q(`#${prefix}-detail-error`))).toEqual({
      class: "form-error",
      id: `${prefix}-detail-error`,
      role: "alert",
    });

    expect(attrsOf(q(".modal-body > .form-status"))).toEqual({
      class: "form-status",
      role: "status",
    });
    expect(attrsOf(failureBox())).toEqual({ class: "form-error", role: "alert" });
    expect(attrsOf(q(".modal-footer"))).toEqual({ class: "modal-footer" });
    expect(attrsOf(q(".btn-modal-cancel"))).toEqual({
      type: "button",
      class: "btn-modal-cancel",
    });
    expect(attrsOf(submitBtn())).toEqual({ type: "submit", class: "btn-modal-save" });
    expect(attrsOf(q("form"))).toEqual({ class: "report-form", novalidate: "" });

    const firstSeq = Number(/\d+/.exec(prefix!)![0]);
    modal!.close();
    modal = null;
    openMessage();
    expect(q("h3").id).toBe(`report-${firstSeq + 1}-title`);
  });

  it("preselects only the first target", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!;
    const sets: Array<[string, boolean]> = [];
    vi.spyOn(HTMLInputElement.prototype, "checked", "set").mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      if (this.name.endsWith("-target")) sets.push([this.value, value]);
      original.set!.call(this, value);
    });
    try {
      openMessage([{ id: "up-7", filename: "cat.png" }]);
      expect(sets).toEqual([
        ["0", true],
        ["1", false],
      ]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("starts on the first target, or on the first reason when there is no choice", () => {
    openMessage([{ id: "up-7", filename: "cat.png" }]);
    expect(document.activeElement).toBe(radio("This message"));
    modal!.close();
    modal = null;
    openMessage();
    expect(document.activeElement).toBe(radio("Spam"));
  });

  it("closes from its X button", () => {
    openMessage();
    q<HTMLButtonElement>(".modal-close").click();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("report dialog feedback", () => {
  it("marks and clears invalid fields as the answers change", async () => {
    openMessage();
    const detail = detailField();
    detail.value = "a\u0007b";
    const submitted = new Event("submit", { cancelable: true });
    q("form").dispatchEvent(submitted);
    // The browser's own submit is always cancelled.
    expect(submitted.defaultPrevented).toBe(true);
    const reasons = [...document.querySelectorAll<HTMLInputElement>(".report-option input")];
    const reasonError = () =>
      document.getElementById(reasons[0]!.getAttribute("aria-describedby")!)!;
    const detailError = () => document.getElementById(`${detail.id}-error`)!;
    expect(reasons.every((r) => r.getAttribute("aria-invalid") === "true")).toBe(true);
    expect(detail.getAttribute("aria-invalid")).toBe("true");
    expect(reasonError().textContent).toBe("Choose a reason.");
    expect(detailError().textContent).toContain("characters that can't be sent");
    expect(calls).toHaveLength(0);

    // A reason alone: the detail is still refused and takes focus.
    radio("Spam").checked = true;
    submit();
    expect(reasons.some((r) => r.hasAttribute("aria-invalid"))).toBe(false);
    expect(reasonError().textContent).toBe("");
    expect(detail.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(detail);
    expect(calls).toHaveLength(0);

    detail.value = "x".repeat(2001);
    submit();
    expect(detailError().textContent).toBe("Details can be at most 2,000 characters.");
    expect(calls).toHaveLength(0);

    detail.value = "fine";
    submit();
    expect(detail.hasAttribute("aria-invalid")).toBe(false);
    expect(detailError().textContent).toBe("");
    expect(calls).toHaveLength(1);
  });

  it("clears the last failure when sending again and unlocks the button after one", async () => {
    openMessage();
    radio("Spam").checked = true;
    submit();
    pending[0]!.reject(new TypeError("offline"));
    await flush();
    expect(failureBox().textContent).toContain("Couldn't send the report");
    expect(submitBtn().hasAttribute("aria-disabled")).toBe(false);
    expect(document.querySelector(".report-form [role=status]")?.textContent).toBe("");

    submit();
    expect(failureBox().textContent).toBe("");
    expect(submitBtn().getAttribute("aria-disabled")).toBe("true");
  });

  it("ignores a failure that lands after the dialog closed", async () => {
    openMessage();
    radio("Spam").checked = true;
    submit();
    const failure = failureBox();
    const button = submitBtn();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    pending[0]!.reject(new TypeError("offline"));
    await flush();
    expect(failure.textContent).toBe("");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("stops listening once closed: a late submit sends nothing", () => {
    openMessage();
    radio("Spam").checked = true;
    const form = q("form");
    modal!.close();
    modal = null;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(calls).toHaveLength(0);
  });
});
