/**
 * The Warn dialog: a required, cleaned reason of at most 500 characters, one
 * request at a time, and a rejection keeps the dialog open with the reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openWarnDialog } from "../../src/features/moderation/WarnDialog";
import type { ModalInstance } from "@lib/ui/modalFactory";
import { ApiClientError, TransportError } from "@lib/api";

const q = <T extends Element = HTMLElement>(testId: string): T =>
  document.querySelector<T>(`[data-testid="${testId}"]`) as T;
const dialog = (): HTMLElement | null => document.querySelector('[data-testid="warn-dialog"]');
const input = (): HTMLInputElement => q<HTMLInputElement>("warn-input");
const sendButton = (): HTMLButtonElement => q<HTMLButtonElement>("warn-send");

let modal: ModalInstance | null = null;

function setup(submit: (reason: string) => Promise<unknown>) {
  const notify = vi.fn();
  modal = openWarnDialog({ name: "Dave D.", username: "dave", submit, notify });
  return { notify };
}

describe("warn dialog", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });
  afterEach(() => {
    modal?.close();
    modal = null;
  });

  it("names the member in the title", () => {
    setup(vi.fn());
    expect(dialog()!.querySelector("h3")!.textContent).toBe("Warn Dave D.");
  });

  it("requires a reason", async () => {
    const submit = vi.fn().mockResolvedValue({});
    setup(submit);
    input().value = "   ";
    sendButton().click();
    await Promise.resolve();
    expect(submit).not.toHaveBeenCalled();
    expect(q("warn-hint").textContent).toContain("Write a reason");
    expect(dialog()).not.toBeNull();
  });

  it("sends the cleaned reason, toasts and closes", async () => {
    const submit = vi.fn().mockResolvedValue({ id: 1 });
    const { notify } = setup(submit);
    input().value = "  Spam \t in\u0007  general ";
    sendButton().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledWith("Spam in general");
    expect(notify).toHaveBeenCalledWith("Warned dave.", "success");
  });

  it("blocks a reason over 500 characters", async () => {
    const submit = vi.fn().mockResolvedValue({});
    setup(submit);
    input().value = "a".repeat(501);
    sendButton().click();
    await Promise.resolve();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    [403, "FORBIDDEN", "Cannot moderate a user of equal or higher rank"],
    [404, "NOT_FOUND", "That item no longer exists."],
    [400, "INVALID_INPUT", "Reason is too long"],
  ])("a %i refusal shows inside the dialog and keeps the reason", async (status, code, msg) => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(status, code, msg))
      .mockResolvedValueOnce({});
    const { notify } = setup(submit);
    input().value = "Be kind";
    sendButton().click();
    await vi.waitFor(() => expect(q("warn-status").textContent).toBe(msg));
    expect(dialog()).not.toBeNull();
    expect(input().value).toBe("Be kind");
    expect(input().disabled).toBe(false);
    expect(sendButton().disabled).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    sendButton().click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenNthCalledWith(2, "Be kind");
  });

  it("a lost reply keeps the dialog open", async () => {
    setup(vi.fn().mockRejectedValueOnce(new TransportError("network")));
    input().value = "Be kind";
    sendButton().click();
    await vi.waitFor(() => expect(q("warn-status").textContent).not.toBe(""));
    expect(dialog()).not.toBeNull();
    expect(input().value).toBe("Be kind");
  });

  it("a double submit sends one request and disables the button while it runs", async () => {
    let resolve: (v: unknown) => void = () => {};
    const submit = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    setup(submit);
    input().value = "Be kind";
    sendButton().click();
    expect(sendButton().disabled).toBe(true);
    sendButton().click();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(submit).toHaveBeenCalledTimes(1);
    resolve({ id: 1 });
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes without a request", () => {
    const submit = vi.fn().mockResolvedValue({});
    setup(submit);
    q("warn-cancel").click();
    expect(dialog()).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });
});
