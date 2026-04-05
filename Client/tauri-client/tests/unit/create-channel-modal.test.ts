import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isVoiceCategory,
  allowedTypesForCategory,
  createCreateChannelModal,
} from "@components/CreateChannelModal";
import type { CreateChannelModalOptions } from "@components/CreateChannelModal";

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("isVoiceCategory", () => {
  it("returns true for 'Voice Channels'", () => {
    expect(isVoiceCategory("Voice Channels")).toBe(true);
  });

  it("returns true for uppercase 'VOICE CHANNELS'", () => {
    expect(isVoiceCategory("VOICE CHANNELS")).toBe(true);
  });

  it("returns true for 'voice'", () => {
    expect(isVoiceCategory("voice")).toBe(true);
  });

  it("returns false for 'Text Channels'", () => {
    expect(isVoiceCategory("Text Channels")).toBe(false);
  });

  it("returns false for 'Chat'", () => {
    expect(isVoiceCategory("Chat")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isVoiceCategory("")).toBe(false);
  });
});

describe("allowedTypesForCategory", () => {
  it("returns only voice for voice categories", () => {
    expect(allowedTypesForCategory("Voice Channels")).toEqual(["voice"]);
  });

  it("returns text and announcement for text categories", () => {
    expect(allowedTypesForCategory("Text Channels")).toEqual(["text", "announcement"]);
  });

  it("returns text and announcement for 'Chat'", () => {
    expect(allowedTypesForCategory("Chat")).toEqual(["text", "announcement"]);
  });
});

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

