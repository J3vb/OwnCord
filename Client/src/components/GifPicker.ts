// GifPicker — searchable GIF selector, served by the user's own OwnCord server
// (which proxies Klipy). Uses @lib/dom helpers exclusively. Never sets
// innerHTML with user content.

import { Disposable } from "@lib/disposable";
import { createElement, setText, clearChildren } from "@lib/dom";
import { enableRovingNavigation, setRovingTabindex } from "@lib/a11y";
import { ApiClientError } from "@lib/api";
import { searchGifs, getTrendingGifs } from "@lib/gifProvider";
import type { GifApi, GifResult } from "@lib/gifProvider";
import {
  fetchExternalImage,
  recoverEvictedImage,
  renderFailureStatus,
} from "@components/message-list/attachments";
import {
  admitDerived,
  externalAllowed,
  GIF_PICKER_ITEM,
  requestExternalItem,
} from "../features/content-consent/external";
import { externalConsentText } from "../i18n/externalConsent";
import { contentText } from "../i18n/content";
import { messagingText } from "../i18n/messaging";

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
  const disposable = new Disposable();
  const signal = disposable.signal;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let currentRequestId = 0;

  // ── DOM structure ──
  const root = createElement("div", { class: "gif-picker open" });

  // Header with search
  const header = createElement("div", { class: "gp-header" });
  const searchInput = createElement("input", {
    class: "gp-search",
    type: "text",
    placeholder: messagingText("gif.searchPlaceholder"),
  });
  header.appendChild(searchInput);

  // Attribution
  const attribution = createElement("div", { class: "gp-attribution" });
  setText(attribution, messagingText("gif.attribution"));
  header.appendChild(attribution);

  root.appendChild(header);

  // Grid area (scrollable). Announced as a flat listbox of GIF options with
  // roving tabindex (DC-13); the inner .gp-grid is layout only.
  const gridArea = createElement("div", {
    class: "gp-grid-area",
    role: "listbox",
    "aria-label": messagingText("gif.listLabel"),
  });
  root.appendChild(gridArea);
  enableRovingNavigation(gridArea, ".gp-item", signal);

  // Single delegated listener for the whole grid, registered once at mount
  // time. renderGifs() discards and rebuilds every cell on each search (20
  // cells per render); a listener bound directly to each cell would register
  // (and, since it lives on the picker-lifetime `signal`, never release) one
  // abort algorithm per discarded cell for the rest of the picker's life —
  // the same pattern EmojiPicker's delegated click handler already fixes.
  gridArea.addEventListener(
    "click",
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const cell = target.closest<HTMLElement>(".gp-item");
      if (cell === null) return;
      const fullUrl = cell.dataset.fullUrl;
      if (fullUrl === undefined) return;
      options.onSelect(fullUrl);
      options.onClose();
    },
    { signal },
  );

  // Loading indicator
  const loadingEl = createElement("div", { class: "gp-loading", role: "status" });
  setText(loadingEl, messagingText("gif.loading"));

  // Empty state
  const emptyEl = createElement("div", { class: "gp-empty" });
  setText(emptyEl, messagingText("gif.empty"));

  /** Transient failure: the same calm line as before plus a bounded retry,
   *  which re-runs the last query under the picker's current consent. */
  function showLoadError(message: string, retry: () => void): void {
    clearChildren(gridArea);
    gridArea.appendChild(renderFailureStatus(message, contentText("gif.retry"), retry));
  }

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
        "aria-label": gif.title || messagingText("gif.itemLabel"),
        // Read by the delegated click handler on gridArea (see mount-time
        // listener above) instead of a per-cell listener.
        "data-full-url": gif.fullUrl,
      });
      // Klipy's CDN is still an external host: the thumbnail arrives through
      // the external-content broker, not as a URL the webview loads itself.
      const img = createElement("img", {
        class: "gp-img",
        alt: gif.title || messagingText("gif.itemLabel"),
        loading: "lazy",
      });
      admitDerived(GIF_PICKER_ITEM, `url:${gif.url}`);
      recoverEvictedImage(img, { url: gif.url });
      void fetchExternalImage({ url: gif.url }).then((src) => {
        if (src !== null) img.src = src;
      });
      item.appendChild(img);

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

  // B9-8: the picker is one external item. Until the viewer consents, not
  // even the query reaches the server's GIF proxy.
  let consentBtn: HTMLButtonElement | null = null;
  function showConsent(): void {
    if (consentBtn !== null) return;
    gridArea.hidden = true;
    consentBtn = createElement("button", { type: "button", class: "btn-ghost gp-consent" });
    setText(consentBtn, externalConsentText("gif.load"));
    consentBtn.addEventListener(
      "click",
      () => {
        void requestExternalItem(GIF_PICKER_ITEM).then((ok) => {
          if (!ok || signal.aborted) return;
          consentBtn?.remove();
          consentBtn = null;
          gridArea.hidden = false;
          searchInput.focus();
          void loadGifs(searchInput.value.trim());
        });
      },
      { signal },
    );
    root.insertBefore(consentBtn, gridArea);
  }

  async function loadGifs(query: string): Promise<void> {
    if (!externalAllowed(GIF_PICKER_ITEM)) {
      showConsent();
      return;
    }
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
        options.onUnavailable?.(messagingText("gif.disabled"));
      }
      if (requestId === currentRequestId) {
        if (disabled) {
          clearChildren(gridArea);
          const errEl = createElement("div", { class: "gp-empty", role: "status" });
          setText(errEl, messagingText("gif.disabled"));
          gridArea.appendChild(errEl);
        } else {
          // A transient provider/network failure keeps the query and offers a
          // bounded retry; it never turns into the empty-results state (B9-9).
          showLoadError(contentText("gif.failed"), () => {
            // The retry is replaced by the loading line, so keyboard focus
            // moves to the search field rather than falling to <body>.
            searchInput.focus();
            void loadGifs(searchInput.value.trim());
          });
        }
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
    disposable.destroy();
  }

  return { element: root, destroy };
}
