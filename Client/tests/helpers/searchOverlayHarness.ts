import { afterEach, beforeEach, expect, vi } from "vitest";
import { createSearchOverlay } from "../../src/components/SearchOverlay";
import type { SearchOverlayOptions } from "../../src/components/SearchOverlay";
import type { SearchResultItem } from "../../src/lib/types";
import { setDmChannels } from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { resetBlocksStore } from "../../src/stores/blocks.store";

export function makeDmChannel(overrides: Partial<DmChannel> = {}): DmChannel {
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

export function makeResult(overrides: Partial<SearchResultItem> = {}): SearchResultItem {
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

export function makeOptions(overrides: Partial<SearchOverlayOptions> = {}): SearchOverlayOptions {
  return {
    onSearch: vi.fn().mockResolvedValue({ results: [] }),
    onSelectResult: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

/** Fake timers, a fresh container per test and the overlay-related store resets. */
export function useSearchOverlayEnv(bind: (container: HTMLDivElement) => void): void {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    setDmChannels([]);
    bind(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
    setDmChannels([]);
    resetBlocksStore();
    localStorage.removeItem("owncord:settings:timeFormat");
    window.dispatchEvent(new CustomEvent("owncord:pref-change", { detail: { key: "timeFormat" } }));
  });
}

export function mountOverlay(
  container: HTMLElement,
  opts: SearchOverlayOptions = makeOptions(),
): ReturnType<typeof createSearchOverlay> {
  const overlay = createSearchOverlay(opts);
  overlay.mount(container);
  return overlay;
}

export function searchInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector(".search-overlay-input") as HTMLInputElement;
}

/** Types into the box, then lets the debounce (or `ms`) elapse. */
export async function typeQuery(input: HTMLInputElement, value: string, ms = 300): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(ms);
}

export function pressKey(target: EventTarget, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

export function expectActiveRow(container: HTMLElement, index: number): void {
  expect(
    container
      .querySelector(`[data-testid='search-result-${index}']`)!
      .classList.contains("search-result-item--active"),
  ).toBe(true);
}

/** Mounts an overlay built from `overrides`, types `query` and waits out the debounce. */
export async function searchFor(
  container: HTMLElement,
  overrides: Partial<SearchOverlayOptions>,
  query: string,
  ms = 300,
): Promise<{
  opts: SearchOverlayOptions;
  overlay: ReturnType<typeof createSearchOverlay>;
  input: HTMLInputElement;
}> {
  const opts = makeOptions(overrides);
  const overlay = mountOverlay(container, opts);
  const input = searchInput(container);
  await typeQuery(input, query, ms);
  return { opts, overlay, input };
}

export function loadMoreButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector("[data-testid='search-load-more']") as HTMLButtonElement;
}

export function retryButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector("[data-testid='search-retry']") as HTMLButtonElement;
}

export function scopeChip(container: HTMLElement, scope: "channel" | "server"): HTMLButtonElement {
  return container.querySelector(`[data-testid='search-scope-${scope}']`) as HTMLButtonElement;
}

/** A search that answers page one (cursor 30) and then page two (no cursor). */
export function twoPageSearch(): SearchOverlayOptions["onSearch"] & ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockResolvedValueOnce({ results: [makeResult({ message_id: 30 })], next_before: 30 })
    .mockResolvedValueOnce({ results: [makeResult({ message_id: 20 })], next_before: null });
}

/** Like searchFor, with a search that answers `results`; extra options are merged in. */
export function searchResolving(
  container: HTMLElement,
  results: SearchResultItem[],
  query: string,
  extra: Partial<SearchOverlayOptions> = {},
): ReturnType<typeof searchFor> {
  const onSearch = vi.fn().mockResolvedValue({ results });
  return searchFor(container, { onSearch, ...extra }, query);
}
