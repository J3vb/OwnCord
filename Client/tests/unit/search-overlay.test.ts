import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSearchOverlay } from "../../src/components/SearchOverlay";
import type { SearchOverlayOptions } from "../../src/components/SearchOverlay";
import type { SearchResultItem, SearchResponse } from "../../src/lib/types";
import { setDmChannels } from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { membersStore, setMembers } from "../../src/stores/members.store";
import { resetBlocksStore, setBlockedByMe } from "../../src/stores/blocks.store";

function makeDmChannel(overrides: Partial<DmChannel> = {}): DmChannel {
  return {
    channelId: 42,
    recipient: { id: 2, username: "bob", avatar: "", status: "online" },
    participants: [{ id: 2, username: "bob", avatar: "", status: "online" }],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
  return {
    message_id: 1,
    channel_id: 42,
    channel_name: "general",
    user: { id: 1, username: "alice", avatar: null },
    content: "hello world",
    timestamp: "2026-01-15T12:00:00Z",
    ...overrides,
  };
}

function makeOptions(overrides: Partial<SearchOverlayOptions> = {}): SearchOverlayOptions {
  return {
    onSearch: vi.fn().mockResolvedValue({ results: [] }),
    onSelectResult: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSearchOverlay", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    setDmChannels([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
    setDmChannels([]);
    resetBlocksStore();
    localStorage.removeItem("owncord:settings:timeFormat");
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
  });

  it("mounts with overlay and input", () => {
    const opts = makeOptions();
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    expect(container.querySelector(".search-overlay")).not.toBeNull();
    expect(container.querySelector(".search-overlay-input")).not.toBeNull();
    expect(container.querySelector(".search-overlay-results")).not.toBeNull();

    overlay.destroy?.();
  });

  it("calls onSearch after debounce", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "test query";
    input.dispatchEvent(new Event("input"));

    // Should not fire immediately
    expect(onSearch).not.toHaveBeenCalled();

    // After debounce
    await vi.advanceTimersByTimeAsync(300);

    expect(onSearch).toHaveBeenCalledWith(
      "test query",
      undefined,
      expect.any(AbortSignal),
      undefined,
    );

    overlay.destroy?.();
  });

  it("does not call onSearch for empty query", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new Event("input"));

    await vi.advanceTimersByTimeAsync(300);

    expect(onSearch).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("does not call onSearch for single character", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "a";
    input.dispatchEvent(new Event("input"));

    await vi.advanceTimersByTimeAsync(300);

    expect(onSearch).not.toHaveBeenCalled();
    const status = container.querySelector(".search-overlay-status");
    expect(status!.textContent).toBe("Type at least 2 characters");

    overlay.destroy?.();
  });

  it("renders search results", async () => {
    const results = [
      makeResult({ message_id: 1, content: "first result" }),
      makeResult({ message_id: 2, content: "second result", channel_name: "random" }),
    ];
    const onSearch = vi.fn().mockResolvedValue({ results });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "result";
    input.dispatchEvent(new Event("input"));

    await vi.advanceTimersByTimeAsync(300);

    const items = container.querySelectorAll(".search-result-item");
    expect(items).toHaveLength(2);

    expect(items[0]!.querySelector(".search-result-channel")!.textContent).toBe("#general");
    expect(items[0]!.querySelector(".search-result-author")!.textContent).toBe("alice");
    expect(items[0]!.querySelector(".search-result-content")!.textContent).toBe("first result");

    expect(items[1]!.querySelector(".search-result-channel")!.textContent).toBe("#random");

    overlay.destroy?.();
  });

  it("renders a bare SQLite timestamp (no timezone) the same as its Z-suffixed equivalent", async () => {
    // The server's SearchMessages returns the raw "YYYY-MM-DD HH:MM:SS" column,
    // i.e. UTC with no zone designator. `new Date(ts)` would read that as
    // local wall-clock, disagreeing with the message list's parseTimestamp()
    // (which appends "Z") for any viewer not on UTC.
    const bareResult = makeResult({ message_id: 1, timestamp: "2026-01-15 12:00:00" });
    const zResult = makeResult({ message_id: 2, timestamp: "2026-01-15T12:00:00Z" });

    const onSearch = vi.fn().mockResolvedValue({ results: [bareResult, zResult] });
    const overlay = createSearchOverlay(makeOptions({ onSearch }));
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const times = container.querySelectorAll(".search-result-time");
    expect(times[0]!.textContent).toBe(times[1]!.textContent);

    overlay.destroy?.();
  });

  it("renders search result times on the 24-hour clock when the pref is 24h", async () => {
    localStorage.setItem("owncord:settings:timeFormat", JSON.stringify("24h"));
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
    const at = new Date(2020, 5, 15, 18, 34);
    const onSearch = vi
      .fn()
      .mockResolvedValue({ results: [makeResult({ timestamp: at.toISOString() })] });
    const overlay = createSearchOverlay(makeOptions({ onSearch }));
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const time = container.querySelector(".search-result-time")!.textContent!;
    expect(time).toContain("18:34");
    expect(time).not.toMatch(/AM|PM/i);

    overlay.destroy?.();
  });

  it("labels a DM result with the DM display name instead of a bare '#'", async () => {
    // A 1:1 DM channel row has channels.name === "" server-side, so a search
    // hit inside a DM comes back with channel_name: "". Rendering it as
    // `#${r.channel_name}` collapses to a bare "#" with no way to tell which
    // conversation it came from. The label should route through dmStore, the
    // same source every other DM-labelling surface (chat header, sidebar)
    // uses, and use the '@' sigil the chat header uses for DMs.
    setDmChannels([
      makeDmChannel({
        channelId: 42,
        recipient: { id: 2, username: "bob", avatar: "", status: "online" },
        participants: [{ id: 2, username: "bob", avatar: "", status: "online" }],
      }),
    ]);

    const results = [makeResult({ channel_id: 42, channel_name: "" })];
    const onSearch = vi.fn().mockResolvedValue({ results });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "dm search";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const channelLabel = container.querySelector(".search-result-channel")!;
    expect(channelLabel.textContent).toBe("@bob");
    expect(channelLabel.textContent).not.toBe("#");

    overlay.destroy?.();
  });

  it("shows the author's display name when the member list has one", async () => {
    membersStore.setState(() => ({
      members: new Map([
        [
          1,
          {
            id: 1,
            username: "alice_w",
            displayName: "Alice",
            avatar: null,
            role: "member" as const,
            status: "online" as const,
          },
        ],
      ]),
      typingUsers: new Map(),
    }));

    const results = [makeResult({ user: { id: 1, username: "alice_w", avatar: null } })];
    const onSearch = vi.fn().mockResolvedValue({ results });
    const overlay = createSearchOverlay(makeOptions({ onSearch }));
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    expect(container.querySelector(".search-result-author")!.textContent).toBe("Alice");
    expect(container.querySelector(".search-result-handle")!.textContent).toBe("@alice_w");

    overlay.destroy?.();
  });

  it("falls back to the username when no display name is set", async () => {
    setMembers([]);
    const results = [makeResult()];
    const onSearch = vi.fn().mockResolvedValue({ results });
    const overlay = createSearchOverlay(makeOptions({ onSearch }));
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    expect(container.querySelector(".search-result-author")!.textContent).toBe("alice");
    expect(container.querySelector(".search-result-handle")).toBeNull();

    overlay.destroy?.();
  });

  it("shows 'No results found' for empty results", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "no match";
    input.dispatchEvent(new Event("input"));

    await vi.advanceTimersByTimeAsync(300);

    const status = container.querySelector(".search-overlay-status");
    expect(status!.textContent).toBe("No results found");

    overlay.destroy?.();
  });

  it("shows 'Search failed' on error", async () => {
    const onSearch = vi.fn().mockRejectedValue(new Error("network error"));
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "fail";
    input.dispatchEvent(new Event("input"));

    await vi.advanceTimersByTimeAsync(300);

    const status = container.querySelector(".search-overlay-status");
    expect(status!.textContent).toBe("Search failed");

    overlay.destroy?.();
  });

  it("calls onClose on Escape", () => {
    const opts = makeOptions();
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(opts.onClose).toHaveBeenCalledOnce();

    overlay.destroy?.();
  });

  it("closes on Escape after clicking a result moves focus off the input", async () => {
    const result = makeResult({ message_id: 7 });
    const onSearch = vi.fn().mockResolvedValue({ results: [result] });
    const onSelectResult = vi.fn();
    const opts = makeOptions({ onSearch, onSelectResult });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "click";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    (container.querySelector("[data-testid='search-result-0']") as HTMLElement).click();
    // Picking a hit keeps the panel open and the row is a non-focusable div, so
    // the browser parks focus on the body — the input's keydown never fires.
    document.body.focus();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(onSelectResult).toHaveBeenCalledOnce();
    expect(opts.onClose).toHaveBeenCalledOnce();

    overlay.destroy?.();
  });

  it("closes on Escape from the scope radiogroup, not just the input", () => {
    const opts = makeOptions({ currentChannelId: 99 });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const channelChip = container.querySelector(
      "[data-testid='search-scope-channel']",
    ) as HTMLButtonElement;
    channelChip.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(opts.onClose).toHaveBeenCalledOnce();

    overlay.destroy?.();
  });

  it("wires the input as a combobox over the results listbox", async () => {
    const results = [makeResult({ message_id: 1 }), makeResult({ message_id: 2 })];
    const onSearch = vi.fn().mockResolvedValue({ results });
    const overlay = createSearchOverlay(makeOptions({ onSearch }));
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    const listbox = container.querySelector(".search-overlay-results") as HTMLElement;
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(listbox.getAttribute("role")).toBe("listbox");

    input.value = "test";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    // The active option is named while the input keeps DOM focus, so a screen
    // reader tracks the roving highlight the arrow keys move.
    expect(input.getAttribute("aria-activedescendant")).toBe("search-result-option-0");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(input.getAttribute("aria-activedescendant")).toBe("search-result-option-1");

    const active = container.querySelector("[data-testid='search-result-1']") as HTMLElement;
    expect(active.id).toBe("search-result-option-1");
    expect(active.getAttribute("aria-selected")).toBe("true");

    overlay.destroy?.();
  });

  it("announces its status through a polite live region", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const overlay = createSearchOverlay(makeOptions({ onSearch }));
    overlay.mount(container);

    const status = container.querySelector(".search-overlay-status") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "no match";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    expect(status.textContent).toBe("No results found");

    overlay.destroy?.();
  });

  it("calls onClose on backdrop click", () => {
    const opts = makeOptions();
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const overlayEl = container.querySelector(".search-overlay") as HTMLElement;
    overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(opts.onClose).toHaveBeenCalledOnce();

    overlay.destroy?.();
  });

  it("stays open when a drag-select ends on the backdrop", () => {
    const opts = makeOptions();
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);
    const overlayEl = container.querySelector(".search-overlay") as HTMLElement;
    overlayEl.firstElementChild!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opts.onClose).not.toHaveBeenCalled();
    overlay.destroy?.();
  });

  it("does not close when clicking inside the box", () => {
    const opts = makeOptions();
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const box = container.querySelector(".search-overlay-box") as HTMLElement;
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(opts.onClose).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  describe("keyboard navigation", () => {
    it("ArrowDown moves active index", async () => {
      const results = [makeResult({ message_id: 1 }), makeResult({ message_id: 2 })];
      const onSearch = vi.fn().mockResolvedValue({ results });
      const opts = makeOptions({ onSearch });
      const overlay = createSearchOverlay(opts);
      overlay.mount(container);

      const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
      input.value = "test";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(300);

      // First item should be active
      expect(
        container
          .querySelector("[data-testid='search-result-0']")!
          .classList.contains("search-result-item--active"),
      ).toBe(true);

      // Arrow down
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

      expect(
        container
          .querySelector("[data-testid='search-result-1']")!
          .classList.contains("search-result-item--active"),
      ).toBe(true);

      overlay.destroy?.();
    });

    it("Enter or Escape that an IME is composing with neither selects nor closes", async () => {
      const result = makeResult({ message_id: 5 });
      const onSearch = vi.fn().mockResolvedValue({ results: [result] });
      const onSelectResult = vi.fn();
      const opts = makeOptions({ onSearch, onSelectResult });
      const overlay = createSearchOverlay(opts);
      overlay.mount(container);

      const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
      input.value = "test";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(300);

      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true }),
      );
      expect(onSelectResult).not.toHaveBeenCalled();
      expect(opts.onClose).not.toHaveBeenCalled();

      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(onSelectResult).toHaveBeenCalledWith(result);

      overlay.destroy?.();
    });

    it("Enter selects active result and keeps the panel open", async () => {
      const result = makeResult({ message_id: 5 });
      const onSearch = vi.fn().mockResolvedValue({ results: [result] });
      const onSelectResult = vi.fn();
      const opts = makeOptions({ onSearch, onSelectResult });
      const overlay = createSearchOverlay(opts);
      overlay.mount(container);

      const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
      input.value = "test";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(300);

      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(onSelectResult).toHaveBeenCalledWith(result);
      // Picking a hit must not close the panel: the reader can walk through
      // several hits and Escape/backdrop is the only close.
      expect(opts.onClose).not.toHaveBeenCalled();

      overlay.destroy?.();
    });
  });

  it("clicking a result calls onSelectResult and keeps the panel open", async () => {
    const result = makeResult({ message_id: 7 });
    const onSearch = vi.fn().mockResolvedValue({ results: [result] });
    const onSelectResult = vi.fn();
    const opts = makeOptions({ onSearch, onSelectResult });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "click";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const item = container.querySelector("[data-testid='search-result-0']") as HTMLElement;
    item.click();

    expect(onSelectResult).toHaveBeenCalledWith(result);
    expect(opts.onClose).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("a blocked author's hit shows a placeholder with no highlight, and Enter still selects it", async () => {
    setBlockedByMe([1]);
    const result = makeResult({ message_id: 9, content: "secret hello" });
    const onSearch = vi.fn().mockResolvedValue({ results: [result] });
    const onSelectResult = vi.fn();
    const overlay = createSearchOverlay(makeOptions({ onSearch, onSelectResult }));
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const item = container.querySelector("[data-testid='search-result-0']") as HTMLElement;
    const body = item.querySelector(".search-result-content") as HTMLElement;
    expect(body.classList.contains("search-result-content--blocked")).toBe(true);
    expect(body.textContent).toBe("Blocked message");
    expect(item.querySelector("mark, .search-hit")).toBeNull();
    expect(item.textContent).not.toContain("secret");
    expect(item.querySelector(".search-result-author")!.textContent).toBe("alice");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSelectResult).toHaveBeenCalledWith(result);

    overlay.destroy?.();
  });

  it("does not attach a new click listener to each row on every re-render", async () => {
    // Per-row click listeners registered on the component-lifetime AbortSignal
    // never get cleaned up when a row is discarded by a re-render — only
    // destroy() aborts that signal. Re-renders triggered by ArrowDown/ArrowUp
    // (which don't create new rows via a fresh search) must not register any
    // additional listeners directly on ".search-result-item" elements; the
    // fix delegates a single listener onto the results container instead.
    const results = [
      makeResult({ message_id: 1 }),
      makeResult({ message_id: 2 }),
      makeResult({ message_id: 3 }),
    ];
    const onSearch = vi.fn().mockResolvedValue({ results });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "test";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    expect(container.querySelectorAll(".search-result-item")).toHaveLength(3);

    // Only start counting after the initial render so we isolate what the
    // subsequent re-renders (via arrow-key navigation) register. vi.spyOn's
    // mock.instances isn't reliably typed/populated for non-constructor
    // methods, so track `this` via a manual monkey-patch instead.
    const perRowClickRegistrations: Element[] = [];
    const originalAddEventListener = Element.prototype.addEventListener;
    Element.prototype.addEventListener = function (
      this: Element,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (type === "click" && this.classList.contains("search-result-item")) {
        perRowClickRegistrations.push(this);
      }
      originalAddEventListener.call(this, type, listener, options);
    };

    try {
      for (let i = 0; i < 5; i++) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      }
    } finally {
      Element.prototype.addEventListener = originalAddEventListener;
    }

    expect(perRowClickRegistrations).toHaveLength(0);

    overlay.destroy?.();
  });

  it("destroy removes overlay from DOM", () => {
    const opts = makeOptions();
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    expect(container.querySelector(".search-overlay")).not.toBeNull();

    overlay.destroy?.();

    expect(container.querySelector(".search-overlay")).toBeNull();
  });

  it("defaults to whole-server scope even when the overlay opened on a channel (D4)", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch, currentChannelId: 99 });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "scoped";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    expect(onSearch).toHaveBeenCalledWith("scoped", undefined, expect.any(AbortSignal), undefined);

    overlay.destroy?.();
  });

  it("narrowing to 'This channel' re-runs the search scoped to the current channel (D4)", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch, currentChannelId: 99 });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "scoped";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect(onSearch).toHaveBeenLastCalledWith(
      "scoped",
      undefined,
      expect.any(AbortSignal),
      undefined,
    );

    // The scope toggle is offered because the overlay opened on a channel.
    const channelChip = container.querySelector("[data-testid='search-scope-channel']")!;
    (channelChip as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(500);

    expect(onSearch).toHaveBeenLastCalledWith("scoped", 99, expect.any(AbortSignal), undefined);
    expect(channelChip.getAttribute("aria-checked")).toBe("true");

    overlay.destroy?.();
  });

  it("clears the previous scope's results and cursor on every scope change (D4)", async () => {
    const first = makeResult({ message_id: 30, channel_name: "general" });
    const channelRow = makeResult({
      message_id: 20,
      channel_name: "general",
      content: "in channel",
    });
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce({ results: [first], next_before: 30 })
      .mockResolvedValueOnce({ results: [channelRow], next_before: null });
    const opts = makeOptions({ onSearch, currentChannelId: 99 });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const loadMore = container.querySelector(
      "[data-testid='search-load-more']",
    ) as HTMLButtonElement;
    expect(container.querySelectorAll(".search-result-item")).toHaveLength(1);
    expect(loadMore.style.display).not.toBe("none");

    // Toggle scope inside the rate-limit window: the whole-server rows and
    // cursor must not survive, or Load more would page the whole-server cursor
    // with the channel-scoped request and mix scopes.
    (container.querySelector("[data-testid='search-scope-channel']") as HTMLButtonElement).click();
    expect(container.querySelectorAll(".search-result-item")).toHaveLength(0);
    expect(loadMore.style.display).toBe("none");

    // The rescheduled channel-scoped search still runs.
    await vi.advanceTimersByTimeAsync(500);
    expect(onSearch).toHaveBeenLastCalledWith("hello", 99, expect.any(AbortSignal), undefined);
    expect(container.querySelectorAll(".search-result-item")).toHaveLength(1);

    overlay.destroy?.();
  });

  it("aborts the in-flight search when the scope changes (D4)", async () => {
    let abortedSignal: AbortSignal | undefined;
    const onSearch = vi.fn().mockImplementation(
      (_q: string, _ch: number | undefined, signal: AbortSignal) =>
        new Promise<SearchResponse>(() => {
          abortedSignal = signal;
        }),
    );
    const opts = makeOptions({ onSearch, currentChannelId: 99 });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    const wholeServerSignal = abortedSignal;

    (container.querySelector("[data-testid='search-scope-channel']") as HTMLButtonElement).click();
    expect(wholeServerSignal!.aborted).toBe(true);

    overlay.destroy?.();
  });

  it("does not offer a scope toggle behind the NSFW gate", () => {
    const overlay = createSearchOverlay(makeOptions());
    overlay.mount(container);

    // No currentChannelId: whole-server only, nothing to narrow.
    expect(container.querySelector("[data-testid='search-scope']")).toBeNull();

    overlay.destroy?.();
  });

  it("choosing 'Whole server' from channel scope calls onSearch with channelId undefined (D4)", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch, currentChannelId: 99 });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "scoped";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    // Narrow, then widen back: the whole-server search drops channel_id.
    (container.querySelector("[data-testid='search-scope-channel']") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(500);
    (container.querySelector("[data-testid='search-scope-server']") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(500);

    expect(onSearch).toHaveBeenLastCalledWith(
      "scoped",
      undefined,
      expect.any(AbortSignal),
      undefined,
    );
    expect(
      container.querySelector("[data-testid='search-scope-server']")!.getAttribute("aria-checked"),
    ).toBe("true");

    overlay.destroy?.();
  });

  it("makes the scope control a single Tab stop reachable by keyboard (D4)", () => {
    const opts = makeOptions({ currentChannelId: 99 });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const channelChip = container.querySelector("[data-testid='search-scope-channel']")!;
    const serverChip = container.querySelector("[data-testid='search-scope-server']")!;
    // Exactly one radio holds the Tab stop; the roving navigation moves within.
    expect(serverChip.getAttribute("tabindex")).toBe("0");
    expect(channelChip.getAttribute("tabindex")).toBe("-1");

    overlay.destroy?.();
  });

  it("shows 'Load more' when a page returns a cursor and pages with it", async () => {
    const first = makeResult({ message_id: 30 });
    const second = makeResult({ message_id: 20 });
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce({ results: [first], next_before: 30 })
      .mockResolvedValueOnce({ results: [second], next_before: null });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "page";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const loadMore = container.querySelector(
      "[data-testid='search-load-more']",
    ) as HTMLButtonElement;
    expect(loadMore.style.display).not.toBe("none");

    // The second page asks for sort=recent's cursor (next_before from page one).
    loadMore.click();
    await vi.advanceTimersByTimeAsync(500);

    expect(onSearch).toHaveBeenLastCalledWith("page", undefined, expect.any(AbortSignal), 30);
    // Appended, not replaced: the reader keeps the first page.
    expect(container.querySelectorAll(".search-result-item")).toHaveLength(2);
    // No further cursor: the control hides again.
    expect(loadMore.style.display).toBe("none");

    overlay.destroy?.();
  });

  it("pages the query that produced the shown results, not an edited box", async () => {
    const first = makeResult({ message_id: 30 });
    const second = makeResult({ message_id: 20 });
    const onSearch = vi
      .fn()
      .mockResolvedValueOnce({ results: [first], next_before: 30 })
      .mockResolvedValueOnce({ results: [second], next_before: null });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const loadMore = container.querySelector(
      "[data-testid='search-load-more']",
    ) as HTMLButtonElement;
    expect(loadMore.style.display).not.toBe("none");

    // Edit the box but leave the 300 ms debounce pending: the "hello" rows and
    // their cursor are still what is on screen, so Load more must page "hello".
    input.value = "world";
    input.dispatchEvent(new Event("input"));
    loadMore.click();
    // Flush the paged request without advancing past the pending debounce.
    await vi.advanceTimersByTimeAsync(0);

    expect(onSearch).toHaveBeenLastCalledWith("hello", undefined, expect.any(AbortSignal), 30);
    expect(container.querySelectorAll(".search-result-item")).toHaveLength(2);

    overlay.destroy?.();
  });

  it("does not show 'Load more' when the first page has no cursor", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [makeResult()] });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "single";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const loadMore = container.querySelector(
      "[data-testid='search-load-more']",
    ) as HTMLButtonElement;
    expect(loadMore.style.display).toBe("none");

    overlay.destroy?.();
  });

  it("truncates long content in results", async () => {
    const longContent = "a".repeat(250);
    const result = makeResult({ content: longContent });
    const onSearch = vi.fn().mockResolvedValue({ results: [result] });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "long";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const content = container.querySelector(".search-result-content")!;
    // 200 chars + a single trailing ellipsis (3A-11c: "…" replaces "...").
    expect(content.textContent!.length).toBeLessThanOrEqual(201);
    expect(content.textContent!.endsWith("\u2026")).toBe(true);

    overlay.destroy?.();
  });

  describe("results presentation (3A-11c)", () => {
    async function run(
      results: SearchResultItem[],
      query: string,
      onSearch = vi.fn().mockResolvedValue({ results }),
    ) {
      const overlay = createSearchOverlay(makeOptions({ onSearch }));
      overlay.mount(container);
      const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
      input.value = query;
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(300);
      return { overlay, onSearch, input };
    }

    it("shows the year in a result date", async () => {
      const { overlay } = await run([makeResult({ timestamp: "2024-03-05T12:00:00Z" })], "hello");
      expect(container.querySelector(".search-result-time")!.textContent).toContain("2024");
      overlay.destroy?.();
    });

    it("strips markdown from the preview", async () => {
      const { overlay } = await run([makeResult({ content: "**bold** `code`" })], "zzz");
      expect(container.querySelector(".search-result-content")!.textContent).toBe("bold code");
      overlay.destroy?.();
    });

    it("highlights the term case-insensitively but not filter tokens", async () => {
      const { overlay } = await run(
        [makeResult({ content: "Hello from alice, HELLO again" })],
        "from:alice hello",
      );
      const marks = [...container.querySelectorAll("mark.search-hit")].map((m) => m.textContent);
      expect(marks).toEqual(["Hello", "HELLO"]);
      overlay.destroy?.();
    });

    it("does not highlight a quoted filter value or one-char terms", async () => {
      const { overlay } = await run(
        [makeResult({ content: "ann went to the park x" })],
        'from:"ann lee" park x',
      );
      const marks = [...container.querySelectorAll("mark.search-hit")].map((m) => m.textContent);
      expect(marks).toEqual(["park"]);
      overlay.destroy?.();
    });

    it("windows a long message around a match at char 500 with a leading ellipsis", async () => {
      const content = "a".repeat(500) + "needle" + "b".repeat(500);
      const { overlay } = await run([makeResult({ content })], "needle");
      const text = container.querySelector(".search-result-content")!.textContent!;
      expect(text.startsWith("\u2026")).toBe(true);
      expect(text).toContain("needle");
      expect(text.endsWith("\u2026")).toBe(true);
      expect(text.length).toBeLessThanOrEqual(202);
      expect(container.querySelector("mark.search-hit")!.textContent).toBe("needle");
      overlay.destroy?.();
    });

    it("does not throw on a hostile regex-like query", async () => {
      const { overlay } = await run([makeResult({ content: "ab.*( b" })], "ab.*(");
      expect(container.querySelector("mark.search-hit")!.textContent).toBe("ab");
      overlay.destroy?.();
    });

    it("marks the match exactly when earlier text changes length when lowercased", async () => {
      const { overlay } = await run(
        [makeResult({ content: "\u0130\u0130\u0130\u0130 hello" })],
        "hello",
      );
      const marks = [...container.querySelectorAll("mark.search-hit")].map((m) => m.textContent);
      expect(marks).toEqual(["hello"]);
      overlay.destroy?.();
    });

    it("does not split an emoji before the match", async () => {
      const { overlay } = await run([makeResult({ content: "\u{1F600}\u{1F600} hello" })], "hello");
      const text = container.querySelector(".search-result-content")!.textContent;
      expect(text).toBe("\u{1F600}\u{1F600} hello");
      expect(container.querySelector("mark.search-hit")!.textContent).toBe("hello");
      overlay.destroy?.();
    });

    it("splits a query on non-alphanumerics like the server does", async () => {
      const a = await run([makeResult({ content: "foo bar" })], "foo-bar");
      expect([...container.querySelectorAll("mark.search-hit")].map((m) => m.textContent)).toEqual([
        "foo",
        "bar",
      ]);
      a.overlay.destroy?.();
      container.innerHTML = "";
      const b = await run([makeResult({ content: "a foo b" })], "-foo");
      expect([...container.querySelectorAll("mark.search-hit")].map((m) => m.textContent)).toEqual([
        "foo",
      ]);
      b.overlay.destroy?.();
    });

    it("does not cut a surrogate pair at the window start or end", async () => {
      const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      // Start cut: the hit sits at 70, so the window starts at 10, inside the
      // emoji at 9-10.
      const startCut = "a".repeat(9) + "\u{1F600}" + "a".repeat(51) + "needle" + "b".repeat(300);
      const s1 = await run([makeResult({ content: startCut })], "needle");
      const t1 = container.querySelector(".search-result-content")!.textContent!;
      expect(t1).not.toMatch(lone);
      expect(t1).toContain("\u{1F600}");
      s1.overlay.destroy?.();
      container.innerHTML = "";
      // End cut: the 200-unit window ends inside the emoji at 199-200.
      const endCut = "needle" + "a".repeat(193) + "\u{1F600}" + "b".repeat(50);
      const s2 = await run([makeResult({ content: endCut })], "needle");
      const t2 = container.querySelector(".search-result-content")!.textContent!;
      expect(t2).not.toMatch(lone);
      s2.overlay.destroy?.();
    });

    it("uses a neutral Spoiler label in the preview", async () => {
      const { overlay } = await run([makeResult({ content: "||secret|| tail" })], "zzz");
      const text = container.querySelector(".search-result-content")!.textContent!;
      expect(text).toContain("Spoiler");
      expect(text).not.toContain("revealed");
      overlay.destroy?.();
    });

    it("never renders result content as HTML", async () => {
      const { overlay } = await run([makeResult({ content: "<img src=x onerror=1> hi" })], "hi");
      expect(container.querySelector(".search-result-content img")).toBeNull();
      overlay.destroy?.();
    });

    it("shows Retry on failure and re-runs the same search", async () => {
      const onSearch = vi
        .fn()
        .mockRejectedValueOnce(new Error("net"))
        .mockResolvedValue({ results: [makeResult()] });
      const { overlay } = await run([], "hello", onSearch);
      const retryBtn = container.querySelector("[data-testid='search-retry']") as HTMLButtonElement;
      expect(retryBtn.style.display).not.toBe("none");
      expect(retryBtn.textContent).toBe("Retry");
      retryBtn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(onSearch).toHaveBeenCalledTimes(2);
      expect(onSearch.mock.calls[1]![0]).toBe("hello");
      expect(container.querySelectorAll(".search-result-item").length).toBe(1);
      expect(retryBtn.style.display).toBe("none");
      overlay.destroy?.();
    });

    it("a retried Load more clears the failed status and appends rows", async () => {
      const onSearch = vi
        .fn()
        .mockResolvedValueOnce({ results: [makeResult({ message_id: 1 })], next_before: 1 })
        .mockRejectedValueOnce(new Error("net"))
        .mockResolvedValue({ results: [makeResult({ message_id: 2, content: "second" })] });
      const { overlay } = await run([], "hello", onSearch);
      const more = container.querySelector("[data-testid='search-load-more']") as HTMLButtonElement;
      more.click();
      await vi.advanceTimersByTimeAsync(0);
      const status = container.querySelector(".search-overlay-status")!;
      expect(status.textContent).toBe("Search failed");
      const retryBtn = container.querySelector("[data-testid='search-retry']") as HTMLButtonElement;
      retryBtn.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(status.textContent).not.toContain("failed");
      expect((status as HTMLElement).style.display).toBe("none");
      expect(container.querySelectorAll(".search-result-item").length).toBe(2);
      overlay.destroy?.();
    });

    it("moves focus to the search input after Retry", async () => {
      const onSearch = vi
        .fn()
        .mockRejectedValueOnce(new Error("net"))
        .mockResolvedValue({ results: [makeResult()] });
      const { overlay, input } = await run([], "hello", onSearch);
      const retryBtn = container.querySelector("[data-testid='search-retry']") as HTMLButtonElement;
      retryBtn.focus();
      expect(document.activeElement).toBe(retryBtn);
      retryBtn.click();
      expect(document.activeElement).toBe(input);
      overlay.destroy?.();
    });

    it("changing scope clears a failed search and hides Retry", async () => {
      const onSearch = vi
        .fn()
        .mockRejectedValueOnce(new Error("net"))
        .mockResolvedValue({ results: [] });
      const overlay = createSearchOverlay(makeOptions({ onSearch, currentChannelId: 42 }));
      overlay.mount(container);
      const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
      input.value = "h";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(300);
      input.value = "hello";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(600);
      const retryBtn = container.querySelector("[data-testid='search-retry']") as HTMLButtonElement;
      expect(retryBtn.style.display).not.toBe("none");
      input.value = "";
      (
        container.querySelector("[data-testid='search-scope-channel']") as HTMLButtonElement
      ).click();
      expect(retryBtn.style.display).toBe("none");
      expect(container.querySelector(".search-overlay-status")!.textContent).toBe("");
      overlay.destroy?.();
    });

    it("a stale earlier response does not overwrite a newer search", async () => {
      let resolveOld: (r: SearchResponse) => void = () => {};
      const onSearch = vi
        .fn()
        .mockRejectedValueOnce(new Error("net"))
        .mockImplementationOnce(
          () =>
            new Promise<SearchResponse>((res) => {
              resolveOld = res;
            }),
        )
        .mockResolvedValue({ results: [makeResult({ message_id: 9, content: "newer" })] });
      const { overlay } = await run([], "hello", onSearch);
      const retryBtn = container.querySelector("[data-testid='search-retry']") as HTMLButtonElement;
      retryBtn.click(); // second call: stays pending
      const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
      input.value = "hello2";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(600);
      resolveOld({ results: [makeResult({ message_id: 5, content: "older" })] });
      await vi.advanceTimersByTimeAsync(0);
      const text = container.querySelector(".search-result-content")!.textContent;
      expect(text).toBe("newer");
      overlay.destroy?.();
    });
  });

  describe("keyboard navigation — ArrowUp", () => {
    it("ArrowUp wraps around to last result from first", async () => {
      const results = [
        makeResult({ message_id: 1 }),
        makeResult({ message_id: 2 }),
        makeResult({ message_id: 3 }),
      ];
      const onSearch = vi.fn().mockResolvedValue({ results });
      const opts = makeOptions({ onSearch });
      const overlay = createSearchOverlay(opts);
      overlay.mount(container);

      const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
      input.value = "test";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(300);

      // First item is active
      expect(
        container
          .querySelector("[data-testid='search-result-0']")!
          .classList.contains("search-result-item--active"),
      ).toBe(true);

      // Arrow up should wrap to last
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      expect(
        container
          .querySelector("[data-testid='search-result-2']")!
          .classList.contains("search-result-item--active"),
      ).toBe(true);

      overlay.destroy?.();
    });

    it("ArrowDown wraps from last to first", async () => {
      const results = [makeResult({ message_id: 1 }), makeResult({ message_id: 2 })];
      const onSearch = vi.fn().mockResolvedValue({ results });
      const opts = makeOptions({ onSearch });
      const overlay = createSearchOverlay(opts);
      overlay.mount(container);

      const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
      input.value = "test";
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(300);

      // Move to last
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(
        container
          .querySelector("[data-testid='search-result-1']")!
          .classList.contains("search-result-item--active"),
      ).toBe(true);

      // One more should wrap to first
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(
        container
          .querySelector("[data-testid='search-result-0']")!
          .classList.contains("search-result-item--active"),
      ).toBe(true);

      overlay.destroy?.();
    });
  });

  it("aborts previous search when a new search starts", async () => {
    let abortedSignal: AbortSignal | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onSearch = vi
      .fn()
      .mockImplementation((_q: string, _ch: number | undefined, signal: AbortSignal) => {
        abortedSignal = signal;
        return new Promise(() => {}); // Never resolves — stalled search
      });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;

    // First search
    input.value = "first";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    const firstSignal = abortedSignal;

    // Second search — should abort the first
    // Advance past the MIN_SEARCH_INTERVAL_MS (500ms) rate limit before triggering debounce
    onSearch.mockImplementation(() => Promise.resolve({ results: [] }));
    await vi.advanceTimersByTimeAsync(200); // now 500ms since first search fired
    input.value = "second";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    expect(firstSignal!.aborted).toBe(true);
    expect(onSearch).toHaveBeenCalledTimes(2);

    overlay.destroy?.();
  });

  it("scrolls the active row into view on arrow navigation (#2)", async () => {
    // The results box is a max-height scroller, so the highlight must be kept
    // visible; jsdom has no layout, so assert the call.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const results = [
      makeResult({ message_id: 1 }),
      makeResult({ message_id: 2 }),
      makeResult({ message_id: 3 }),
    ];
    const onSearch = vi.fn().mockResolvedValue({ results });
    const overlay = createSearchOverlay(makeOptions({ onSearch }));
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "test";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    scrollIntoView.mockClear();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    const rows = container.querySelectorAll(".search-result-item");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(rows[1]);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    overlay.destroy?.();
  });

  it("aborts the in-flight search when the query falls below the minimum (F5)", async () => {
    // Clearing/shortening the query must not let the previous request's late
    // response repopulate the results under an empty box (OC-0467).
    let abortedSignal: AbortSignal | undefined;
    let resolveSearch: ((resp: SearchResponse) => void) | undefined;
    const onSearch = vi.fn().mockImplementation(
      (_q: string, _ch: number | undefined, signal: AbortSignal) =>
        new Promise<SearchResponse>((resolve) => {
          abortedSignal = signal;
          resolveSearch = resolve;
        }),
    );
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect(onSearch).toHaveBeenCalledTimes(1);

    // Clear the query before the stalled search lands.
    input.value = "";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    expect(abortedSignal!.aborted).toBe(true);

    // Even if the stale promise still resolves, no results are rendered.
    resolveSearch?.({ results: [makeResult({ message_id: 1, content: "stale" })] });
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll(".search-result-item")).toHaveLength(0);

    overlay.destroy?.();
  });

  it("shows 'Searching...' status during search", async () => {
    let resolveSearch: ((resp: SearchResponse) => void) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onSearch = vi.fn().mockImplementation(
      () =>
        new Promise<SearchResponse>((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "searching";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const status = container.querySelector(".search-overlay-status");
    expect(status!.textContent).toBe("Searching...");

    // Resolve the search
    resolveSearch?.({ results: [] });
    await vi.waitFor(() => {
      expect(status!.textContent).toBe("No results found");
    });

    overlay.destroy?.();
  });

  it("ignores AbortError from cancelled search without showing error", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const onSearch = vi.fn().mockRejectedValue(abortError);
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "aborted";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    const status = container.querySelector(".search-overlay-status");
    // Should NOT show "Search failed" for abort errors
    expect(status!.textContent).not.toBe("Search failed");

    overlay.destroy?.();
  });

  it("Enter is a no-op when there are no results", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const onSelectResult = vi.fn();
    const opts = makeOptions({ onSearch, onSelectResult });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "empty";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSelectResult).not.toHaveBeenCalled();
    expect(opts.onClose).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("ArrowUp/ArrowDown are no-ops when results are empty", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;
    input.value = "empty";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);

    // Should not throw
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(container.querySelectorAll(".search-result-item").length).toBe(0);

    overlay.destroy?.();
  });

  it("debounces rapid input changes", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;

    // Type multiple characters rapidly
    input.value = "ab";
    input.dispatchEvent(new Event("input"));
    input.value = "abc";
    input.dispatchEvent(new Event("input"));
    input.value = "abcd";
    input.dispatchEvent(new Event("input"));

    // Only one search should fire after debounce
    await vi.advanceTimersByTimeAsync(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("abcd", undefined, expect.any(AbortSignal), undefined);

    overlay.destroy?.();
  });

  it("reschedules a rate-limited search instead of dropping it", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch });
    const overlay = createSearchOverlay(opts);
    overlay.mount(container);

    const input = container.querySelector(".search-overlay-input") as HTMLInputElement;

    // First query fires after debounce, stamping the rate-limit clock.
    input.value = "he";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect(onSearch).toHaveBeenLastCalledWith("he", undefined, expect.any(AbortSignal), undefined);

    // The user keeps typing; the next debounced search lands only ~300ms after
    // the first, inside the 500ms rate-limit window. It must be rescheduled,
    // not silently dropped (which would leave the "he" results on screen).
    input.value = "hello";
    input.dispatchEvent(new Event("input"));
    // Debounce (300ms) then the remaining rate-limit window (~200ms) elapse.
    await vi.advanceTimersByTimeAsync(300 + 500);
    expect(onSearch).toHaveBeenLastCalledWith(
      "hello",
      undefined,
      expect.any(AbortSignal),
      undefined,
    );

    overlay.destroy?.();
  });
});
