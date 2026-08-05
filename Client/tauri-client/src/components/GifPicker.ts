// GifPicker — searchable GIF selector, served by the user's own OwnCord server
// (which proxies Klipy). Uses @lib/dom helpers exclusively. Never sets
// innerHTML with user content.

import { createElement, setText, clearChildren } from "@lib/dom";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { ApiClientError } from "@lib/api";
import { searchGifs, getTrendingGifs } from "@lib/gifProvider";
import type { GifApi, GifResult } from "@lib/gifProvider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GifPickerOptions {
  /** GIF endpoints on the user's own server. */
  readonly api: GifApi;
  readonly onSelect: (gifUrl: string) => void;
  readonly onClose: () => void;
  /**
   * Called when the server reports GIFs are not configured (503 GIF_DISABLED).
   * The caller uses this to disable its GIF affordance so the user is not
   * offered a feature this server does not have.
   */
  readonly onUnavailable?: (reason: string) => void;
}

/** Shown in-picker and passed to onUnavailable when the server has no key. */
export const GIF_UNAVAILABLE_MESSAGE = "GIFs are not enabled on this server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 300;
const GIF_LIMIT = 20;

// ---------------------------------------------------------------------------
// GifPicker
// ---------------------------------------------------------------------------

export function createGifPicker(options: GifPickerOptions): {
  readonly element: HTMLDivElement;
  destroy(): void;
} {
  const abortController = new AbortController();
  const signal = abortController.signal;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let currentRequestId = 0;

  // ── DOM structure ──
  const root = createElement("div", { class: "gif-picker open" });

  // Header with search
  const header = createElement("div", { class: "gp-header" });
  const searchInput = createElement("input", {
    class: "gp-search",
    type: "text",
    placeholder: "Search Klipy",
  });
  header.appendChild(searchInput);

  // Attribution
  const attribution = createElement("div", { class: "gp-attribution" });
  setText(attribution, "Powered by Klipy");
  header.appendChild(attribution);

  root.appendChild(header);

  // Grid area (scrollable). Announced as a flat listbox of GIF options with
  // roving tabindex (DC-13); the inner .gp-grid is layout only.
  const gridArea = createElement("div", {
    class: "gp-grid-area",
    role: "listbox",
    "aria-label": "GIFs",
  });
  root.appendChild(gridArea);
  enableRovingNavigation(gridArea, ".gp-item", signal);

  // Loading indicator
  const loadingEl = createElement("div", { class: "gp-loading" });
  setText(loadingEl, "Loading...");

  // Empty state
  const emptyEl = createElement("div", { class: "gp-empty" });
  setText(emptyEl, "No GIFs found");

  // ── Rendering ──

  function renderGifs(gifs: readonly GifResult[]): void {
    clearChildren(gridArea);

    if (gifs.length === 0) {
      gridArea.appendChild(emptyEl);
      return;
    }

    const grid = createElement("div", { class: "gp-grid" });

    for (const gif of gifs) {
      const item = createElement("div", {
        class: "gp-item",
        role: "option",
        // Same fallback as the img alt below — an untitled GIF still needs a
        // pronounceable accessible name.
        "aria-label": gif.title || "GIF",
      });
      const img = createElement("img", {
        class: "gp-img",
        src: gif.url,
        alt: gif.title || "GIF",
        loading: "lazy",
      });
      item.appendChild(img);

      item.addEventListener(
        "click",
        () => {
          options.onSelect(gif.fullUrl);
          options.onClose();
        },
        { signal },
      );

      grid.appendChild(item);
    }

    gridArea.appendChild(grid);

    // Each render replaces the cell set, so re-establish the single Tab stop.
    setRovingTabindex(gridArea, ".gp-item");
  }

  function showLoading(): void {
    clearChildren(gridArea);
    gridArea.appendChild(loadingEl);
  }

  async function loadGifs(query: string): Promise<void> {
    const requestId = ++currentRequestId;
    showLoading();

    try {
      const gifs =
        query.length > 0
          ? await searchGifs(options.api, query, GIF_LIMIT)
          : await getTrendingGifs(options.api, GIF_LIMIT);

      // Only render if this is still the latest request
      if (requestId === currentRequestId) {
        renderGifs(gifs);
      }
    } catch (err) {
      // The server has no GIF key configured — degrade calmly and tell the
      // caller so it can disable its GIF button, rather than looking broken.
      const disabled = err instanceof ApiClientError && err.code === "GIF_DISABLED";
      if (disabled) {
        root.classList.add("gp-unavailable");
        searchInput.disabled = true;
        options.onUnavailable?.(GIF_UNAVAILABLE_MESSAGE);
      }
      if (requestId === currentRequestId) {
        clearChildren(gridArea);
        const errEl = createElement("div", { class: "gp-empty" });
        const fallback = err instanceof Error ? err.message : "Failed to load GIFs";
        setText(errEl, disabled ? GIF_UNAVAILABLE_MESSAGE : fallback);
        gridArea.appendChild(errEl);
      }
    }
  }

  // ── Event handlers ──

  searchInput.addEventListener(
    "input",
    () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        void loadGifs(searchInput.value.trim());
      }, DEBOUNCE_MS);
    },
    { signal },
  );

  root.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        options.onClose();
      }
    },
    { signal },
  );

  // Focus search on mount
  requestAnimationFrame(() => searchInput.focus());

  // Load trending on init
  void loadGifs("");

  // ── Cleanup ──

  function destroy(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    abortController.abort();
  }

  return { element: root, destroy };
}
