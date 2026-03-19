// GifPicker — searchable GIF selector powered by Tenor API.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";
import { searchGifs, getTrendingGifs } from "@lib/tenor";
import type { TenorGif } from "@lib/tenor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GifPickerOptions {
  readonly onSelect: (gifUrl: string) => void;
  readonly onClose: () => void;
}

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
    placeholder: "Search Tenor",
  });
  header.appendChild(searchInput);

  // Attribution
  const attribution = createElement("div", { class: "gp-attribution" });
  setText(attribution, "Powered by Tenor");
  header.appendChild(attribution);

  root.appendChild(header);

  // Grid area (scrollable)
  const gridArea = createElement("div", { class: "gp-grid-area" });
  root.appendChild(gridArea);

  // Loading indicator
  const loadingEl = createElement("div", { class: "gp-loading" });
  setText(loadingEl, "Loading...");

  // Empty state
  const emptyEl = createElement("div", { class: "gp-empty" });
  setText(emptyEl, "No GIFs found");

  // ── Rendering ──

  function renderGifs(gifs: readonly TenorGif[]): void {
    clearChildren(gridArea);

    if (gifs.length === 0) {
      gridArea.appendChild(emptyEl);
      return;
    }

    const grid = createElement("div", { class: "gp-grid" });

    for (const gif of gifs) {
      const item = createElement("div", { class: "gp-item" });
      const img = createElement("img", {
        class: "gp-img",
        src: gif.url,
        alt: gif.title || "GIF",
        loading: "lazy",
      });
      item.appendChild(img);

      item.addEventListener("click", () => {
        options.onSelect(gif.fullUrl);
        options.onClose();
      }, { signal });

      grid.appendChild(item);
    }

    gridArea.appendChild(grid);
  }

  function showLoading(): void {
    clearChildren(gridArea);
    gridArea.appendChild(loadingEl);
  }

  async function loadGifs(query: string): Promise<void> {
    const requestId = ++currentRequestId;
    showLoading();

    try {
      const gifs = query.length > 0
        ? await searchGifs(query, GIF_LIMIT)
        : await getTrendingGifs(GIF_LIMIT);

      // Only render if this is still the latest request
      if (requestId === currentRequestId) {
        renderGifs(gifs);
      }
    } catch (err) {
      if (requestId === currentRequestId) {
        clearChildren(gridArea);
        const errEl = createElement("div", { class: "gp-empty" });
        const msg = err instanceof Error ? err.message : "Failed to load GIFs";
        setText(errEl, msg);
        gridArea.appendChild(errEl);
      }
    }
  }

  // ── Event handlers ──

  searchInput.addEventListener("input", () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void loadGifs(searchInput.value.trim());
    }, DEBOUNCE_MS);
  }, { signal });

  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      options.onClose();
    }
  }, { signal });

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
