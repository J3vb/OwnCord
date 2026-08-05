import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CHANNEL_TYPES,
  defaultTypeForCategory,
  createCreateChannelModal,
} from "@components/CreateChannelModal";
import type { CreateChannelModalOptions } from "@components/CreateChannelModal";
import { setChannels, UNCATEGORIZED_VOICE_CATEGORY } from "@stores/channels.store";

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("defaultTypeForCategory", () => {
  it("defaults to voice only in the synthetic uncategorized-voice group", () => {
    expect(defaultTypeForCategory(UNCATEGORIZED_VOICE_CATEGORY)).toBe("voice");
  });

  it("defaults to text everywhere else, voice-sounding names included", () => {
    for (const category of ["Voice Channels", "VOICE CHANNELS", "Text Channels", "Chat", ""]) {
      expect(defaultTypeForCategory(category)).toBe("text");
    }
  });
});

describe("CHANNEL_TYPES", () => {
  it("offers every channel type, regardless of category", () => {
    expect([...CHANNEL_TYPES]).toEqual(["text", "voice", "announcement"]);
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

  it("offers every channel type under a text-sounding category", () => {
    const { modal } = makeModal("Text Channels");
    const select = container.querySelector(
      "[data-testid='channel-type-select']",
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "text",
      "voice",
      "announcement",
    ]);
    modal.destroy?.();
  });

  it("offers every channel type under a voice-sounding category too", () => {
    const { modal } = makeModal("Voice Channels");
    const select = container.querySelector(
      "[data-testid='channel-type-select']",
    ) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "text",
      "voice",
      "announcement",
    ]);
    modal.destroy?.();
  });

  it("pre-fills the category as editable text", () => {
    const { modal } = makeModal("Gaming");
    const input = container.querySelector(
      "[data-testid='channel-category-input']",
    ) as HTMLInputElement;
    expect(input.value).toBe("Gaming");
    expect(input.hasAttribute("disabled")).toBe(false);
    modal.destroy?.();
  });

  it("suggests the categories already in use via a datalist", () => {
    setChannels([
      { id: 1, name: "general", type: "text", category: "Chat", position: 0 },
      { id: 2, name: "lounge", type: "voice", category: "Gaming", position: 1 },
      { id: 3, name: "loose", type: "text", category: null, position: 2 },
    ]);
    const { modal } = makeModal("Chat");
    const list = container.querySelector("#create-channel-categories");
    const values = Array.from(list?.querySelectorAll("option") ?? []).map((o) =>
      o.getAttribute("value"),
    );
    expect(values).toEqual(["Chat", "Gaming"]);
    modal.destroy?.();
  });

  it("submits an edited category rather than the one it opened on", async () => {
    const onCreate = vi.fn(async () => {});
    const { modal } = makeModal("Chat", { onCreate });

    (container.querySelector("[data-testid='channel-name-input']") as HTMLInputElement).value =
      "lounge";
    (container.querySelector("[data-testid='channel-category-input']") as HTMLInputElement).value =
      "  Gaming  ";
    (container.querySelector("[data-testid='channel-type-select']") as HTMLSelectElement).value =
      "voice";
    (container.querySelector("[data-testid='channel-create-submit']") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        name: "lounge",
        type: "voice",
        category: "Gaming",
      });
    });
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

  // ── dialog accessibility contract (DC-13) ──────────────────────────────────

  it("stamps dialog semantics named by the header title", () => {
    const { modal } = makeModal("Text Channels");
    const dialog = container.querySelector(".modal") as HTMLElement;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("create-channel-title");
    expect(container.querySelector("#create-channel-title")?.textContent).toBe("Create Channel");
    modal.destroy?.();
  });

  it("labels the icon-only close button", () => {
    const { modal } = makeModal("Text Channels");
    const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
    expect(closeBtn.getAttribute("aria-label")).toBe("Close");
    modal.destroy?.();
  });

  it("Escape calls onClose without creating", () => {
    const onCreate = vi.fn(async () => {});
    const onClose = vi.fn();
    const { modal } = makeModal("Text Channels", { onCreate, onClose });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
    modal.destroy?.();
  });

  it("ignores Escape after destroy", () => {
    const onClose = vi.fn();
    const { modal } = makeModal("Text Channels", { onClose });
    modal.destroy?.();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("focuses the name input on open and restores focus on destroy", () => {
    const trigger = document.createElement("button");
    container.appendChild(trigger);
    trigger.focus();

    const { modal } = makeModal("Text Channels");
    const nameInput = container.querySelector(
      "[data-testid='channel-name-input']",
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(nameInput);

    modal.destroy?.();
    expect(document.activeElement).toBe(trigger);
  });
});
