import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createEditChannelModal,
  clampVoiceLimit,
  formatSlowMode,
  MAX_SLOW_MODE_SECONDS,
  MAX_VOICE_LIMIT,
} from "@components/EditChannelModal";
import type { EditChannelModalOptions, EditChannelData } from "@components/EditChannelModal";
import { setChannels } from "@stores/channels.store";

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
      channelTopic: overrides?.channelTopic,
      channelCategory: overrides?.channelCategory,
      channelSlowMode: overrides?.channelSlowMode,
      channelNsfw: overrides?.channelNsfw,
      channelVoiceMaxUsers: overrides?.channelVoiceMaxUsers,
      channelVoiceMaxVideo: overrides?.channelVoiceMaxVideo,
      onSave: overrides?.onSave ?? vi.fn(async () => {}),
      onClose: overrides?.onClose ?? vi.fn(),
      ...(overrides?.channelType !== undefined ? { channelType: overrides.channelType } : {}),
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
    const input = container.querySelector(
      "[data-testid='edit-channel-name-input']",
    ) as HTMLInputElement;
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
    const input = container.querySelector(
      "[data-testid='edit-channel-name-input']",
    ) as HTMLInputElement;
    input.value = "";

    const saveBtn = container.querySelector(
      "[data-testid='edit-channel-submit']",
    ) as HTMLButtonElement;
    saveBtn.click();

    const error = container.querySelector("[data-testid='edit-channel-error']");
    expect(error?.textContent).toContain("required");
    expect(onSave).not.toHaveBeenCalled();
    modal.destroy?.();
  });

  it("calls onSave with updated name", async () => {
    const onSave = vi.fn(async () => {});
    const { modal } = makeModal({ onSave });
    const input = container.querySelector(
      "[data-testid='edit-channel-name-input']",
    ) as HTMLInputElement;
    input.value = "renamed-channel";

    const saveBtn = container.querySelector(
      "[data-testid='edit-channel-submit']",
    ) as HTMLButtonElement;
    saveBtn.click();

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        name: "renamed-channel",
        topic: "",
        category: "",
        slow_mode: 0,
        nsfw: false,
      });
    });
    modal.destroy?.();
  });

  it("pre-fills the topic input and includes the edited topic in onSave", async () => {
    const onSave = vi.fn(async () => {});
    const { modal } = makeModal({ onSave, channelTopic: "old topic" });
    const topicInput = container.querySelector(
      "[data-testid='edit-channel-topic-input']",
    ) as HTMLInputElement;
    expect(topicInput.value).toBe("old topic");
    topicInput.value = "  new topic  ";

    const saveBtn = container.querySelector(
      "[data-testid='edit-channel-submit']",
    ) as HTMLButtonElement;
    saveBtn.click();

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        name: "general",
        topic: "new topic",
        category: "",
        slow_mode: 0,
        nsfw: false,
      });
    });
    modal.destroy?.();
  });

  it("pre-fills the category input and includes the edited category in onSave", async () => {
    const onSave = vi.fn(async () => {});
    const { modal } = makeModal({ onSave, channelCategory: "Chat" });
    const categoryInput = container.querySelector(
      "[data-testid='edit-channel-category-input']",
    ) as HTMLInputElement;
    expect(categoryInput.value).toBe("Chat");
    categoryInput.value = "  Gaming  ";

    (container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        name: "general",
        topic: "",
        category: "Gaming",
        slow_mode: 0,
        nsfw: false,
      });
    });
    modal.destroy?.();
  });

  it("suggests the categories already in use via a datalist", () => {
    setChannels([
      { id: 1, name: "general", type: "text", category: "Chat", position: 0 },
      { id: 2, name: "lounge", type: "voice", category: "Gaming", position: 1 },
    ]);
    const { modal } = makeModal({ channelCategory: "Chat" });
    const values = Array.from(
      container.querySelector("#edit-channel-categories")?.querySelectorAll("option") ?? [],
    ).map((o) => o.getAttribute("value"));
    expect(values).toEqual(["Chat", "Gaming"]);
    modal.destroy?.();
  });

  // Blanking the category is how a channel becomes uncategorized — an empty
  // string must reach onSave rather than being dropped as "unchanged".
  it("submits an emptied category", async () => {
    const onSave = vi.fn(async () => {});
    const { modal } = makeModal({ onSave, channelCategory: "Chat" });
    (
      container.querySelector("[data-testid='edit-channel-category-input']") as HTMLInputElement
    ).value = "";

    (container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        name: "general",
        topic: "",
        category: "",
        slow_mode: 0,
        nsfw: false,
      });
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

    const input = container.querySelector(
      "[data-testid='edit-channel-name-input']",
    ) as HTMLInputElement;
    input.value = "new-name";

    const saveBtn = container.querySelector(
      "[data-testid='edit-channel-submit']",
    ) as HTMLButtonElement;
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

    const input = container.querySelector(
      "[data-testid='edit-channel-name-input']",
    ) as HTMLInputElement;
    input.value = "new-name";

    const saveBtn = container.querySelector(
      "[data-testid='edit-channel-submit']",
    ) as HTMLButtonElement;
    saveBtn.click();

    await vi.waitFor(() => {
      const error = container.querySelector("[data-testid='edit-channel-error']");
      expect(error?.textContent).toBe("Failed to update channel");
    });

    modal.destroy?.();
  });

  it("disables save button and shows 'Saving...' during save", async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn<any>(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { modal } = makeModal({ onSave });

    const input = container.querySelector(
      "[data-testid='edit-channel-name-input']",
    ) as HTMLInputElement;
    input.value = "renamed";

    const saveBtn = container.querySelector(
      "[data-testid='edit-channel-submit']",
    ) as HTMLButtonElement;
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

    const input = container.querySelector(
      "[data-testid='edit-channel-name-input']",
    ) as HTMLInputElement;
    input.value = "   "; // whitespace only

    const saveBtn = container.querySelector(
      "[data-testid='edit-channel-submit']",
    ) as HTMLButtonElement;
    saveBtn.click();

    expect(input.classList.contains("error")).toBe(true);
    modal.destroy?.();
  });
  // ─── Slow mode ─────────────────────────────────────────────────────────────

  describe("slow mode", () => {
    function slowSelect(): HTMLSelectElement {
      return container.querySelector(
        "[data-testid='edit-channel-slowmode-select']",
      ) as HTMLSelectElement;
    }

    it("offers friendly presets from Off to the server's 6-hour ceiling", () => {
      const { modal } = makeModal();
      const options = Array.from(slowSelect().options);
      expect(options[0]?.textContent).toBe("Off");
      expect(options[0]?.value).toBe("0");
      expect(options.at(-1)?.value).toBe(String(MAX_SLOW_MODE_SECONDS));
      // Nothing may exceed what the server accepts, or saving 400s.
      for (const opt of options) {
        expect(Number(opt.value)).toBeLessThanOrEqual(MAX_SLOW_MODE_SECONDS);
        expect(Number(opt.value)).toBeGreaterThanOrEqual(0);
      }
      modal.destroy?.();
    });

    it("pre-selects the channel's stored cooldown", () => {
      const { modal } = makeModal({ channelSlowMode: 300 });
      expect(slowSelect().value).toBe("300");
      modal.destroy?.();
    });

    it("keeps an off-preset stored value as its own selected option", () => {
      // The admin panel offers a free number field, so a channel can legally
      // carry a value the presets do not name. Rounding it to a neighbour
      // would change the channel just by opening the modal.
      const { modal } = makeModal({ channelSlowMode: 47 });
      expect(slowSelect().value).toBe("47");
      expect(Array.from(slowSelect().options).some((o) => o.value === "47")).toBe(true);
      modal.destroy?.();
    });

    it("sends the selected cooldown to onSave", async () => {
      const onSave = vi.fn(async () => {});
      const { modal } = makeModal({ onSave, channelSlowMode: 0 });
      slowSelect().value = "600";

      (container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ slow_mode: 600 }));
      });
      modal.destroy?.();
    });

    it("clamps a stored value above the ceiling onto a legal option", () => {
      const { modal } = makeModal({ channelSlowMode: 99999 });
      expect(Number(slowSelect().value)).toBe(MAX_SLOW_MODE_SECONDS);
      modal.destroy?.();
    });
  });

  // ─── NSFW flag ─────────────────────────────────────────────────────────────

  describe("NSFW flag", () => {
    function nsfwBox(): HTMLInputElement {
      return container.querySelector(
        "[data-testid='edit-channel-nsfw-checkbox']",
      ) as HTMLInputElement;
    }

    it("is unchecked for an unflagged channel", () => {
      const { modal } = makeModal();
      expect(nsfwBox().checked).toBe(false);
      modal.destroy?.();
    });

    it("pre-fills from the channel's stored flag", () => {
      const { modal } = makeModal({ channelNsfw: true });
      expect(nsfwBox().checked).toBe(true);
      modal.destroy?.();
    });

    it("sends the flag to onSave when set", async () => {
      const onSave = vi.fn(async () => {});
      const { modal } = makeModal({ onSave });
      nsfwBox().checked = true;

      (container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ nsfw: true }));
      });
      modal.destroy?.();
    });

    // Clearing the flag must be as expressible as setting it: the PATCH keeps
    // any field the body omits, so `false` has to be sent explicitly.
    it("sends false when a flagged channel is unflagged", async () => {
      const onSave = vi.fn(async () => {});
      const { modal } = makeModal({ onSave, channelNsfw: true });
      nsfwBox().checked = false;

      (container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ nsfw: false }));
      });
      modal.destroy?.();
    });
  });

  // ─── Voice limits ──────────────────────────────────────────────────────────

  describe("voice limits", () => {
    it("are absent for a text channel", () => {
      const { modal } = makeModal();
      expect(container.querySelector("[data-testid='edit-channel-voice-section']")).toBeNull();
      expect(container.querySelector("[data-testid='edit-channel-max-users-input']")).toBeNull();
      modal.destroy?.();
    });

    it("are shown for a voice channel", () => {
      const { modal } = makeModal({ channelType: "voice" });
      expect(container.querySelector("[data-testid='edit-channel-voice-section']")).not.toBeNull();
      modal.destroy?.();
    });

    it("pre-fill from the channel's stored limits", () => {
      const { modal } = makeModal({
        channelType: "voice",
        channelVoiceMaxUsers: 8,
        channelVoiceMaxVideo: 3,
      });
      expect(
        (
          container.querySelector(
            "[data-testid='edit-channel-max-users-input']",
          ) as HTMLInputElement
        ).value,
      ).toBe("8");
      expect(
        (
          container.querySelector(
            "[data-testid='edit-channel-max-video-input']",
          ) as HTMLInputElement
        ).value,
      ).toBe("3");
      modal.destroy?.();
    });

    it("round-trip through onSave", async () => {
      const onSave = vi.fn(async () => {});
      const { modal } = makeModal({
        onSave,
        channelType: "voice",
        channelVoiceMaxUsers: 0,
        channelVoiceMaxVideo: 0,
      });
      (
        container.querySelector("[data-testid='edit-channel-max-users-input']") as HTMLInputElement
      ).value = "12";
      (
        container.querySelector("[data-testid='edit-channel-max-video-input']") as HTMLInputElement
      ).value = "4";

      (container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({ voice_max_users: 12, voice_max_video: 4 }),
        );
      });
      modal.destroy?.();
    });

    // A text channel's PATCH must not carry the keys at all — sending 0 would
    // wipe limits the row happens to hold, since the server keeps only what the
    // body omits.
    it("are omitted from a text channel's payload rather than sent as 0", async () => {
      let payload: Record<string, unknown> | null = null;
      const onSave = vi.fn(async (data: EditChannelData) => {
        payload = data as unknown as Record<string, unknown>;
      });
      const { modal } = makeModal({ onSave });

      (container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(payload).not.toBeNull();
      });
      expect("voice_max_users" in payload!).toBe(false);
      expect("voice_max_video" in payload!).toBe(false);
      modal.destroy?.();
    });

    // The max attribute is advisory — paste and keyboard both get past it — so
    // the value is clamped before it reaches the API, which would 400.
    it("clamp a typed value above the server's ceiling", async () => {
      const onSave = vi.fn(async () => {});
      const { modal } = makeModal({ onSave, channelType: "voice" });
      (
        container.querySelector("[data-testid='edit-channel-max-users-input']") as HTMLInputElement
      ).value = "5000";

      (container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({ voice_max_users: MAX_VOICE_LIMIT }),
        );
      });
      modal.destroy?.();
    });

    it("treat an emptied field as unlimited rather than NaN", async () => {
      const onSave = vi.fn(async () => {});
      const { modal } = makeModal({ onSave, channelType: "voice", channelVoiceMaxUsers: 5 });
      (
        container.querySelector("[data-testid='edit-channel-max-users-input']") as HTMLInputElement
      ).value = "";

      (container.querySelector("[data-testid='edit-channel-submit']") as HTMLButtonElement).click();

      await vi.waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ voice_max_users: 0 }));
      });
      modal.destroy?.();
    });
  });

  // ─── Dialog accessibility contract (DC-13) ─────────────────────────────────

  describe("dialog accessibility", () => {
    it("stamps dialog semantics named by the header title", () => {
      const { modal } = makeModal();
      const dialog = container.querySelector(".modal") as HTMLElement;
      expect(dialog.getAttribute("role")).toBe("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-labelledby")).toBe("edit-channel-title");
      expect(container.querySelector("#edit-channel-title")?.textContent).toBe("Edit Channel");
      modal.destroy?.();
    });

    it("labels the icon-only close button", () => {
      const { modal } = makeModal();
      const closeBtn = container.querySelector(".modal-close") as HTMLButtonElement;
      expect(closeBtn.getAttribute("aria-label")).toBe("Close");
      modal.destroy?.();
    });

    it("Escape calls onClose without saving", () => {
      const onSave = vi.fn(async () => {});
      const onClose = vi.fn();
      const { modal } = makeModal({ onSave, onClose });

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
      modal.destroy?.();
    });

    it("ignores Escape after destroy", () => {
      const onClose = vi.fn();
      const { modal } = makeModal({ onClose });
      modal.destroy?.();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(onClose).not.toHaveBeenCalled();
    });

    it("focuses the name input on open and restores focus on destroy", () => {
      const trigger = document.createElement("button");
      container.appendChild(trigger);
      trigger.focus();

      const { modal } = makeModal();
      const input = container.querySelector(
        "[data-testid='edit-channel-name-input']",
      ) as HTMLInputElement;
      expect(document.activeElement).toBe(input);

      modal.destroy?.();
      expect(document.activeElement).toBe(trigger);
    });
  });

  // ─── Pure helpers ──────────────────────────────────────────────────────────

  describe("clampVoiceLimit", () => {
    it("keeps a legal value", () => {
      expect(clampVoiceLimit(7)).toBe(7);
    });
    it("floors negatives to 0", () => {
      expect(clampVoiceLimit(-3)).toBe(0);
    });
    it("caps at the server's ceiling", () => {
      expect(clampVoiceLimit(1000)).toBe(MAX_VOICE_LIMIT);
    });
    it("treats NaN as unlimited", () => {
      expect(clampVoiceLimit(Number.NaN)).toBe(0);
    });
    it("truncates a fractional value", () => {
      expect(clampVoiceLimit(4.9)).toBe(4);
    });
  });

  describe("formatSlowMode", () => {
    it("names a preset", () => {
      expect(formatSlowMode(0)).toBe("Off");
      expect(formatSlowMode(3600)).toBe("1 hour");
    });
    it("describes an off-preset whole-minute value", () => {
      expect(formatSlowMode(180)).toBe("3 minutes");
    });
    it("falls back to seconds", () => {
      expect(formatSlowMode(47)).toBe("47 seconds");
    });
  });
});
