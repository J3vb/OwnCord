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
    const deleteBtn = container.querySelector("[data-testid='delete-channel-confirm']") as HTMLButtonElement;
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
});
