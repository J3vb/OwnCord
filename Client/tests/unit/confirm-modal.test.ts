import { describe, it, expect, vi, afterEach } from "vitest";
import { createDeferred as deferred } from "../helpers/deferred";
import {
  createConfirmModal,
  type ConfirmModalOptions,
} from "../../src/features/dialogs/confirmModal";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const escape = (): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

const opened: { close(): void }[] = [];

function open(over: Partial<ConfirmModalOptions> = {}) {
  const onConfirm = vi.fn<() => void | Promise<void>>();
  const onClose = vi.fn<() => void>();
  const modal = createConfirmModal({
    title: "Delete it",
    body: "Are you sure?",
    confirmLabel: "Delete",
    testId: "cm",
    confirmTestId: "cm-confirm",
    cancelTestId: "cm-cancel",
    onConfirm,
    onClose,
    ...over,
  });
  opened.push(modal);
  return { modal, onConfirm, onClose };
}

describe("createConfirmModal", () => {
  afterEach(() => {
    for (const m of opened.splice(0)) m.close();
    document.body.replaceChildren();
  });

  it("renders title, body and labels, and focuses Cancel", () => {
    const { modal } = open();
    expect(modal.title.textContent).toBe("Delete it");
    expect(modal.body.textContent).toContain("Are you sure?");
    expect(modal.confirm.textContent).toBe("Delete");
    expect(modal.confirm.className).toBe("btn-danger");
    expect(modal.cancel.textContent).toBe("Cancel");
    expect(document.activeElement).toBe(modal.cancel);
    expect(modal.modal.getAttribute("aria-labelledby")).toBe(modal.title.id);
    expect(document.querySelector("[data-testid='cm']")).toBe(modal.overlay);
  });

  it("uses the primary class for a primary tone", () => {
    const { modal } = open({ tone: "primary" });
    expect(modal.confirm.className).toBe("btn-modal-save");
  });

  it("Escape cancels without confirming", () => {
    const { onConfirm, onClose } = open();
    escape();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-testid='cm']")).toBeNull();
  });

  it("the backdrop and Cancel cancel without confirming", () => {
    const first = open();
    first.modal.overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(first.onConfirm).not.toHaveBeenCalled();
    expect(first.onClose).toHaveBeenCalledTimes(1);

    const second = open();
    second.modal.cancel.click();
    expect(second.onConfirm).not.toHaveBeenCalled();
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });

  it("a sync confirm closes first, then runs once", () => {
    const order: string[] = [];
    const { modal, onConfirm, onClose } = open();
    onClose.mockImplementation(() => order.push("close"));
    onConfirm.mockImplementation(() => {
      order.push("confirm");
    });
    modal.confirm.click();
    modal.confirm.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["close", "confirm"]);
    expect(document.querySelector("[data-testid='cm']")).toBeNull();
  });

  it("a click after close does not run the action", () => {
    const { modal, onConfirm } = open();
    modal.close();
    modal.confirm.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores an auto-repeating keydown", () => {
    const { modal } = open();
    const repeat = new KeyboardEvent("keydown", { key: "Enter", repeat: true, cancelable: true });
    modal.modal.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    const first = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    modal.modal.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
  });

  it("renders the close button and wires describedBy", () => {
    const { modal, onClose } = open({ closeButton: true, describedBy: "cm-body" });
    expect(modal.modal.getAttribute("aria-describedby")).toBe("cm-body");
    modal.modal.querySelector<HTMLElement>(".modal-close")?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("async confirm", () => {
    it("disables confirm while pending and closes on resolve", async () => {
      const d = deferred();
      const { modal, onConfirm, onClose } = open({
        onConfirm: () => d.promise,
        staysOpen: true,
        busyLabel: "...",
      });
      modal.confirm.click();
      expect(modal.confirm.disabled).toBe(true);
      expect(modal.confirm.textContent).toBe("...");
      modal.confirm.click();
      expect(document.querySelector("[data-testid='cm']")).not.toBeNull();
      d.resolve();
      await flush();
      expect(document.querySelector("[data-testid='cm']")).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("runs a pending action once on double click", async () => {
      const d = deferred();
      const action = vi.fn(() => d.promise);
      const { modal } = open({ onConfirm: action, staysOpen: true });
      modal.confirm.click();
      modal.confirm.click();
      expect(action).toHaveBeenCalledTimes(1);
      d.resolve();
      await flush();
    });

    it("shows failureText inline on reject and re-arms the button", async () => {
      const d = deferred();
      const { modal, onClose } = open({
        onConfirm: () => d.promise,
        staysOpen: true,
        busyLabel: "...",
        failureText: (err) => `failed: ${String(err)}`,
        errorTestId: "cm-error",
      });
      modal.confirm.click();
      d.reject("boom");
      await flush();
      const err = document.querySelector("[data-testid='cm-error']");
      expect(err?.textContent).toBe("failed: boom");
      expect(modal.confirm.disabled).toBe(false);
      expect(modal.confirm.textContent).toBe("Delete");
      expect(onClose).not.toHaveBeenCalled();
      expect(document.querySelector("[data-testid='cm']")).not.toBeNull();
    });

    it("a signal abort mid-flight closes once and later settle touches nothing", async () => {
      const d = deferred();
      const ac = new AbortController();
      const failureText = vi.fn(() => "nope");
      const { modal, onClose } = open({
        onConfirm: () => d.promise,
        staysOpen: true,
        signal: ac.signal,
        failureText,
      });
      modal.confirm.click();
      ac.abort();
      expect(onClose).toHaveBeenCalledTimes(1);
      d.reject(new Error("late"));
      await flush();
      expect(failureText).not.toHaveBeenCalled();
      expect(modal.confirm.textContent).toBe("Delete");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("with closeOnResolve false, a resolve leaves the dialog open and re-arms", async () => {
      const d = deferred();
      const { modal, onClose } = open({
        onConfirm: () => d.promise,
        staysOpen: true,
        closeOnResolve: false,
        busyLabel: "Deleting",
      });
      modal.confirm.click();
      expect(modal.confirm.disabled).toBe(true);
      d.resolve();
      await flush();
      expect(modal.confirm.disabled).toBe(false);
      expect(modal.confirm.textContent).toBe("Delete");
      expect(onClose).not.toHaveBeenCalled();
      expect(document.querySelector("[data-testid='cm']")).not.toBeNull();
    });

    it("destroy() mid-flight closes once and a later resolve touches nothing", async () => {
      const d = deferred();
      const { modal, onConfirm, onClose } = open({ staysOpen: true, busyLabel: "Deleting" });
      onConfirm.mockReturnValue(d.promise);
      modal.confirm.click();
      modal.destroy();
      expect(onClose).toHaveBeenCalledTimes(1);
      d.resolve();
      await flush();
      expect(modal.confirm.textContent).toBe("Deleting");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});
