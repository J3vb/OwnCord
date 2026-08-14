import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createQuickSwitcher } from "@components/QuickSwitcher";
import type { QuickSwitcherOptions } from "@components/QuickSwitcher";
import { channelsStore, setChannels } from "@stores/channels.store";
import { addDmToChannelsStore } from "../../src/pages/main-page/SidebarDmHelpers";
import type { DmChannel } from "@stores/dm.store";
import type { ReadyChannel } from "../../src/lib/types";

function resetStore(): void {
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
  }));
}

const testChannels: ReadyChannel[] = [
  { id: 1, name: "general", type: "text", category: "Text", position: 0, unread_count: 0 },
  { id: 2, name: "random", type: "text", category: "Text", position: 1, unread_count: 0 },
  { id: 3, name: "voice-lobby", type: "voice", category: "Voice", position: 2 },
  { id: 4, name: "announcements", type: "text", category: null, position: 3, unread_count: 0 },
];

describe("QuickSwitcher", () => {
  let container: HTMLDivElement;
  let switcher: ReturnType<typeof createQuickSwitcher>;
  let onSelectChannel: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetStore();
    setChannels(testChannels);
    container = document.createElement("div");
    document.body.appendChild(container);
    onSelectChannel = vi.fn();
    onClose = vi.fn();
    switcher = createQuickSwitcher({ onSelectChannel, onClose });
  });

  afterEach(() => {
    switcher.destroy?.();
    container.remove();
  });

  it("mounts with quick-switcher-overlay class", () => {
    switcher.mount(container);
    const overlay = container.querySelector(".quick-switcher-overlay");
    expect(overlay).not.toBeNull();
  });

  it("renders search input with placeholder", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe("Where do you want to go?");
  });

  it("renders all channels initially", () => {
    switcher.mount(container);
    const items = container.querySelectorAll(".quick-switcher__item");
    expect(items.length).toBe(4);
  });

  it("first item is active by default", () => {
    switcher.mount(container);
    const activeItem = container.querySelector(".quick-switcher__item--active");
    expect(activeItem).not.toBeNull();
  });

  it("filters channels by search query", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;

    input.value = "gen";
    input.dispatchEvent(new Event("input"));

    const items = container.querySelectorAll(".quick-switcher__item");
    expect(items.length).toBe(1);
    const name = items[0]!.querySelector(".quick-switcher__name");
    expect(name?.textContent).toBe("general");
  });

  it("filters channels without calling external search (client-side only)", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;

    input.value = "random";
    input.dispatchEvent(new Event("input"));

    // Filtering should work client-side
    const items = container.querySelectorAll(".quick-switcher__item");
    expect(items.length).toBe(1);
    expect(items[0]!.querySelector(".quick-switcher__name")?.textContent).toBe("random");
  });

  it("clicking a channel calls onSelectChannel and onClose", () => {
    switcher.mount(container);
    const firstItem = container.querySelector(".quick-switcher__item") as HTMLDivElement;
    firstItem.click();

    expect(onSelectChannel).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape key calls onClose", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ArrowDown moves active index", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    const items = container.querySelectorAll(".quick-switcher__item");
    expect(items[1]!.classList.contains("quick-switcher__item--active")).toBe(true);
    expect(items[0]!.classList.contains("quick-switcher__item--active")).toBe(false);
  });

  it("ArrowUp wraps around to last item", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    const items = container.querySelectorAll(".quick-switcher__item");
    expect(items[3]!.classList.contains("quick-switcher__item--active")).toBe(true);
  });

  it("Enter selects the active channel", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onSelectChannel).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows voice icon for voice channels", () => {
    switcher.mount(container);

    // text channels should have an SVG hash icon
    const hashIcons = container.querySelectorAll('svg[data-icon="hash"]');
    expect(hashIcons.length).toBeGreaterThan(0);

    // voice-lobby should have an SVG volume icon instead of an emoji
    const voiceIcons = container.querySelectorAll('svg[data-icon="volume-2"]');
    expect(voiceIcons.length).toBeGreaterThan(0);
  });

  it("shows category when present", () => {
    switcher.mount(container);
    const categories = container.querySelectorAll(".quick-switcher__category");
    const categoryTexts = Array.from(categories).map((c) => c.textContent);

    expect(categoryTexts).toContain("Text");
    expect(categoryTexts).toContain("Voice");
  });

  it("clicking backdrop calls onClose", () => {
    switcher.mount(container);
    const overlay = container.querySelector(".quick-switcher-overlay") as HTMLDivElement;
    // Simulate clicking on the overlay itself (not a child)
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("destroy removes DOM", () => {
    switcher.mount(container);
    expect(container.querySelector(".quick-switcher-overlay")).not.toBeNull();
    switcher.destroy?.();
    expect(container.querySelector(".quick-switcher-overlay")).toBeNull();
  });

  it("ArrowDown wraps around to first item from last", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;

    // Navigate to last item (4 channels, so press ArrowDown 3 times to reach last)
    for (let i = 0; i < 3; i++) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    }

    const items = container.querySelectorAll(".quick-switcher__item");
    expect(items[3]!.classList.contains("quick-switcher__item--active")).toBe(true);

    // One more ArrowDown should wrap to first
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    const itemsAfter = container.querySelectorAll(".quick-switcher__item");
    expect(itemsAfter[0]!.classList.contains("quick-switcher__item--active")).toBe(true);
  });

  it("Ctrl+K closes the switcher when it is open", () => {
    switcher.mount(container);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Ctrl+K closes the switcher with CapsLock on (KeyboardEvent.key reports uppercase 'K')", () => {
    // OC-0150: the global close handler compares `e.key === "k"`
    // case-sensitively, so CapsLock (or Ctrl+Shift+K) leaves the switcher
    // stuck open.
    switcher.mount(container);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "K", ctrlKey: true, bubbles: true }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("AltGr+K (ctrlKey+altKey) does not close the switcher", () => {
    // OC-0150: Windows/WebView2 reports AltGr as ctrlKey+altKey, so without
    // an altKey exclusion an AltGr-produced 'k' character both fails to
    // reach the composer and closes the switcher underneath it.
    switcher.mount(container);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, bubbles: true }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Enter is a no-op when search returns no results", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;

    // Search for something that won't match
    input.value = "zzzznotachannel";
    input.dispatchEvent(new Event("input"));

    const items = container.querySelectorAll(".quick-switcher__item");
    expect(items.length).toBe(0);

    // Press Enter — should not crash or call onSelectChannel
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSelectChannel).not.toHaveBeenCalled();
  });

  it("updates results when channel store changes", () => {
    switcher.mount(container);

    // Initially 4 channels
    expect(container.querySelectorAll(".quick-switcher__item").length).toBe(4);

    // Add a new channel to the store
    setChannels([
      ...testChannels,
      { id: 5, name: "new-channel", type: "text", category: "Text", position: 4, unread_count: 0 },
    ]);
    channelsStore.flush();

    // Results should update
    expect(container.querySelectorAll(".quick-switcher__item").length).toBe(5);
  });

  it("ArrowUp/ArrowDown are no-ops when results are empty", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;

    // Filter to no results
    input.value = "zzzznotachannel";
    input.dispatchEvent(new Event("input"));

    // Should not throw
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(container.querySelectorAll(".quick-switcher__item").length).toBe(0);
  });

  it("does not list DM rows synthesized into channelsStore (they belong to the DM sidebar section)", () => {
    const dm: DmChannel = {
      channelId: 99,
      recipient: { id: 1, username: "bob", avatar: "", status: "online" },
      participants: [{ id: 1, username: "bob", avatar: "", status: "online" }],
      name: "",
      isGroup: false,
      lastMessageId: null,
      lastMessage: "",
      lastMessageAt: "",
      unreadCount: 0,
      mentionCount: 0,
    };
    addDmToChannelsStore(dm);

    switcher.mount(container);

    // Still just the 4 text/voice channels — the synthesized DM row is not
    // duplicated here, and selecting it here would bypass clearDmUnread.
    const items = container.querySelectorAll(".quick-switcher__item");
    expect(items.length).toBe(4);
    const names = Array.from(items).map(
      (el) => el.querySelector(".quick-switcher__name")?.textContent,
    );
    expect(names).not.toContain("bob");
  });

  it("does not show category for channels without one", () => {
    switcher.mount(container);

    // Channel 4 (announcements) has category: null
    const items = container.querySelectorAll(".quick-switcher__item");
    const lastItem = items[3]!;
    expect(lastItem.querySelector(".quick-switcher__name")?.textContent).toBe("announcements");
    expect(lastItem.querySelector(".quick-switcher__category")).toBeNull();
  });

  it("applies dialog semantics to the quick switcher modal", () => {
    switcher.mount(container);
    const modal = container.querySelector(".quick-switcher") as HTMLDivElement;
    expect(modal.getAttribute("role")).toBe("dialog");
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(modal.getAttribute("aria-label")).toBe("Quick switcher");
  });

  it("wires the input as a combobox controlling the results listbox", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-controls")).toBe("quick-switcher-results");

    const results = container.querySelector("#quick-switcher-results");
    expect(results).not.toBeNull();
    expect(results!.getAttribute("role")).toBe("listbox");
    expect(results!.classList.contains("quick-switcher__results")).toBe(true);
  });

  it("marks result rows as options with aria-selected on the active row", () => {
    switcher.mount(container);
    const items = container.querySelectorAll(".quick-switcher__item");
    items.forEach((item, i) => {
      expect(item.getAttribute("role")).toBe("option");
      expect(item.id).toBe(`qs-option-${i}`);
      expect(item.getAttribute("aria-selected")).toBe(i === 0 ? "true" : "false");
    });
  });

  it("aria-activedescendant follows arrow-key navigation", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;

    expect(input.getAttribute("aria-activedescendant")).toBe("qs-option-0");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(input.getAttribute("aria-activedescendant")).toBe("qs-option-1");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(input.getAttribute("aria-activedescendant")).toBe("qs-option-0");
  });

  it("clears aria-activedescendant when no results match", () => {
    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;

    input.value = "zzzznotachannel";
    input.dispatchEvent(new Event("input"));

    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("moves focus into the dialog on mount and restores it on destroy", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    switcher.mount(container);
    const input = container.querySelector(".quick-switcher__input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    switcher.destroy?.();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
