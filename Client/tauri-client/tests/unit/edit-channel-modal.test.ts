import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEditChannelModal } from "@components/EditChannelModal";
import type { EditChannelModalOptions } from "@components/EditChannelModal";

describe("EditChannelModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll("[data-testid='edit-channel-modal']").forEach((el) => el.remove());
  });

  function makeModal(overrides?: Partial<EditChannelModalOptions>) {
    const options: EditChannelModalOptions = {
      channelId: 1,
      channelName: "general",
      channelType: "text",
      onSave: overrides?.onSave ?? vi.fn(async () => {}),
      onClose: overrides?.onClose ?? vi.fn(),
    };
    const modal = createEditChannelModal(options);
    modal.mount(container);
    return { modal, options };
  }

  it("renders the modal overlay", () => {
    const { modal } = makeModal();
    expect(container.querySelector("[data-testid='edit-channel-modal']")).not.toBeNull();
    modal.destroy?.();
  });

  it("pre-fills the name input with current channel name", () => {
    const { modal } = makeModal();
    const input = container.querySelector("[data-testid='edit-channel-name-input']") as HTMLInputElement;
    expect(input.value).toBe("general");
    modal.destroy?.();
  });

  it("displays the channel type as read-only", () => {
    const { modal } = makeModal();
    const overlay = container.querySelector("[data-testid='edit-channel-modal']");
    expect(overlay?.textContent).toContain("Text");
    modal.destroy?.();
  });

  it("shows error when saving with empty name", () => {
    const onSave = vi.fn(async () => {});
    const { modal } = makeModal({ onSave });
    const input = container.querySelector("[data-testid='edit-channel-name-input']") as HTMLInputElement;
    input.value = "";

    const saveBtn = container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement;
    saveBtn.click();

    const error = container.querySelector("[data-testid='edit-channel-error']");
    expect(error?.textContent).toContain("required");
    expect(onSave).not.toHaveBeenCalled();
    modal.destroy?.();
  });

  it("calls onSave with updated name", async () => {
    const onSave = vi.fn(async () => {});
    const { modal } = makeModal({ onSave });
    const input = container.querySelector("[data-testid='edit-channel-name-input']") as HTMLInputElement;
    input.value = "renamed-channel";

    const saveBtn = container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement;
    saveBtn.click();

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({ name: "renamed-channel" });
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

  it("removes overlay on destroy", () => {
    const { modal } = makeModal();
    expect(container.querySelector("[data-testid='edit-channel-modal']")).not.toBeNull();
    modal.destroy?.();
    expect(container.querySelector("[data-testid='edit-channel-modal']")).toBeNull();
  });

  it("shows error message when onSave rejects with Error", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Server error"));
    const { modal } = makeModal({ onSave });

    const input = container.querySelector("[data-testid='edit-channel-name-input']") as HTMLInputElement;
    input.value = "new-name";

    const saveBtn = container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement;
    saveBtn.click();

    await vi.waitFor(() => {
      const error = container.querySelector("[data-testid='edit-channel-error']");
      expect(error?.textContent).toBe("Server error");
    });

    // Button should be re-enabled
    expect(saveBtn.hasAttribute("disabled")).toBe(false);
    expect(saveBtn.textContent).toBe("Save Changes");

    modal.destroy?.();
  });

  it("shows generic error when onSave rejects with non-Error", async () => {
    const onSave = vi.fn().mockRejectedValue("unknown");
    const { modal } = makeModal({ onSave });

    const input = container.querySelector("[data-testid='edit-channel-name-input']") as HTMLInputElement;
    input.value = "new-name";

    const saveBtn = container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement;
    saveBtn.click();

    await vi.waitFor(() => {
      const error = container.querySelector("[data-testid='edit-channel-error']");
      expect(error?.textContent).toBe("Failed to update channel");
    });

    modal.destroy?.();
  });

  it("disables save button and shows 'Saving...' during save", async () => {
    let resolveSave: (() => void) | null = null;
    const onSave = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const { modal } = makeModal({ onSave });

    const input = container.querySelector("[data-testid='edit-channel-name-input']") as HTMLInputElement;
    input.value = "renamed";

    const saveBtn = container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement;
    saveBtn.click();

    expect(saveBtn.hasAttribute("disabled")).toBe(true);
    expect(saveBtn.textContent).toBe("Saving...");

    resolveSave?.();
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

  it("calls onClose on backdrop click", () => {
    const onClose = vi.fn();
    const { modal } = makeModal({ onClose });

    const overlay = container.querySelector("[data-testid='edit-channel-modal']") as HTMLDivElement;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalled();
    modal.destroy?.();
  });

  it("adds error class to input on empty name validation", () => {
    const onSave = vi.fn(async () => {});
    const { modal } = makeModal({ onSave });

    const input = container.querySelector("[data-testid='edit-channel-name-input']") as HTMLInputElement;
    input.value = "   "; // whitespace only

    const saveBtn = container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement;
    saveBtn.click();

    expect(input.classList.contains("error")).toBe(true);
    modal.destroy?.();
  });
});