describe("CreateChannelModal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    // Clean up any modals attached to document.body
    document.querySelectorAll("[data-testid='create-channel-modal']").forEach((el) => el.remove());
  });

  function makeModal(category: string, overrides?: Partial<CreateChannelModalOptions>) {
    const options: CreateChannelModalOptions = {
      category,
      onCreate: overrides?.onCreate ?? vi.fn(async () => {}),
      onClose: overrides?.onClose ?? vi.fn(),
    };
    const modal = createCreateChannelModal(options);
    modal.mount(container);
    return { modal, options };
  }

  it("renders the modal overlay", () => {
    const { modal } = makeModal("Text Channels");
    const overlay = container.querySelector("[data-testid='create-channel-modal']");
    expect(overlay).not.toBeNull();
    modal.destroy?.();
  });

  it("shows only text and announcement types for text categories", () => {
    const { modal } = makeModal("Text Channels");
    const select = container.querySelector(
      "[data-testid='channel-type-select']",
    ) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["text", "announcement"]);
    expect(options).not.toContain("voice");
    modal.destroy?.();
  });

  it("shows only voice type for voice categories", () => {
    const { modal } = makeModal("Voice Channels");
    const select = container.querySelector(
      "[data-testid='channel-type-select']",
    ) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["voice"]);
    expect(options).not.toContain("text");
    modal.destroy?.();
  });

  it("displays the category name as read-only", () => {
    const { modal } = makeModal("Voice Channels");
    const overlay = container.querySelector("[data-testid='create-channel-modal']");
    expect(overlay?.textContent).toContain("Voice Channels");
    modal.destroy?.();
  });

  it("shows error when submitting with empty name", () => {
    const onCreate = vi.fn(async () => {});
    const { modal } = makeModal("Text Channels", { onCreate });

    const submitBtn = container.querySelector(
      "[data-testid='channel-create-submit']",
    ) as HTMLButtonElement;
    submitBtn.click();

    const error = container.querySelector("[data-testid='channel-create-error']");
    expect(error?.textContent).toContain("required");
    expect(onCreate).not.toHaveBeenCalled();
    modal.destroy?.();
  });

  it("calls onCreate with correct data when name is provided", async () => {
    const onCreate = vi.fn(async () => {});
    const { modal } = makeModal("Text Channels", { onCreate });

    const nameInput = container.querySelector(
      "[data-testid='channel-name-input']",
    ) as HTMLInputElement;
    nameInput.value = "test-channel";

    const submitBtn = container.querySelector(
      "[data-testid='channel-create-submit']",
    ) as HTMLButtonElement;
    submitBtn.click();

    // Wait for async handler
    await vi.waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        name: "test-channel",
        type: "text",
        category: "Text Channels",
      });
    });

    modal.destroy?.();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    const { modal } = makeModal("Text Channels", { onClose });

    const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
    closeBtn.click();

    expect(onClose).toHaveBeenCalled();
    modal.destroy?.();
  });

  it("removes overlay on destroy", () => {
    const { modal } = makeModal("Text Channels");
    expect(container.querySelector("[data-testid='create-channel-modal']")).not.toBeNull();
    modal.destroy?.();
    expect(container.querySelector("[data-testid='create-channel-modal']")).toBeNull();
  });

  it("shows error message when onCreate rejects with Error", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("Name already exists"));
    const { modal } = makeModal("Text Channels", { onCreate });

    const nameInput = container.querySelector(
      "[data-testid='channel-name-input']",
    ) as HTMLInputElement;
    nameInput.value = "duplicate";

    const submitBtn = container.querySelector(
      "[data-testid='channel-create-submit']",
    ) as HTMLButtonElement;
    submitBtn.click();

    await vi.waitFor(() => {
      const error = container.querySelector("[data-testid='channel-create-error']");
      expect(error?.textContent).toBe("Name already exists");
    });

    // Button should be re-enabled
    expect(submitBtn.hasAttribute("disabled")).toBe(false);
    expect(submitBtn.textContent).toBe("Create Channel");

    modal.destroy?.();
  });

  it("shows generic error when onCreate rejects with non-Error", async () => {
    const onCreate = vi.fn().mockRejectedValue("string error");
    const { modal } = makeModal("Text Channels", { onCreate });

    const nameInput = container.querySelector(
      "[data-testid='channel-name-input']",
    ) as HTMLInputElement;
    nameInput.value = "test";

    const submitBtn = container.querySelector(
      "[data-testid='channel-create-submit']",
    ) as HTMLButtonElement;
    submitBtn.click();

    await vi.waitFor(() => {
      const error = container.querySelector("[data-testid='channel-create-error']");
      expect(error?.textContent).toBe("Failed to create channel");
    });

    modal.destroy?.();
  });

  it("disables submit button and shows 'Creating...' while creating", async () => {
    let resolveCreate: (() => void) | undefined;
    const onCreate = vi.fn<any>(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { modal } = makeModal("Text Channels", { onCreate });

    const nameInput = container.querySelector(
      "[data-testid='channel-name-input']",
    ) as HTMLInputElement;
    nameInput.value = "new-channel";

    const submitBtn = container.querySelector(
      "[data-testid='channel-create-submit']",
    ) as HTMLButtonElement;
    submitBtn.click();

    expect(submitBtn.hasAttribute("disabled")).toBe(true);
    expect(submitBtn.textContent).toBe("Creating...");

    resolveCreate?.();
    modal.destroy?.();
  });

  it("calls onClose when cancel button is clicked", () => {
    const onClose = vi.fn();
    const { modal } = makeModal("Text Channels", { onClose });

    const cancelBtn = container.querySelector(".btn-modal-cancel") as HTMLButtonElement;
    cancelBtn.click();

    expect(onClose).toHaveBeenCalled();
    modal.destroy?.();
  });

  it("calls onClose on backdrop click", () => {
    const onClose = vi.fn();
    const { modal } = makeModal("Text Channels", { onClose });

    const overlay = container.querySelector(
      "[data-testid='create-channel-modal']",
    ) as HTMLDivElement;
    // Simulate clicking the overlay backdrop directly
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalled();
    modal.destroy?.();
  });

  it("clears previous error when submitting valid data after error", async () => {
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error("First error"))
      .mockResolvedValueOnce(undefined);
    const { modal } = makeModal("Text Channels", { onCreate });

    const nameInput = container.querySelector(
      "[data-testid='channel-name-input']",
    ) as HTMLInputElement;
    nameInput.value = "test";

    const submitBtn = container.querySelector(
      "[data-testid='channel-create-submit']",
    ) as HTMLButtonElement;
    submitBtn.click();

    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid='channel-create-error']")?.textContent).toBe(
        "First error",
      );
    });

    // Try again with a valid name
    nameInput.value = "valid-name";
    submitBtn.click();

    // Error should be hidden
    const error = container.querySelector("[data-testid='channel-create-error']") as HTMLElement;
    expect(error.style.display).toBe("none");

    modal.destroy?.();
  });
});
