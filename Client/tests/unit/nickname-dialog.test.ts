/**
 * The Change Nickname dialog (WP 6.4c): sends a collapsed name of at most 32
 * characters, Reset sends null, one request at a time, and a rejection keeps
 * the dialog open with the server's message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openNicknameDialog } from "../../src/features/moderation/NicknameDialog";
import type { ModalInstance } from "@lib/modalFactory";
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
    input().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
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
