/**
 * SearchOverlay — full-text message search overlay with debounced input,
 * result list rendering, and keyboard navigation.
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { SearchResultItem } from "@lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOverlayOptions {
  readonly onSearch: (
    query: string,
    channelId?: number,
    signal?: AbortSignal,
  ) => Promise<readonly SearchResultItem[]>;
  readonly onSelectResult: (result: SearchResultItem) => void;
  readonly onClose: () => void;
  readonly currentChannelId?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;
/** Minimum interval between actual search API calls (rate limiting). */
const MIN_SEARCH_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSearchOverlay(options: SearchOverlayOptions): MountableComponent {
  const ac = new AbortController();
  const signal = ac.signal;

  let root: HTMLDivElement | null = null;
  let resultsDiv: HTMLDivElement;
  let input: HTMLInputElement;
  let statusEl: HTMLDivElement;
  let activeIndex = 0;
  let results: readonly SearchResultItem[] = [];
  let debounceTimer: number | null = null;
  let searchAbort: AbortController | null = null;
  let lastSearchTime = 0;

  // eslint-disable-next-line consistent-function-scoping -- co-located with its sole caller for readability
  function formatTimestamp(ts: string): string {
    try {
      const d = new Date(ts);
      return (
        d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      );
    } catch {
      return ts;
    }
  }

  function renderResults(): void {
    clearChildren(resultsDiv);
    activeIndex = Math.min(activeIndex, Math.max(0, results.length - 1));

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const isActive = i === activeIndex;

      const item = createElement("div", {
        class: isActive ? "search-result-item search-result-item--active" : "search-result-item",
        role: "option",
        "aria-selected": isActive ? "true" : "false",
        "data-testid": `search-result-${i}`,
      });

      const header = createElement("div", { class: "search-result-header" });
      const channel = createElement("span", { class: "search-result-channel" });
      setText(channel, `#${r.channel_name}`);
      const author = createElement("span", { class: "search-result-author" });
      setText(author, r.user.username);
      const time = createElement("span", { class: "search-result-time" });
      setText(time, formatTimestamp(r.timestamp));
      appendChildren(header, channel, author, time);

      const content = createElement("div", { class: "search-result-content" });
      setText(content, r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content);

      appendChildren(item, header, content);

      item.addEventListener(
        "click",
        () => {
          options.onSelectResult(r);
          options.onClose();
        },
        { signal },
      );

      resultsDiv.appendChild(item);
    }
  }

  function setStatus(text: string): void {
    setText(statusEl, text);
    statusEl.style.display = text === "" ? "none" : "block";
  }

  function doSearch(): void {
    const now = Date.now();
    if (now - lastSearchTime < MIN_SEARCH_INTERVAL_MS) return;
    lastSearchTime = now;

    const query = input.value.trim();
    if (query.length < MIN_QUERY_LEN) {
      results = [];
      renderResults();
      setStatus(query.length > 0 ? `Type at least ${MIN_QUERY_LEN} characters` : "");
      return;
    }

    // Cancel any in-flight search
    if (searchAbort !== null) {
      searchAbort.abort();
    }
    searchAbort = new AbortController();

    setStatus("Searching...");

    options
      .onSearch(query, options.currentChannelId, searchAbort.signal)
      .then((items) => {
        results = items;
        activeIndex = 0;
        renderResults();
        setStatus(items.length === 0 ? "No results found" : "");
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setStatus("Search failed");
      });
  }

  function handleInput(): void {
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
    }
    debounceTimer = window.setTimeout(doSearch, DEBOUNCE_MS);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      options.onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length > 0) {
        activeIndex = (activeIndex + 1) % results.length;
        renderResults();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length > 0) {
        activeIndex = (activeIndex - 1 + results.length) % results.length;
        renderResults();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const selected = results[activeIndex];
      if (selected !== undefined) {
        options.onSelectResult(selected);
        options.onClose();
      }
    }
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === root) {
      options.onClose();
    }
  }

  function mount(container: Element): void {
    root = createElement("div", {
      class: "search-overlay open",
      "data-testid": "search-overlay",
    });

    const box = createElement("div", { class: "search-overlay-box" });

    input = createElement("input", {
      class: "search-overlay-input",
      type: "text",
      placeholder: "Search messages...",
      "aria-label": "Search messages",
      "data-testid": "search-overlay-input",
    });

    statusEl = createElement("div", {
      class: "search-overlay-status",
      style: "display:none",
    });

    resultsDiv = createElement("div", {
      class: "search-overlay-results",
      role: "listbox",
      "data-testid": "search-overlay-results",
    });

    appendChildren(box, input, statusEl, resultsDiv);
    root.appendChild(box);
    container.appendChild(root);

    input.addEventListener("input", handleInput, { signal });
    input.addEventListener("keydown", handleKeydown, { signal });
    root.addEventListener("click", handleBackdropClick, { signal });

    requestAnimationFrame(() => input.focus());
  }

  function destroy(): void {
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (searchAbort !== null) {
      searchAbort.abort();
      searchAbort = null;
    }
    ac.abort();
    root?.remove();
    root = null;
  }

  return { mount, destroy };
}
