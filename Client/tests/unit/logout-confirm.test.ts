import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { confirmLogout } from "../../src/features/settings/logoutConfirm";

const dialog = (): Element | null =>
  document.querySelector("[data-testid='logout-confirm-dialog']");
const click = (testId: string): void =>
  (document.querySelector(`[data-testid='${testId}']`) as HTMLElement).click();

describe("confirmLogout", () => {
  let owner: AbortController;
  let onConfirm: Mock<() => void>;
  let onClosed: Mock<() => void>;

  beforeEach(() => {
    owner = new AbortController();
    onConfirm = vi.fn<() => void>();
    onClosed = vi.fn<() => void>();
  });

  afterEach(() => {
    owner.abort();
    document.body.replaceChildren();
  });

  const open = () => confirmLogout({ signal: owner.signal, onConfirm, onClosed });

  it("asks with the Log Out wording and focuses Cancel", () => {
    open();
    expect(dialog()?.textContent).toContain("Are you sure you want to log out?");
    expect(document.querySelector("h3")?.textContent).toBe("Log Out");
    expect(document.querySelector("[data-testid='logout-confirm']")?.textContent).toBe("Log Out");
    expect(document.activeElement).toBe(document.querySelector("[data-testid='logout-cancel']"));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("labels the dialog by its heading", () => {
    open();
    const modal = dialog()!.querySelector(".modal")!;
    const heading = document.getElementById(modal.getAttribute("aria-labelledby") ?? "");
    expect(heading?.id).toBe("settings-logout-title");
    expect(heading?.textContent).toBe("Log Out");
  });

  it("confirm closes the prompt and logs out once", () => {
    open();
    click("logout-confirm");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("cancel, Escape and the backdrop close without logging out", () => {
    open();
    click("logout-cancel");
    expect(dialog()).toBeNull();

    open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog()).toBeNull();

    open();
    (dialog() as HTMLElement).click();
    expect(dialog()).toBeNull();

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(3);
  });

  it("only one prompt at a time", () => {
    expect(open()).not.toBeNull();
    expect(open()).toBeNull();
    expect(document.querySelectorAll("[data-testid='logout-confirm-dialog']").length).toBe(1);
  });

  it("aborting the owner's signal removes the prompt without logging out", () => {
    open();
    owner.abort();
    expect(dialog()).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
    // Allowed to open again afterwards, and never on a dead signal.
    expect(confirmLogout({ signal: owner.signal, onConfirm })).toBeNull();
  });

  it("the returned closer dismisses it and leaves no document listener behind", () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const close = open()!;
    const added = add.mock.calls.length;
    expect(added).toBeGreaterThan(0);
    close();
    expect(dialog()).toBeNull();
    // Every document listener was registered with a signal that is now aborted.
    for (const call of add.mock.calls) {
      const signal = (call[2] as AddEventListenerOptions | undefined)?.signal;
      expect(signal?.aborted).toBe(true);
    }
    void remove;
    // A late Escape or confirm click does nothing.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onConfirm).not.toHaveBeenCalled();
    add.mockRestore();
    remove.mockRestore();
  });
});
