import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CHANNEL_TYPES, createCreateChannelModal } from "@components/CreateChannelModal";
import type { CreateChannelModalOptions } from "@components/CreateChannelModal";
import { NO_CATEGORY, setChannels, type CategoryRef } from "@stores/channels.store";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/serverCapabilities";

describe("CHANNEL_TYPES", () => {
  it("offers every channel type, regardless of category", () => {
    expect([...CHANNEL_TYPES]).toEqual(["text", "voice", "announcement"]);
  });
});

describe("Forum in the type list", () => {
  afterEach(() => {
    resetServerCapabilities();
    document.body.replaceChildren();
  });
  const typeOptions = (): string[] => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const modal = createCreateChannelModal({
      category: { id: 0, name: "Text Channels" },
      onCreate: vi.fn(async () => {}),
      onClose: vi.fn(),
    });
    modal.mount(container);
    const values = Array.from(
      container.querySelectorAll<HTMLOptionElement>("[data-testid='channel-type-select'] option"),
    ).map((o) => o.value);
    modal.destroy?.();
    return values;
  };

  it("is offered only when the server has the forums capability", () => {
    applyReadyCapabilities({});
    expect(typeOptions()).toEqual(["text", "voice", "announcement"]);
    applyReadyCapabilities({ forums: true });
    expect(typeOptions()).toEqual(["text", "voice", "announcement", "forum"]);
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

  /** A bare string is a name-only category (a server that sends no ids). */
  function makeModal(
    category: string | CategoryRef,
    overrides?: Partial<CreateChannelModalOptions>,
  ) {
    const options: CreateChannelModalOptions = {
      category: typeof category === "string" ? { id: 0, name: category } : category,
      ...(overrides?.type === undefined ? {} : { type: overrides.type }),
      onCreate: overrides?.onCreate ?? vi.fn(async () => {}),
      onClose: overrides?.onClose ?? vi.fn(),
    };
    const modal = createCreateChannelModal(options);
    modal.mount(container);
    return { modal, options };
  }

  it("names each form control by its visible label", () => {
    const { modal } = makeModal("Text Channels");
    const labelOf = (testId: string) =>
      [
        ...((container.querySelector(`[data-testid='${testId}']`) as HTMLInputElement).labels ??
          []),
      ].map((l) => l.textContent);
    expect(labelOf("channel-category-select")).toEqual(["Category"]);
    expect(labelOf("channel-name-input")).toEqual(["Name"]);
    expect(labelOf("channel-type-select")).toEqual(["Type"]);
    modal.destroy?.();
  });

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

  const categoryChannels = [
    {
      id: 1,
      name: "general",
      type: "text",
      category: "Chat",
      category_id: 2,
      category_position: 0,
      position: 0,
    },
    {
      id: 2,
      name: "lounge",
      type: "voice",
      category: "Gaming",
      category_id: 5,
      category_position: 1,
      position: 1,
    },
    { id: 3, name: "loose", type: "text", category: null, position: 2 },
  ] as const;
  const select = () =>
    container.querySelector("[data-testid='channel-category-select']") as HTMLSelectElement;

  it("pre-selects the category the create was opened from", () => {
    setChannels(categoryChannels);
    const { modal } = makeModal({ id: 5, name: "Gaming" });
    expect(select().value).toBe("id:5");
    expect(select().hasAttribute("disabled")).toBe(false);
    modal.destroy?.();
  });

  it("pre-selects No category from the server menu", () => {
    setChannels(categoryChannels);
    const { modal } = makeModal(NO_CATEGORY);
    expect(select().value).toBe("");
    modal.destroy?.();
  });

  it("offers No category first, then the known categories", () => {
    setChannels(categoryChannels);
    const { modal } = makeModal({ id: 2, name: "Chat" });
    expect(Array.from(select().options).map((o) => [o.value, o.textContent])).toEqual([
      ["", "No category"],
      ["id:2", "Chat"],
      ["id:5", "Gaming"],
    ]);
    modal.destroy?.();
  });

  it("offers the free-text categories of a server that sends no ids, by name", () => {
    setChannels([{ id: 1, name: "general", type: "text", category: "Chat", position: 0 }]);
    const { modal } = makeModal("Chat");
    expect(select().value).toBe("name:Chat");
    modal.destroy?.();
  });

  it("pre-selects the type hint it was given", () => {
    const { modal } = makeModal(NO_CATEGORY, { type: "voice" });
    expect(
      (container.querySelector("[data-testid='channel-type-select']") as HTMLSelectElement).value,
    ).toBe("voice");
    modal.destroy?.();
  });

  it("submits the chosen category id rather than the one it opened on", async () => {
    setChannels(categoryChannels);
    const onCreate = vi.fn(async () => {});
    const { modal } = makeModal({ id: 2, name: "Chat" }, { onCreate });

    (container.querySelector("[data-testid='channel-name-input']") as HTMLInputElement).value =
      "lounge";
    select().value = "id:5";
    (container.querySelector("[data-testid='channel-type-select']") as HTMLSelectElement).value =
      "voice";
    (container.querySelector("[data-testid='channel-create-submit']") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        name: "lounge",
        type: "voice",
        category_id: 5,
        position: expect.any(Number),
      });
    });
    modal.destroy?.();
  });

  it("No category sends both fields, so a server from before categories clears it too", async () => {
    setChannels(categoryChannels);
    const onCreate = vi.fn(async (_data: object) => {});
    const { modal } = makeModal({ id: 2, name: "Chat" }, { onCreate });
    (container.querySelector("[data-testid='channel-name-input']") as HTMLInputElement).value = "x";
    select().value = "";
    (container.querySelector("[data-testid='channel-create-submit']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ category_id: 0, category: "" });
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
        position: expect.any(Number),
      });
    });

    modal.destroy?.();
  });

  describe("topic and Enter", () => {
    const q = <T extends HTMLElement>(id: string): T =>
      container.querySelector(`[data-testid='${id}']`) as T;
    const press = (init: KeyboardEventInit): KeyboardEvent => {
      const e = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      q("channel-name-input").dispatchEvent(e);
      return e;
    };

    it("has an optional topic field capped at the server's length", () => {
      const { modal } = makeModal("Chat");
      const topic = q<HTMLInputElement>("channel-topic-input");
      expect(topic.getAttribute("maxlength")).toBe("1024");
      expect(container.querySelector("label[for='create-channel-topic']")).not.toBeNull();
      modal.destroy?.();
    });

    it("sends a trimmed topic when given", async () => {
      const onCreate = vi.fn(async (_d: { name: string; topic?: string }) => {});
      const { modal } = makeModal("Chat", { onCreate });
      q<HTMLInputElement>("channel-name-input").value = "a";
      q<HTMLInputElement>("channel-topic-input").value = "  hello  ";
      q<HTMLButtonElement>("channel-create-submit").click();
      await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect(onCreate.mock.calls[0]![0]).toMatchObject({ name: "a", topic: "hello" });

      modal.destroy?.();
    });

    it("omits a blank topic", async () => {
      const onCreate = vi.fn(async (_d: { name: string; topic?: string }) => {});
      const { modal } = makeModal("Chat", { onCreate });
      q<HTMLInputElement>("channel-name-input").value = "a";
      q<HTMLInputElement>("channel-topic-input").value = "   ";
      q<HTMLButtonElement>("channel-create-submit").click();
      await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      expect("topic" in onCreate.mock.calls[0]![0]).toBe(false);
      modal.destroy?.();
    });

    it("Enter in the name field submits", async () => {
      const onCreate = vi.fn(async () => {});
      const { modal } = makeModal("Chat", { onCreate });
      q<HTMLInputElement>("channel-name-input").value = "fresh";
      const e = press({});
      expect(e.defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
      modal.destroy?.();
    });

    it("Enter does not submit while an IME is composing", () => {
      const onCreate = vi.fn(async () => {});
      const { modal } = makeModal("Chat", { onCreate });
      q<HTMLInputElement>("channel-name-input").value = "fresh";
      press({ isComposing: true });
      press({ keyCode: 229 });
      expect(onCreate).not.toHaveBeenCalled();
      modal.destroy?.();
    });

    it("Enter does not submit an empty name, and shows no error", () => {
      const onCreate = vi.fn(async () => {});
      const { modal } = makeModal("Chat", { onCreate });
      q<HTMLInputElement>("channel-name-input").value = "   ";
      press({});
      expect(onCreate).not.toHaveBeenCalled();
      modal.destroy?.();
    });

    it("a second Enter while the create is in flight does not submit twice", async () => {
      let release: () => void = () => {};
      const onCreate = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const { modal } = makeModal("Chat", { onCreate });
      q<HTMLInputElement>("channel-name-input").value = "fresh";
      press({});
      press({});
      expect(onCreate).toHaveBeenCalledTimes(1);
      release();
      modal.destroy?.();
    });
  });

  it("sends position one past the highest in the category so the channel lands last", async () => {
    setChannels([
      { id: 1, name: "a", type: "text", category: "Chat", position: 3 },
      { id: 2, name: "b", type: "voice", category: "Chat", position: 7 },
      { id: 3, name: "c", type: "text", category: "Other", position: 40 },
    ]);
    const onCreate = vi.fn(
      async (_data: { position: number; category?: string; category_id?: number }) => {},
    );
    const { modal } = makeModal("Chat", { onCreate });
    (container.querySelector("[data-testid='channel-name-input']") as HTMLInputElement).value =
      "fresh";
    (container.querySelector("[data-testid='channel-create-submit']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ category: "Chat", position: 8 });
    modal.destroy?.();
  });

  it("counts uncategorized voice channels when creating from the synthetic Voice group", async () => {
    setChannels([
      { id: 1, name: "v1", type: "voice", category: null, position: 3 },
      { id: 2, name: "v2", type: "voice", category: "", position: 5 },
      { id: 3, name: "t", type: "text", category: null, position: 9 },
    ]);
    const onCreate = vi.fn(
      async (_data: { position: number; category?: string; category_id?: number }) => {},
    );
    const { modal } = makeModal(NO_CATEGORY, { onCreate, type: "voice" });
    (container.querySelector("[data-testid='channel-name-input']") as HTMLInputElement).value =
      "fresh";
    (container.querySelector("[data-testid='channel-create-submit']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0].position).toBe(6);
    modal.destroy?.();
  });

  it("sends position one past the highest in a category chosen by id", async () => {
    setChannels([
      { id: 1, name: "a", type: "text", category: "Chat", category_id: 2, position: 3 },
      { id: 2, name: "b", type: "voice", category: "Chat", category_id: 2, position: 7 },
      { id: 3, name: "c", type: "text", category: "Other", category_id: 3, position: 40 },
    ]);
    const onCreate = vi.fn(async (_data: { position: number; category_id?: number }) => {});
    const { modal } = makeModal({ id: 2, name: "Chat" }, { onCreate });
    (container.querySelector("[data-testid='channel-name-input']") as HTMLInputElement).value =
      "fresh";
    (container.querySelector("[data-testid='channel-create-submit']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ category_id: 2, position: 8 });
    modal.destroy?.();
  });

  it("sorts the first channel of a brand-new category below every other channel", async () => {
    setChannels([{ id: 1, name: "a", type: "text", category: "Chat", position: 3 }]);
    const onCreate = vi.fn(
      async (_data: { position: number; category?: string; category_id?: number }) => {},
    );
    const { modal } = makeModal("Brand New", { onCreate });
    (container.querySelector("[data-testid='channel-name-input']") as HTMLInputElement).value =
      "fresh";
    (container.querySelector("[data-testid='channel-create-submit']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ position: 4 });
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
    const onCreate = vi.fn<NonNullable<CreateChannelModalOptions["onCreate"]>>(
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

  it("stays open when a drag-select ends on the backdrop", () => {
    const onClose = vi.fn();
    const { modal } = makeModal("Text Channels", { onClose });
    const overlayEl = container.querySelector(
      "[data-testid='create-channel-modal']",
    ) as HTMLElement;
    overlayEl.firstElementChild!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
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

  it("Escape that cancels an IME candidate keeps it open; a plain Escape still closes", () => {
    const onClose = vi.fn();
    const { modal } = makeModal("Text Channels", { onClose });

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
    );
    expect(onClose).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
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
