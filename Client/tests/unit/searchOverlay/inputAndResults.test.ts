import { describe, it, expect, vi } from "vitest";
import { createSearchOverlay } from "../../../src/components/SearchOverlay";
import { setDmChannels } from "../../../src/stores/dm.store";
import { membersStore, setMembers } from "../../../src/stores/members.store";
import { setBlockedByMe } from "../../../src/stores/blocks.store";
import {
  makeResult,
  makeOptions,
  mountOverlay,
  searchInput,
  typeQuery,
  pressKey,
  expectActiveRow,
  useSearchOverlayEnv,
  makeDmChannel,
  searchFor,
} from "../../helpers/searchOverlayHarness";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSearchOverlay", () => {
  let container: HTMLDivElement;
  useSearchOverlayEnv((c) => (container = c));

  it("mounts with overlay and input", () => {
    const opts = makeOptions();
    const overlay = mountOverlay(container, opts);

    expect(container.querySelector(".search-overlay")).not.toBeNull();
    expect(container.querySelector(".search-overlay-input")).not.toBeNull();
    expect(container.querySelector(".search-overlay-results")).not.toBeNull();

    overlay.destroy?.();
  });

  it("calls onSearch after debounce", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch });
    const overlay = mountOverlay(container, opts);

    const input = searchInput(container);
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
    const { overlay } = await searchFor(container, { onSearch }, "   ");

    expect(onSearch).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("does not call onSearch for single character", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const { overlay } = await searchFor(container, { onSearch }, "a");

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
    const { overlay } = await searchFor(container, { onSearch }, "result");

    const items = container.querySelectorAll(".search-result-item");
    expect(items).toHaveLength(2);

    expect(items[0]!.querySelector(".search-result-channel")!.textContent).toBe("#general");
    expect(items[0]!.querySelector(".search-result-author")!.textContent).toBe("alice");
    expect(items[0]!.querySelector(".search-result-content")!.textContent).toBe("first result");

    expect(items[1]!.querySelector(".search-result-channel")!.textContent).toBe("#random");

    overlay.destroy?.();
  });

  it("shows an imported result's Discord name as text with the Imported tag and no handle", async () => {
    const name = "<img src=x onerror=alert(1)>";
    const results = [
      makeResult({
        user: { id: 77, username: "[imported]", avatar: null },
        imported_author: { name, color: "red; background:url(x)" },
      }),
    ];
    const overlay = createSearchOverlay(
      makeOptions({ onSearch: vi.fn().mockResolvedValue({ results }) }),
    );
    overlay.mount(container);

    const input = searchInput(container);
    await typeQuery(input, "result");

    const item = container.querySelector(".search-result-item")!;
    expect(item.querySelector(".search-result-author")!.textContent).toBe(name);
    expect(item.querySelector(".search-result-author img")).toBeNull();
    expect(item.querySelector(".imported-tag")!.textContent).toBe("Imported");
    expect(item.querySelector(".search-result-handle")).toBeNull();
    expect(item.textContent).not.toContain("[imported]");

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
    const overlay = mountOverlay(container, makeOptions({ onSearch }));

    const input = searchInput(container);
    await typeQuery(input, "hello");

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
    const overlay = mountOverlay(container, makeOptions({ onSearch }));

    const input = searchInput(container);
    await typeQuery(input, "hello");

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
    const { overlay } = await searchFor(container, { onSearch }, "dm search");

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
    const overlay = mountOverlay(container, makeOptions({ onSearch }));

    const input = searchInput(container);
    await typeQuery(input, "hello");

    expect(container.querySelector(".search-result-author")!.textContent).toBe("Alice");
    expect(container.querySelector(".search-result-handle")!.textContent).toBe("@alice_w");

    overlay.destroy?.();
  });

  it("falls back to the username when no display name is set", async () => {
    setMembers([]);
    const results = [makeResult()];
    const onSearch = vi.fn().mockResolvedValue({ results });
    const overlay = mountOverlay(container, makeOptions({ onSearch }));

    const input = searchInput(container);
    await typeQuery(input, "hello");

    expect(container.querySelector(".search-result-author")!.textContent).toBe("alice");
    expect(container.querySelector(".search-result-handle")).toBeNull();

    overlay.destroy?.();
  });

  it("shows 'No results found' for empty results", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const { overlay } = await searchFor(container, { onSearch }, "no match");

    const status = container.querySelector(".search-overlay-status");
    expect(status!.textContent).toBe("No results found");

    overlay.destroy?.();
  });

  it("shows 'Search failed' on error", async () => {
    const onSearch = vi.fn().mockRejectedValue(new Error("network error"));
    const { overlay } = await searchFor(container, { onSearch }, "fail");

    const status = container.querySelector(".search-overlay-status");
    expect(status!.textContent).toBe("Search failed");

    overlay.destroy?.();
  });

  it("calls onClose on Escape", () => {
    const opts = makeOptions();
    const overlay = mountOverlay(container, opts);

    const input = searchInput(container);
    pressKey(input, "Escape");

    expect(opts.onClose).toHaveBeenCalledOnce();

    overlay.destroy?.();
  });

  it("closes on Escape after clicking a result moves focus off the input", async () => {
    const result = makeResult({ message_id: 7 });
    const onSearch = vi.fn().mockResolvedValue({ results: [result] });
    const onSelectResult = vi.fn();
    const { opts, overlay } = await searchFor(container, { onSearch, onSelectResult }, "click");

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
    const overlay = mountOverlay(container, opts);

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
    const overlay = mountOverlay(container, makeOptions({ onSearch }));

    const input = searchInput(container);
    const listbox = container.querySelector(".search-overlay-results") as HTMLElement;
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(listbox.getAttribute("role")).toBe("listbox");

    await typeQuery(input, "test");

    // The active option is named while the input keeps DOM focus, so a screen
    // reader tracks the roving highlight the arrow keys move.
    expect(input.getAttribute("aria-activedescendant")).toBe("search-result-option-0");
    pressKey(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe("search-result-option-1");

    const active = container.querySelector("[data-testid='search-result-1']") as HTMLElement;
    expect(active.id).toBe("search-result-option-1");
    expect(active.getAttribute("aria-selected")).toBe("true");

    overlay.destroy?.();
  });

  it("announces its status through a polite live region", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const overlay = mountOverlay(container, makeOptions({ onSearch }));

    const status = container.querySelector(".search-overlay-status") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");

    const input = searchInput(container);
    await typeQuery(input, "no match");

    expect(status.textContent).toBe("No results found");

    overlay.destroy?.();
  });

  it("calls onClose on backdrop click", () => {
    const opts = makeOptions();
    const overlay = mountOverlay(container, opts);

    const overlayEl = container.querySelector(".search-overlay") as HTMLElement;
    overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(opts.onClose).toHaveBeenCalledOnce();

    overlay.destroy?.();
  });

  it("stays open when a drag-select ends on the backdrop", () => {
    const opts = makeOptions();
    const overlay = mountOverlay(container, opts);
    const overlayEl = container.querySelector(".search-overlay") as HTMLElement;
    overlayEl.firstElementChild!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlayEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(opts.onClose).not.toHaveBeenCalled();
    overlay.destroy?.();
  });

  it("does not close when clicking inside the box", () => {
    const opts = makeOptions();
    const overlay = mountOverlay(container, opts);

    const box = container.querySelector(".search-overlay-box") as HTMLElement;
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(opts.onClose).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  describe("keyboard navigation", () => {
    it("ArrowDown moves active index", async () => {
      const results = [makeResult({ message_id: 1 }), makeResult({ message_id: 2 })];
      const onSearch = vi.fn().mockResolvedValue({ results });
      const { overlay, input } = await searchFor(container, { onSearch }, "test");

      // First item should be active
      expectActiveRow(container, 0);

      // Arrow down
      pressKey(input, "ArrowDown");

      expectActiveRow(container, 1);

      overlay.destroy?.();
    });

    it("Enter or Escape that an IME is composing with neither selects nor closes", async () => {
      const result = makeResult({ message_id: 5 });
      const onSearch = vi.fn().mockResolvedValue({ results: [result] });
      const onSelectResult = vi.fn();
      const { opts, overlay, input } = await searchFor(
        container,
        { onSearch, onSelectResult },
        "test",
      );

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

      pressKey(input, "Enter");
      expect(onSelectResult).toHaveBeenCalledWith(result);

      overlay.destroy?.();
    });

    it("Enter selects active result and keeps the panel open", async () => {
      const result = makeResult({ message_id: 5 });
      const onSearch = vi.fn().mockResolvedValue({ results: [result] });
      const onSelectResult = vi.fn();
      const { opts, overlay, input } = await searchFor(
        container,
        { onSearch, onSelectResult },
        "test",
      );

      pressKey(input, "Enter");

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
    const { opts, overlay } = await searchFor(container, { onSearch, onSelectResult }, "click");

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
    const overlay = mountOverlay(container, makeOptions({ onSearch, onSelectResult }));

    const input = searchInput(container);
    await typeQuery(input, "hello");

    const item = container.querySelector("[data-testid='search-result-0']") as HTMLElement;
    const body = item.querySelector(".search-result-content") as HTMLElement;
    expect(body.classList.contains("search-result-content--blocked")).toBe(true);
    expect(body.textContent).toBe("Blocked message");
    expect(item.querySelector("mark, .search-hit")).toBeNull();
    expect(item.textContent).not.toContain("secret");
    expect(item.querySelector(".search-result-author")!.textContent).toBe("alice");

    pressKey(input, "Enter");
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
    const { overlay, input } = await searchFor(container, { onSearch }, "test");

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
        pressKey(input, "ArrowDown");
      }
    } finally {
      Element.prototype.addEventListener = originalAddEventListener;
    }

    expect(perRowClickRegistrations).toHaveLength(0);

    overlay.destroy?.();
  });

  it("destroy removes overlay from DOM", () => {
    const opts = makeOptions();
    const overlay = mountOverlay(container, opts);

    expect(container.querySelector(".search-overlay")).not.toBeNull();

    overlay.destroy?.();

    expect(container.querySelector(".search-overlay")).toBeNull();
  });
});
