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
});
