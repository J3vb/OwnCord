/**
 * The Ban dialog (WP 3C-5c, P16): names the user, sends the reason, length and
 * message-history choice, and reads the purge answer as the plan says: a
 * response without `purge` is "not supported", an incomplete purge offers Retry
 * with the identical request, and a rejection keeps the dialog open.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  openBanDialog,
  BAN_DELETE_OPTIONS,
  BAN_DURATIONS,
  type BanRequest,
  readBanPurge,
} from "../../src/features/moderation/BanDialog";
import type { ModalInstance } from "@lib/ui/modalFactory";
import { ApiClientError, TransportError, errorText, type BanMemberResponse } from "@lib/api";

const q = <T extends Element = HTMLElement>(testId: string): T =>
  document.querySelector<T>(`[data-testid="${testId}"]`) as T;
const dialog = (): HTMLElement | null => document.querySelector('[data-testid="ban-dialog"]');
const status = (): string => q("ban-status").textContent ?? "";
const confirm = (): HTMLButtonElement => q<HTMLButtonElement>("ban-confirm");

let modal: ModalInstance | null = null;

function setup(submit: (req: BanRequest) => Promise<BanMemberResponse>, canDeleteMessages = true) {
  const notify = vi.fn();
  const onBanned = vi.fn();
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  modal = openBanDialog({
    name: "Alice A.",
    username: "alice",
    canDeleteMessages,
    submit,
    notify,
    onBanned,
  });
  return { notify, onBanned, opener };
}

describe("ban dialog", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    modal?.close();
    modal = null;
  });

  it("is a labelled dialog that names the user, with a red Ban and a Cancel", () => {
    setup(vi.fn());
    const modal = dialog()!.querySelector(".modal")!;
    expect(modal.getAttribute("role")).toBe("dialog");
    expect(modal.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(modal.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("Ban Alice A.?");
    expect(confirm().textContent).toBe("Ban");
    expect(confirm().classList.contains("btn-danger")).toBe(true);
    expect(q("ban-cancel").textContent).toBe("Cancel");
    expect(q<HTMLInputElement>("ban-reason-input").maxLength).toBe(200);
  });

  it("offers today's lengths and the seven history choices", () => {
    setup(vi.fn());
    const labels = (id: string): string[] =>
      Array.from(q<HTMLSelectElement>(id).options).map((o) => o.textContent ?? "");
    expect(labels("ban-duration-select")).toEqual([
      "Forever",
      "1 hour",
      "1 day",
      "7 days",
      "30 days",
    ]);
    expect(labels("ban-delete-select")).toEqual([
      "Don't delete any",
      "Previous hour",
      "Previous 6 hours",
      "Previous 12 hours",
      "Previous 24 hours",
      "Previous 3 days",
      "Previous 7 days",
    ]);
    expect(BAN_DURATIONS.map((d) => d.hours)).toEqual([0, 1, 24, 168, 720]);
    expect(BAN_DELETE_OPTIONS.map((d) => d.seconds)).toEqual([
      0, 3600, 21600, 43200, 86400, 259200, 604800,
    ]);
  });

  it("Cancel sends nothing and closes, returning focus to the opener", () => {
    const submit = vi.fn();
    const { opener } = setup(submit);
    q("ban-cancel").click();
    expect(dialog()).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("Escape sends nothing and closes", () => {
    const submit = vi.fn();
    setup(submit);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog()).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("sends the trimmed reason and chosen length, deleting nothing by default", async () => {
    const submit = vi.fn(async () => ({}));
    const { notify, onBanned } = setup(submit);
    q<HTMLInputElement>("ban-reason-input").value = "  spamming  ";
    q<HTMLSelectElement>("ban-duration-select").value = "24";
    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      reason: "spamming",
      durationHours: 24,
      deleteMessageSeconds: 0,
    });
    expect(onBanned).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledExactlyOnceWith("Banned alice for 24h", "success");
  });

  it("Enter that commits an IME candidate does not submit a half-typed reason", async () => {
    const submit = vi.fn(async () => ({}));
    setup(submit);
    q("ban-reason-input").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    pressEnterInReason();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledOnce();
  });

  it("Enter in the reason field submits once", async () => {
    const submit = vi.fn(async () => ({}));
    setup(submit);
    pressEnterInReason();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each(BAN_DELETE_OPTIONS.filter((o) => o.seconds > 0))(
    "history choice %# maps to deleteMessageSeconds",
    async (choice) => {
      const submit = vi.fn(async () => ({ purge: { deleted: 2, complete: true } }));
      const { notify } = setup(submit);
      q<HTMLSelectElement>("ban-delete-select").value = String(choice.seconds);
      confirm().click();
      await vi.waitFor(() => expect(dialog()).toBeNull());
      expect(submit).toHaveBeenCalledExactlyOnceWith({
        reason: "",
        durationHours: 0,
        deleteMessageSeconds: choice.seconds,
      });
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "Banned alice and deleted 2 messages",
        "success",
      );
    },
  );

  it("treats a response without purge as not supported: ban stands, says so, closes", async () => {
    const submit = vi.fn(async () => ({}));
    const { notify, onBanned } = setup(submit);
    q<HTMLSelectElement>("ban-delete-select").value = "3600";
    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(onBanned).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Banned alice. This server cannot delete message history, so their messages were kept.",
      "warning",
    );
    // Nothing to retry: the request is not repeated.
    expect(submit).toHaveBeenCalledOnce();
  });

  it("reads purge strictly: a malformed one is not supported either", async () => {
    expect(readBanPurge({ purge: { deleted: 3, complete: true } })).toEqual({
      deleted: 3,
      complete: true,
    });
    for (const bad of [undefined, null, {}, { purge: null }, { purge: { deleted: "3" } }]) {
      expect(readBanPurge(bad as BanMemberResponse | null | undefined)).toBeNull();
    }
    const { notify } = setup(vi.fn(async () => ({ purge: { deleted: "3", complete: true } })));
    q<HTMLSelectElement>("ban-delete-select").value = "3600";
    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(notify.mock.calls[0]![1]).toBe("warning");
  });

  it("does not call a missing purge unsupported when no history was asked for", async () => {
    const { notify } = setup(vi.fn(async () => ({})));
    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(notify).toHaveBeenCalledExactlyOnceWith("Banned alice", "success");
  });

  it("shows an incomplete purge and Retry resends the identical request", async () => {
    const submit = vi
      .fn<(r: BanRequest) => Promise<BanMemberResponse>>()
      .mockResolvedValueOnce({ purge: { deleted: 40, complete: false } })
      .mockResolvedValueOnce({ purge: { deleted: 5, complete: true } });
    const { notify, onBanned } = setup(submit);
    q<HTMLInputElement>("ban-reason-input").value = "raid";
    q<HTMLSelectElement>("ban-duration-select").value = "168";
    q<HTMLSelectElement>("ban-delete-select").value = "86400";
    confirm().click();

    await vi.waitFor(() => expect(status()).toContain("only 40 messages"));
    expect(dialog()).not.toBeNull();
    expect(confirm().textContent).toBe("Retry");
    expect(confirm().disabled).toBe(false);
    // The form is locked so a retry cannot differ from the first request.
    expect(q<HTMLInputElement>("ban-reason-input").disabled).toBe(true);
    expect(q<HTMLSelectElement>("ban-duration-select").disabled).toBe(true);
    expect(q<HTMLSelectElement>("ban-delete-select").disabled).toBe(true);
    expect(notify).not.toHaveBeenCalled();

    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledTimes(2);
    const first = submit.mock.calls[0]![0];
    const second = submit.mock.calls[1]![0];
    expect(second).toEqual(first);
    expect(second).toEqual({ reason: "raid", durationHours: 168, deleteMessageSeconds: 86400 });
    expect(onBanned).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Banned alice and deleted 45 messages",
      "success",
    );
  });

  it("says 'message' for exactly one deleted so far", async () => {
    setup(vi.fn(async () => ({ purge: { deleted: 1, complete: false } })));
    q<HTMLSelectElement>("ban-delete-select").value = "3600";
    confirm().click();
    await vi.waitFor(() => expect(status()).toContain("only 1 message has been"));
  });

  it("blocks a second submit while the request is in flight", async () => {
    let release: (v: BanMemberResponse) => void = () => {};
    const submit = vi.fn(() => new Promise<BanMemberResponse>((resolve) => (release = resolve)));
    setup(submit);
    confirm().click();
    expect(confirm().disabled).toBe(true);
    expect(confirm().textContent).toBe("Banning...");
    confirm().click();
    pressEnterInReason();
    expect(submit).toHaveBeenCalledOnce();
    release({});
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledOnce();
  });

  // Edge case (b): the network drops mid-ban.
  it("keeps the dialog open with the error after a dropped request, and retries once", async () => {
    const submit = vi
      .fn<(r: BanRequest) => Promise<BanMemberResponse>>()
      .mockRejectedValueOnce(new TransportError("socket closed"))
      .mockResolvedValueOnce({});
    const { notify, onBanned } = setup(submit);
    q<HTMLInputElement>("ban-reason-input").value = "spam";
    q<HTMLSelectElement>("ban-duration-select").value = "1";
    confirm().click();

    await vi.waitFor(() => expect(status()).not.toBe(""));
    expect(status()).toBe(errorText(new TransportError("socket closed"), "Failed to ban member"));
    expect(dialog()).not.toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(onBanned).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    // Re-enabled, still the same Ban button, and the form is not locked.
    expect(confirm().disabled).toBe(false);
    expect(confirm().textContent).toBe("Ban");
    expect(q<HTMLInputElement>("ban-reason-input").disabled).toBe(false);

    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]![0]).toEqual({
      reason: "spam",
      durationHours: 1,
      deleteMessageSeconds: 0,
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith("Banned alice for 1h", "success");
  });

  // Edge case (a): a role changed while the dialog was open.
  it("shows the server's refusal cleanly, and a later submit still works", async () => {
    const refusal = new ApiClientError(403, "FORBIDDEN", "you do not outrank this member");
    const submit = vi
      .fn<(r: BanRequest) => Promise<BanMemberResponse>>()
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce({});
    const { notify } = setup(submit);
    confirm().click();

    await vi.waitFor(() => expect(status()).toBe(errorText(refusal, "Failed to ban member")));
    expect(status()).not.toBe("");
    expect(dialog()).not.toBeNull();
    expect(confirm().disabled).toBe(false);
    expect(notify).not.toHaveBeenCalled();

    // The next press clears the message and sends again (the rank changed back).
    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledExactlyOnceWith("Banned alice", "success");
  });

  it("still reports the outcome when the dialog was closed while the request ran", async () => {
    let release: (v: BanMemberResponse) => void = () => {};
    const submit = vi.fn(() => new Promise<BanMemberResponse>((resolve) => (release = resolve)));
    const { notify, onBanned } = setup(submit);
    confirm().click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog()).toBeNull();
    release({});
    await vi.waitFor(() => expect(onBanned).toHaveBeenCalledOnce());
    // The ban still happened: the toast is how the moderator learns of it.
    expect(notify).toHaveBeenCalledExactlyOnceWith("Banned alice", "success");
  });

  it("labels the reason, length and history controls", () => {
    setup(vi.fn());
    for (const id of ["ban-reason-input", "ban-duration-select", "ban-delete-select"]) {
      const control = q(id);
      const label = document.querySelector(`label[for="${control.id}"]`);
      expect(control.id).not.toBe("");
      expect(label?.textContent ?? "").not.toBe("");
    }
  });

  it("without MANAGE_MESSAGES the history choice is absent and 0 is sent", async () => {
    const submit = vi.fn(async () => ({}));
    const { notify } = setup(submit, false);
    expect(document.querySelector('[data-testid="ban-delete-select"]')).toBeNull();
    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      reason: "",
      durationHours: 0,
      deleteMessageSeconds: 0,
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith("Banned alice", "success");
  });

  it("does not close on a backdrop click", () => {
    setup(vi.fn());
    dialog()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog()).not.toBeNull();
  });

  it("puts focus back on the button after a failed request", async () => {
    setup(vi.fn().mockRejectedValue(new ApiClientError(403, "FORBIDDEN", "no")));
    confirm().click();
    await vi.waitFor(() => expect(status()).not.toBe(""));
    expect(document.activeElement).toBe(confirm());
  });

  it("a dropped connection on a purge request keeps it for an identical Retry", async () => {
    const submit = vi
      .fn<(r: BanRequest) => Promise<BanMemberResponse>>()
      .mockRejectedValueOnce(new TransportError("socket closed"))
      .mockResolvedValueOnce({ purge: { deleted: 4, complete: true } });
    const { notify } = setup(submit);
    q<HTMLInputElement>("ban-reason-input").value = "raid";
    q<HTMLSelectElement>("ban-duration-select").value = "24";
    q<HTMLSelectElement>("ban-delete-select").value = "3600";
    confirm().click();
    await vi.waitFor(() => expect(status()).not.toBe(""));
    expect(confirm().textContent).toBe("Retry");
    expect(q<HTMLInputElement>("ban-reason-input").disabled).toBe(true);
    expect(q<HTMLSelectElement>("ban-delete-select").disabled).toBe(true);

    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit.mock.calls[1]![0]).toEqual(submit.mock.calls[0]![0]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Banned alice and deleted 4 messages",
      "success",
    );
  });

  it("a dropped connection without history leaves the form open and editable", async () => {
    setup(vi.fn().mockRejectedValue(new TransportError("socket closed")));
    confirm().click();
    await vi.waitFor(() => expect(status()).not.toBe(""));
    expect(confirm().textContent).toBe("Ban");
    expect(q<HTMLInputElement>("ban-reason-input").disabled).toBe(false);
  });

  it("closing with Escape after an incomplete purge reports the count, without Retry wording", async () => {
    const { notify } = setup(vi.fn(async () => ({ purge: { deleted: 7, complete: false } })));
    q<HTMLSelectElement>("ban-delete-select").value = "3600";
    confirm().click();
    await vi.waitFor(() => expect(confirm().textContent).toBe("Retry"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialog()).toBeNull();
    expect(notify).toHaveBeenCalledOnce();
    const [text, type] = notify.mock.calls[0]!;
    expect(type).toBe("warning");
    expect(text).toContain("7 messages");
    expect(text).not.toMatch(/retry/i);
  });

  describe("retry window", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("drops the pending retry after an hour and unlocks the form", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const submit = vi.fn(async () => ({ purge: { deleted: 1, complete: false } }));
      setup(submit);
      q<HTMLSelectElement>("ban-delete-select").value = "3600";
      confirm().click();
      await vi.waitFor(() => expect(confirm().textContent).toBe("Retry"));
      expect(q<HTMLInputElement>("ban-reason-input").disabled).toBe(true);

      vi.advanceTimersByTime(60 * 60 * 1000 + 1);
      expect(confirm().textContent).toBe("Ban");
      expect(q<HTMLInputElement>("ban-reason-input").disabled).toBe(false);
      expect(q<HTMLSelectElement>("ban-delete-select").disabled).toBe(false);
      expect(status()).toContain("ban again");
    });
  });
});

const incomplete = (): Promise<BanMemberResponse> =>
  Promise.resolve({ purge: { deleted: 3, complete: false } });
const escape = (): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
};
const choose = (seconds: string): void => {
  q<HTMLSelectElement>("ban-delete-select").value = seconds;
};
const pressEnterInReason = (): void => {
  q("ban-reason-input").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
};
/** First request comes back with an incomplete purge; the retry never settles. */
const incompleteThenHang = () =>
  vi
    .fn<(r: BanRequest) => Promise<BanMemberResponse>>()
    .mockImplementationOnce(incomplete)
    .mockImplementationOnce(() => new Promise(() => {}));
