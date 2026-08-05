import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDeleteChannelModal } from "@components/DeleteChannelModal";
import type { DeleteChannelModalOptions } from "@components/DeleteChannelModal";

describe("DeleteChannelModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll("[data-testid='delete-channel-modal']").forEach((el) => el.remove());
  });

  function makeModal(overrides?: Partial<DeleteChannelModalOptions>) {
    const options: DeleteChannelModalOptions = {
      channelId: 1,
      channelName: "general",
      onConfirm: overrides?.onConfirm ?? vi.fn(async () => {}),
      onClose: overrides?.onClose ?? vi.fn(),
    };
    const modal = createDeleteChannelModal(options);
    modal.mount(container);
    return { modal, options };
  }

  it("renders the modal overlay", () => {
    const { modal } = makeModal();
    expect(container.querySelector("[data-testid='delete-channel-modal']")).not.toBeNull();
    modal.destroy?.();
  });

  it("displays channel name in warning message", () => {
    const { modal } = makeModal();
    const overlay = container.querySelector("[data-testid='delete-channel-modal']");
    expect(overlay?.textContent).toContain("#general");
    modal.destroy?.();
  });

  it("displays cannot be undone warning", () => {
    const { modal } = makeModal();
    const overlay = container.querySelector("[data-testid='delete-channel-modal']");
    expect(overlay?.textContent).toContain("cannot be undone");
    modal.destroy?.();
  });

  it("calls onConfirm when delete button is clicked", async () => {
    const onConfirm = vi.fn(async () => {});
    const { modal } = makeModal({ onConfirm });
    const deleteBtn = container.querySelector(
      "[data-testid='delete-channel-confirm']",
    ) as HTMLButtonElement;
    deleteBtn.click();

    await vi.waitFor(() => {
      expect(onConfirm).toHaveBeenCalled();
    });
    modal.destroy?.();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    const { modal } = makeModal({ onClose });
    const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
    closeBtn.click();
    expect(onClose).toHaveBeenCalled();
    modal.destroy?.();
  });

  it("calls onClose when cancel button is clicked", () => {
    const onClose = vi.fn();
    const { modal } = makeModal({ onClose });
    const cancelBtn = container.querySelector(".btn-modal-cancel") as HTMLButtonElement;
    cancelBtn.click();
    expect(onClose).toHaveBeenCalled();
    modal.destroy?.();
  });

  it("removes overlay on destroy", () => {
    const { modal } = makeModal();
    expect(container.querySelector("[data-testid='delete-channel-modal']")).not.toBeNull();
    modal.destroy?.();
    expect(container.querySelector("[data-testid='delete-channel-modal']")).toBeNull();
  });

  it("shows error and re-enables button when onConfirm rejects with Error", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("Permission denied"));
    const { modal } = makeModal({ onConfirm });

    const deleteBtn = container.querySelector(
      "[data-testid='delete-channel-confirm']",
    ) as HTMLButtonElement;
    deleteBtn.click();

    await vi.waitFor(() => {
      const error = container.querySelector("[data-testid='delete-channel-error']");
      expect(error?.textContent).toBe("Permission denied");
    });

    expect(deleteBtn.hasAttribute("disabled")).toBe(false);
    expect(deleteBtn.textContent).toBe("Delete Channel");

    modal.destroy?.();
  });

  it("shows generic error when onConfirm rejects with non-Error", async () => {
    const onConfirm = vi.fn().mockRejectedValue(42);
    const { modal } = makeModal({ onConfirm });

    const deleteBtn = container.querySelector(
      "[data-testid='delete-channel-confirm']",
    ) as HTMLButtonElement;
    deleteBtn.click();

    await vi.waitFor(() => {
      const error = container.querySelector("[data-testid='delete-channel-error']");
      expect(error?.textContent).toBe("Failed to delete channel");
    });

    modal.destroy?.();
  });

  it("disables button and shows 'Deleting...' during delete", async () => {
    let resolveDelete: (() => void) | undefined;
    const onConfirm = vi.fn<any>(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    const { modal } = makeModal({ onConfirm });

    const deleteBtn = container.querySelector(
      "[data-testid='delete-channel-confirm']",
    ) as HTMLButtonElement;
    deleteBtn.click();

    expect(deleteBtn.hasAttribute("disabled")).toBe(true);
    expect(deleteBtn.textContent).toBe("Deleting...");

    resolveDelete?.();
    modal.destroy?.();
  });

  it("calls onClose on backdrop click", () => {
    const onClose = vi.fn();
    const { modal } = makeModal({ onClose });

    const overlay = container.querySelector(
      "[data-testid='delete-channel-modal']",
    ) as HTMLDivElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalled();
    modal.destroy?.();
  });

  // ── dialog accessibility contract (DC-13) ──────────────────────────────────

  it("stamps dialog semantics named by the header title", () => {
    const { modal } = makeModal();
    const dialog = container.querySelector(".modal") as HTMLElement;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("delete-channel-title");
    expect(container.querySelector("#delete-channel-title")?.textContent).toBe("Delete Channel");
    modal.destroy?.();
  });

  it("labels the icon-only close button", () => {
    const { modal } = makeModal();
    const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
    expect(closeBtn.getAttribute("aria-label")).toBe("Close");
    modal.destroy?.();
  });

  it("Escape cancels without confirming the delete", () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = vi.fn();
    const { modal } = makeModal({ onConfirm, onClose });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    modal.destroy?.();
  });

  it("ignores Escape after destroy", () => {
    const onClose = vi.fn();
    const { modal } = makeModal({ onClose });
    modal.destroy?.();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves focus into the dialog on open and restores it on destroy", () => {
    const trigger = document.createElement("button");
    container.appendChild(trigger);
    trigger.focus();

    const { modal } = makeModal();
    // First focusable is the header's close button — safely away from the
    // destructive confirm.
    const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
    expect(document.activeElement).toBe(closeBtn);

    modal.destroy?.();
    expect(document.activeElement).toBe(trigger);
  });
});
