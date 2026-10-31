/**
 * The Change Nickname dialog (WP 6.4c): sends a collapsed name of at most 32
 * characters, Reset sends null, one request at a time, and a rejection keeps
 * the dialog open with the server's message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pressComposingEnter } from "../helpers/keyEvents";
import { openNicknameDialog } from "../../src/features/moderation/NicknameDialog";
import type { ModalInstance } from "@lib/ui/modalFactory";
import { ApiClientError, TransportError } from "@lib/api";

const q = <T extends Element = HTMLElement>(testId: string): T =>
  document.querySelector<T>(`[data-testid="${testId}"]`) as T;
const dialog = (): HTMLElement | null => document.querySelector('[data-testid="nickname-dialog"]');
const input = (): HTMLInputElement => q<HTMLInputElement>("nickname-input");

let modal: ModalInstance | null = null;

function setup(
  submit: (name: string | null) => Promise<unknown>,
  current: string | null = "Davey",
) {
  const notify = vi.fn();
  modal = openNicknameDialog({ name: "Dave D.", username: "dave", current, submit, notify });
  return { notify };
}

const type = (value: string): void => {
  input().value = value;
};

describe("nickname dialog", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    modal?.close();
    modal = null;
  });

  it("names the member and prefills the current nickname", () => {
    setup(vi.fn(), "Davey");
    expect(dialog()!.querySelector("h3")!.textContent).toBe("Change nickname for Dave D.");
    expect(input().value).toBe("Davey");
  });

  it("33 runes blocked", async () => {
    const submit = vi.fn().mockResolvedValue({});
    setup(submit);
    type("\u{1F600}".repeat(33));
    q("nickname-save").click();
    await Promise.resolve();
    expect(submit).not.toHaveBeenCalled();
    expect(q("nickname-hint").textContent).toBe("A nickname can have at most 32 characters.");
    expect(dialog()).not.toBeNull();
    // 32 characters (64 UTF-16 units) is allowed.
    type("\u{1F600}".repeat(32));
    q("nickname-save").click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });

  it("collapses spaces", async () => {
    const submit = vi.fn().mockResolvedValue({});
    setup(submit);
    type("  Big \t  Dave  ");
    q("nickname-save").click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("Big Dave"));
  });

  it("an empty field clears, like Reset", async () => {
    const submit = vi.fn().mockResolvedValue({});
    setup(submit);
    type("   ");
    q("nickname-save").click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(null));
  });

  it("Reset sends null", async () => {
    const submit = vi.fn().mockResolvedValue({});
    const { notify } = setup(submit);
    q("nickname-reset").click();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(null));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(notify).toHaveBeenCalledWith("Removed the nickname of dave.", "success");
  });

  it("success closes the dialog", async () => {
    const submit = vi.fn().mockResolvedValue({});
    const { notify } = setup(submit);
    type("Dave");
    q("nickname-save").click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(notify).toHaveBeenCalledWith("Changed the nickname of dave.", "success");
  });

  it("error keeps the dialog open", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(400, "INVALID_INPUT", "That name is taken."))
      .mockResolvedValueOnce({});
    setup(submit);
    type("Alice");
    q("nickname-save").click();
    await vi.waitFor(() => expect(q("nickname-status").textContent).toBe("That name is taken."));
    expect(dialog()).not.toBeNull();
    expect(input().value).toBe("Alice");
    expect(q<HTMLButtonElement>("nickname-save").disabled).toBe(false);
    // Retry (idempotent on the server) sends the same text and closes.
    q("nickname-save").click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenNthCalledWith(2, "Alice");
  });

  it("names the field as a nickname in a server error", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError(400, "INVALID_INPUT", "display_name matches another member's username"),
      );
    setup(submit);
    type("bob");
    q("nickname-save").click();
    await vi.waitFor(() =>
      expect(q("nickname-status").textContent).toBe("Nickname matches another member's username"),
    );
  });

  it("a lost reply shows the error, stays open and resends the same name", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new TransportError("network"))
      .mockResolvedValueOnce({});
    setup(submit);
    type("Dave");
    q("nickname-save").click();
    await vi.waitFor(() => expect(q("nickname-status").textContent).not.toBe(""));
    expect(dialog()).not.toBeNull();
    q("nickname-save").click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit.mock.calls).toEqual([["Dave"], ["Dave"]]);
  });

  it("Enter that commits an IME candidate does not save a half-typed nickname", async () => {
    const submit = vi.fn(async () => ({}));
    setup(submit);
    type("Dave");
    pressComposingEnter(input());
    expect(submit).not.toHaveBeenCalled();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledOnce();
  });

  it("double submit sends once", async () => {
    let resolve!: (v: unknown) => void;
    const submit = vi.fn(() => new Promise((r) => (resolve = r)));
    setup(submit);
    type("Dave");
    q("nickname-save").click();
    q("nickname-save").click();
    q("nickname-reset").click();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(submit).toHaveBeenCalledTimes(1);
    resolve({});
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

const ownerOf = (el: Element): string | null => el.getAttribute("aria-labelledby");

function openWith(extra: {
  signal?: AbortSignal;
  fallbackFocus?: () => HTMLElement | null;
  current?: string | null;
  submit?: (name: string | null) => Promise<unknown>;
}) {
  const notify = vi.fn();
  modal = openNicknameDialog({
    name: "Dave D.",
    username: "dave",
    current: extra.current === undefined ? "Davey" : extra.current,
    submit: extra.submit ?? vi.fn().mockResolvedValue({}),
    notify,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    ...(extra.fallbackFocus === undefined ? {} : { fallbackFocus: extra.fallbackFocus }),
  });
  return { notify };
}

describe("nickname dialog markup", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    modal?.close();
    modal = null;
  });

  it("labels the dialog by its title", () => {
    setup(vi.fn());
    const title = dialog()!.querySelector("h3")!;
    expect(title.id).toBe("nickname-dialog-title");
    expect(ownerOf(dialog()!.querySelector("[role=dialog]")!)).toBe(title.id);
    expect(title.parentElement?.className).toBe("modal-header");
  });

  it("builds a labelled, limited text input with a character hint", () => {
    setup(vi.fn());
    const field = input();
    expect(field.id).toBe("nickname-dialog-input");
    expect(field.className).toBe("form-input");
    expect(field.getAttribute("type")).toBe("text");
    expect(field.getAttribute("autocomplete")).toBe("off");
    // Counted in characters: the unit limit leaves room for pairs.
    expect(field.maxLength).toBe(64);
    const label = dialog()!.querySelector("label")!;
    expect(label.className).toBe("form-label");
    expect(label.getAttribute("for")).toBe(field.id);
    expect(label.textContent).toBe("Nickname");
    const hint = q("nickname-hint");
    expect(hint.id).toMatch(/^nickname-dialog-hint-\d+$/);
    expect(field.getAttribute("aria-describedby")).toContain(hint.id);
    expect(field.parentElement?.className).toBe("form-group");
    expect(field.closest(".modal-body")).not.toBeNull();
  });

  it("starts empty for a member without a nickname", () => {
    setup(vi.fn(), null);
    expect(input().value).toBe("");
  });

  it("cuts a longer paste down to 32 characters", () => {
    setup(vi.fn());
    type("\u{1F600}".repeat(40));
    input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(Array.from(input().value)).toHaveLength(32);
  });

  it("puts Reset, Cancel and Save in the footer as plain buttons", () => {
    setup(vi.fn());
    const footer = dialog()!.querySelector(".modal-footer")!;
    const buttons = [...footer.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual([
      "nickname-reset",
      "nickname-cancel",
      "nickname-save",
    ]);
    expect(buttons.map((b) => b.className)).toEqual([
      "btn-ghost",
      "btn-modal-cancel",
      "btn-primary",
    ]);
    for (const b of buttons) expect(b.getAttribute("type")).toBe("button");
  });

  it("keeps an error line hidden until there is something to say", () => {
    setup(vi.fn());
    const status = q("nickname-status");
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.className).toBe("form-group");
    expect(status.style.display).toBe("none");
  });

  it("focuses the field with the current nickname selected", () => {
    setup(vi.fn(), "Davey");
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(5);
  });
});

describe("nickname dialog behaviour", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    modal?.close();
    modal = null;
  });

  it("closes from Cancel without sending", () => {
    const submit = vi.fn().mockResolvedValue({});
    setup(submit);
    q("nickname-cancel").click();
    expect(dialog()).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps a typed name when the backdrop is clicked", () => {
    setup(vi.fn());
    type("Half typed");
    dialog()!.click();
    expect(dialog()).not.toBeNull();
    expect(input().value).toBe("Half typed");
  });

  it("closes with its owner's signal", () => {
    const owner = new AbortController();
    openWith({ signal: owner.signal });
    expect(dialog()).not.toBeNull();
    owner.abort();
    expect(dialog()).toBeNull();
  });

  it("stops updating the limit hint once its owner's signal aborts", () => {
    const owner = new AbortController();
    openWith({ signal: owner.signal });
    const field = input();
    const hint = q("nickname-hint");
    const before = hint.textContent;
    owner.abort();
    field.value = "\u{1F600}".repeat(32);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(hint.textContent).toBe(before);
  });

  it("returns focus to the fallback when the opener is gone", () => {
    const opener = document.createElement("button");
    const fallback = document.createElement("button");
    document.body.append(opener, fallback);
    opener.focus();
    openWith({ fallbackFocus: () => fallback });
    opener.remove();
    modal!.close();
    expect(document.activeElement).toBe(fallback);
  });

  it("saves on Enter and consumes the key", async () => {
    const submit = vi.fn().mockResolvedValue({});
    setup(submit);
    type("Dave");
    const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("Dave"));
  });

  it("ignores other keys in the field", () => {
    const submit = vi.fn().mockResolvedValue({});
    setup(submit);
    type("Dave");
    for (const key of ["a", "Tab", " ", "Escape"]) {
      const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      input().dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows the error line after a failure and hides it again on the next send", async () => {
    let reject!: (e: unknown) => void;
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(400, "INVALID_INPUT", "That name is taken."))
      .mockImplementationOnce(() => new Promise((_, r) => (reject = r)));
    setup(submit);
    type("Alice");
    q("nickname-save").click();
    await vi.waitFor(() => expect(q("nickname-status").textContent).toBe("That name is taken."));
    expect(q("nickname-status").style.display).toBe("block");
    q("nickname-save").click();
    expect(q("nickname-status").style.display).toBe("none");
    reject(new TransportError("network"));
    await vi.waitFor(() => expect(q("nickname-status").style.display).toBe("block"));
  });

  it("puts the cursor back in the field after a failure", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("Try again"));
    setup(submit);
    type("Alice");
    q("nickname-save").focus();
    q("nickname-save").click();
    expect(q<HTMLInputElement>("nickname-input").disabled).toBe(true);
    await vi.waitFor(() => expect(q("nickname-status").textContent).toBe("Try again"));
    expect(document.activeElement).toBe(input());
  });

  it("puts the cursor back in the field after a too-long name is refused", () => {
    setup(vi.fn());
    type("x".repeat(33));
    q("nickname-save").focus();
    q("nickname-save").click();
    expect(document.activeElement).toBe(input());
  });

  it("checks no name while a request is running", () => {
    setup(() => new Promise(() => {}));
    type("Dave");
    q("nickname-save").click();
    const hint = q("nickname-hint").textContent;
    type("x".repeat(40));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(q("nickname-hint").textContent).toBe(hint);
    expect(q("nickname-hint").classList.contains("limit-hint--error")).toBe(false);
  });

  it("reports a failure that arrives after the dialog was closed as a toast", async () => {
    let reject!: (e: unknown) => void;
    const { notify } = setup(() => new Promise((_, r) => (reject = r)));
    type("Dave");
    q("nickname-save").click();
    modal!.close();
    reject(new ApiClientError(400, "INVALID_INPUT", "That name is taken."));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("That name is taken.", "error"));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("only renames the leading field name in a server error", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("Value of display_name is not allowed"));
    setup(submit);
    type("bob");
    q("nickname-save").click();
    await vi.waitFor(() =>
      expect(q("nickname-status").textContent).toBe("Value of display_name is not allowed"),
    );
  });
});