/** Fake timers on, a 1 h purge ban submitted, and the button showing Retry. */
async function reachRetryWithTimers(
  submit: (req: BanRequest) => Promise<BanMemberResponse>,
): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  setup(submit);
  choose("3600");
  confirm().click();
  await vi.advanceTimersByTimeAsync(0);
  expect(confirm().textContent).toBe("Retry");
}

const press = (key: string): KeyboardEvent => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  q("ban-reason-input").dispatchEvent(e);
  return e;
};
describe("ban dialog layout and lifetime", () => {
  const HOUR = 60 * 60 * 1000;
  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    modal?.close();
    modal = null;
    vi.useRealTimers();
  });

  it("lays the fields out as labelled groups between a header, body and footer", () => {
    setup(vi.fn());
    const root = dialog()!;
    expect(root.querySelector(".modal-header > h3")?.id).toBe("ban-dialog-title");
    const body = root.querySelector(".modal-body")!;
    const groups = Array.from(body.querySelectorAll(":scope > .form-group"));
    // Reason, length, history, then the status line.
    expect(groups).toHaveLength(4);
    for (const group of groups.slice(0, 3)) {
      const label = group.querySelector("label.form-label")!;
      const control = group.querySelector("input, select")!;
      expect(label.getAttribute("for")).toBe(control.id);
      expect(control.className).toBe("form-input");
    }
    const footer = root.querySelector(".modal-footer")!;
    expect(footer.contains(q("ban-cancel"))).toBe(true);
    expect(footer.contains(confirm())).toBe(true);
    expect(q("ban-cancel").className).toBe("btn-modal-cancel");
    expect(q<HTMLButtonElement>("ban-cancel").type).toBe("button");
    expect(confirm().type).toBe("button");
    const reason = q<HTMLInputElement>("ban-reason-input");
    expect(reason.type).toBe("text");
    expect(reason.getAttribute("autocomplete")).toBe("off");
  });

  it("starts with the reason field focused and an announced, hidden status line", () => {
    setup(vi.fn());
    expect(document.activeElement).toBe(q("ban-reason-input"));
    const line = q("ban-status");
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.className).toBe("form-group");
    expect(line.style.display).toBe("none");
    expect(line.style.color).not.toBe("");
  });

  it("shows the error line on a failure and hides it again on the next attempt", async () => {
    let release: (v: BanMemberResponse) => void = () => {};
    const submit = vi
      .fn<(r: BanRequest) => Promise<BanMemberResponse>>()
      .mockRejectedValueOnce(new ApiClientError(403, "FORBIDDEN", "no"))
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    setup(submit);
    confirm().click();
    await vi.waitFor(() => expect(q("ban-status").style.display).toBe("block"));
    confirm().click();
    expect(q("ban-status").style.display).toBe("none");
    release({});
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it("sends at most 200 characters of the reason", async () => {
    const submit = vi.fn(async () => ({}));
    setup(submit);
    q<HTMLInputElement>("ban-reason-input").value = ` ${"x".repeat(250)} `;
    confirm().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      reason: "x".repeat(200),
      durationHours: 0,
      deleteMessageSeconds: 0,
    });
  });

  it("only submits on Enter, and keeps the key from reaching the page", () => {
    const submit = vi.fn(() => new Promise<BanMemberResponse>(() => {}));
    setup(submit);
    expect(press("a").defaultPrevented).toBe(false);
    expect(press("Tab").defaultPrevented).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("puts focus on Retry after an incomplete purge", async () => {
    setup(vi.fn(incomplete));
    choose("3600");
    confirm().click();
    await vi.waitFor(() => expect(confirm().textContent).toBe("Retry"));
    expect(document.activeElement).toBe(confirm());
  });

  it("labels the button 'Retrying...' while a retry runs", async () => {
    setup(incompleteThenHang());
    choose("3600");
    confirm().click();
    await vi.waitFor(() => expect(confirm().textContent).toBe("Retry"));
    confirm().click();
    expect(confirm().textContent).toBe("Retrying...");
    expect(confirm().disabled).toBe(true);
  });

  it("closes with its owner's signal, sending nothing", () => {
    const owner = new AbortController();
    const submit = vi.fn();
    const notify = vi.fn();
    modal = openBanDialog({
      name: "Alice A.",
      username: "alice",
      canDeleteMessages: true,
      submit,
      notify,
      signal: owner.signal,
    });
    expect(dialog()).not.toBeNull();
    owner.abort();
    expect(dialog()).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("hands focus to the fallback when the opener has left the page", () => {
    const opener = document.createElement("button");
    const fallback = document.createElement("button");
    document.body.append(opener, fallback);
    opener.focus();
    modal = openBanDialog({
      name: "Alice A.",
      username: "alice",
      canDeleteMessages: true,
      submit: vi.fn(),
      notify: vi.fn(),
      fallbackFocus: () => fallback,
    });
    opener.remove();
    q("ban-cancel").click();
    expect(document.activeElement).toBe(fallback);
  });

  it("says nothing when Cancel is pressed before any request", () => {
    const { notify } = setup(vi.fn());
    q("ban-cancel").click();
    expect(notify).not.toHaveBeenCalled();
  });

  // Edge case: the dialog is closed while its request is in flight.
  it("reports a rejection as a toast when the dialog was closed while the request ran", async () => {
    let fail: (e: unknown) => void = () => {};
    const submit = vi.fn(() => new Promise<BanMemberResponse>((_, reject) => (fail = reject)));
    const { notify } = setup(submit);
    confirm().click();
    escape();
    expect(notify).not.toHaveBeenCalled();
    fail(new ApiClientError(403, "FORBIDDEN", "no"));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith(
      errorText(new ApiClientError(403, "FORBIDDEN", "no"), "Failed to ban member"),
      "error",
    );
    expect(dialog()).toBeNull();
  });

  it("reports the deleted count once when closed while an unfinished purge answers", async () => {
    let release: (v: BanMemberResponse) => void = () => {};
    const submit = vi.fn(() => new Promise<BanMemberResponse>((resolve) => (release = resolve)));
    const { notify } = setup(submit);
    choose("3600");
    confirm().click();
    escape();
    expect(notify).not.toHaveBeenCalled();
    release({ purge: { deleted: 9, complete: false } });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(notify.mock.calls[0]![1]).toBe("warning");
    expect(notify.mock.calls[0]![0]).toContain("9 messages");
  });

  it("stays quiet on close while a retry runs, then reports the final answer", async () => {
    let release: (v: BanMemberResponse) => void = () => {};
    const submit = vi
      .fn<(r: BanRequest) => Promise<BanMemberResponse>>()
      .mockImplementationOnce(incomplete)
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const { notify } = setup(submit);
    choose("3600");
    confirm().click();
    await vi.waitFor(() => expect(confirm().textContent).toBe("Retry"));
    confirm().click();
    escape();
    expect(notify).not.toHaveBeenCalled();
    release({ purge: { deleted: 2, complete: true } });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith("Banned alice and deleted 5 messages", "success");
  });

  // Edge case: the retry window runs out while a retry is in flight.
  it("keeps a running retry busy when the retry window runs out underneath it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setup(incompleteThenHang());
    choose("3600");
    confirm().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(confirm().textContent).toBe("Retry");
    vi.advanceTimersByTime(HOUR - 1000);
    confirm().click();
    vi.advanceTimersByTime(2000);
    expect(confirm().textContent).toBe("Retrying...");
    expect(confirm().disabled).toBe(true);
    expect(q("ban-status").style.display).toBe("none");
  });

  it("keeps Retry for just under an hour and drops it at the hour", async () => {
    await reachRetryWithTimers(vi.fn(incomplete));
    vi.advanceTimersByTime(HOUR - 1);
    expect(confirm().textContent).toBe("Retry");
    expect(q<HTMLInputElement>("ban-reason-input").disabled).toBe(true);
    expect(status()).toContain("only 3 messages");
    vi.advanceTimersByTime(1);
    expect(confirm().textContent).toBe("Ban");
    expect(status()).toContain("ban again");
    expect(q("ban-status").style.display).toBe("block");
  });

  it("leaves no retry timer running once the dialog is closed", async () => {
    await reachRetryWithTimers(vi.fn(incomplete));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    escape();
    expect(vi.getTimerCount()).toBe(0);
  });
});
