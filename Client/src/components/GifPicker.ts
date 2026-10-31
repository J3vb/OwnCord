// GifPicker — searchable GIF selector, served by the user's own OwnCord server
// (which proxies Klipy). Uses @lib/dom helpers exclusively. Never sets
// innerHTML with user content.

import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { createElement, setText, clearChildren } from "@lib/dom";
import { enableRovingNavigation, setRovingTabindex } from "@lib/ui/a11y";
import { ApiClientError } from "@lib/api";
import { searchGifs, getTrendingGifs } from "@lib/media/gifProvider";
import type { GifApi, GifFavoritesApi, GifPage, GifResult } from "@lib/media/gifProvider";
import { createGifPager } from "@lib/media/gifPager";
import { gifFavoritesStore, isGifFavorite, toggleGifFavorite } from "@stores/gifFavorites.store";
import {
  fetchExternalImage,
  recoverEvictedImage,
  renderFailureStatus,
} from "../features/messaging/content/attachments";
import {
  admitDerived,
  externalAllowed,
  GIF_PICKER_ITEM,
  requestExternalItem,
} from "../features/content-consent/external";
import { externalConsentText } from "../i18n/externalConsent";
import { contentText } from "../i18n/content";
import { messagingText } from "../i18n/messaging";
import { gifFavoritesText } from "../i18n/gifFavorites";
import { RestErrorCode } from "@lib/protocolTypes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GifPickerOptions {
  /** GIF endpoints on the user's own server. */
  readonly api: GifApi & GifFavoritesApi;
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
/** Start the next page this far before the sentinel scrolls into view. */
const LOAD_MORE_MARGIN = "0px 0px 160px 0px";

// ---------------------------------------------------------------------------
// GifPicker
// ---------------------------------------------------------------------------

function setStarState(star: HTMLElement, on: boolean): void {
  star.setAttribute("aria-pressed", String(on));
  star.setAttribute("aria-label", gifFavoritesText(on ? "unfavorite" : "favorite"));
  star.classList.toggle("on", on);
  star.textContent = on ? "\u2605" : "\u2606";
}

/** Star/unstar the GIF a grid cell shows. */
async function toggleCell(cell: HTMLElement): Promise<void> {
  const url = cell.dataset.fullUrl;
  if (url === undefined) return;
  await toggleGifFavorite({
    url,
    preview_url: cell.dataset.previewUrl ?? url,
    title: cell.dataset.title ?? "",
  });
}

function appendCells(grid: HTMLElement, gifs: readonly GifResult[]): void {
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
      "data-preview-url": gif.url,
      "data-title": gif.title,
      "aria-keyshortcuts": "F",
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
    const star = createElement("button", {
      type: "button",
      class: "gp-star",
      tabindex: "-1",
    });
    setStarState(star, isGifFavorite(gif.fullUrl));
    item.appendChild(star);

    grid.appendChild(item);
  }
}

export function createGifPicker(options: GifPickerOptions): {
  readonly element: HTMLDivElement;
  destroy(): void;
} {
  const disposable = new Disposable();
  const signal = disposable.signal;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let currentRequestId = 0;
  // Load-more-on-scroll (browse tab only). `activeQuery` is the query whose
  // first page the grid shows; the pager's generation token drops a page that
  // resolves after the query changed.
  const pager = createGifPager();
  let activeQuery = "";
  const sentinel = createElement("div", { class: "gp-sentinel", "aria-hidden": "true" });

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

  // Search/trending vs the user's saved GIFs.
  let showingFavorites = false;
  const tabBrowse = createElement("button", {
    type: "button",
    class: "gp-tab active",
    role: "tab",
    "aria-selected": "true",
  });
  setText(tabBrowse, gifFavoritesText("tabBrowse"));
  const tabFavorites = createElement("button", {
    type: "button",
    class: "gp-tab",
    role: "tab",
    "aria-selected": "false",
  });
  setText(tabFavorites, gifFavoritesText("tabFavorites"));
  const tabs = createElement("div", {
    class: "gp-tabs",
    role: "tablist",
    "aria-label": gifFavoritesText("tabsLabel"),
  });
  tabs.append(tabBrowse, tabFavorites);
  header.appendChild(tabs);

  root.appendChild(header);

  // Grid area (scrollable). Announced as a flat listbox of GIF options with
  // roving tabindex; the inner .gp-grid is layout only.
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
      if (target.closest(".gp-star") !== null) {
        void toggleCell(cell);
        return;
      }
      const fullUrl = cell.dataset.fullUrl;
      if (fullUrl === undefined) return;
      options.onSelect(fullUrl);
      options.onClose();
    },
    { signal },
  );

  gridArea.addEventListener(
    "keydown",
    (e) => {
      if (e.key.toLowerCase() !== "f" || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      const cell = e.target instanceof Element ? e.target.closest<HTMLElement>(".gp-item") : null;
      if (cell === null || gifFavoritesStore.getState().unsupported) return;
      e.preventDefault();
      void toggleCell(cell);
    },
    { signal },
  );

  function syncStars(): void {
    for (const star of gridArea.querySelectorAll<HTMLButtonElement>(".gp-star")) {
      const url = star.closest<HTMLElement>(".gp-item")?.dataset.fullUrl;
      if (url !== undefined) setStarState(star, isGifFavorite(url));
    }
  }

  function renderFavorites(): void {
    const favs = gifFavoritesStore.getState().favorites;
    if (favs.length === 0) {
      clearChildren(gridArea);
      const empty = createElement("div", { class: "gp-empty", role: "status" });
      setText(empty, gifFavoritesText("favoritesEmpty"));
      gridArea.appendChild(empty);
      return;
    }
    renderGifs(
      favs.map((f) => ({ id: f.url, title: f.title, url: f.preview_url, fullUrl: f.url })),
    );
  }

  function renderFavoritesKeepingFocus(): void {
    const active = document.activeElement;
    const cell = active instanceof Element ? active.closest<HTMLElement>(".gp-item") : null;
    if (cell === null || !gridArea.contains(cell)) {
      renderFavorites();
      return;
    }
    const cells = [...gridArea.querySelectorAll<HTMLElement>(".gp-item")];
    const index = cells.indexOf(cell);
    renderFavorites();
    const next = gridArea.querySelectorAll<HTMLElement>(".gp-item");
    (next[Math.min(index, next.length - 1)] ?? tabFavorites).focus();
  }

  function selectTab(favorites: boolean): void {
    if (showingFavorites === favorites) return;
    showingFavorites = favorites;
    for (const [tab, on] of [
      [tabBrowse, !favorites],
      [tabFavorites, favorites],
    ] as const) {
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", String(on));
    }
    searchInput.hidden = favorites;
    ++currentRequestId; // drop any in-flight search render
    stopPaging();
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (favorites) renderFavorites();
    else void loadGifs(searchInput.value.trim());
  }

  tabBrowse.addEventListener("click", () => selectTab(false), { signal });
  tabFavorites.addEventListener("click", () => selectTab(true), { signal });
  // Keep stars (and the Favorites list) in step with the shared store.
  const syncSupport = (): void => {
    const unsupported = gifFavoritesStore.getState().unsupported;
    if (unsupported && showingFavorites) selectTab(false);
    // The tabs are about to be hidden: do not drop a focused tab to <body>.
    if (unsupported && tabs.contains(document.activeElement)) searchInput.focus();
    root.classList.toggle("gp-no-favorites", unsupported);
  };
  syncSupport();
  const unsubscribe = gifFavoritesStore.subscribe(() => {
    syncSupport();
    if (showingFavorites) renderFavoritesKeepingFocus();
    else syncStars();
  });
  signal.addEventListener("abort", unsubscribe, { once: true });

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
    appendCells(grid, gifs);
    gridArea.appendChild(grid);

    // Each render replaces the cell set, so re-establish the single Tab stop.
    setRovingTabindex(gridArea, ".gp-item");
  }

  // ── Load more on scroll ──

  const sentinelObserver =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) void loadMoreGifs();
          },
          { root: gridArea, rootMargin: LOAD_MORE_MARGIN },
        );
  signal.addEventListener("abort", () => sentinelObserver?.disconnect(), { once: true });

  function stopPaging(): void {
    pager.reset();
    sentinelObserver?.unobserve(sentinel);
    sentinel.remove();
  }

  /** (Re)observe the sentinel: observe() reports the current state at once, so
   *  a page that still leaves the sentinel in view asks for the next one. */
  function observeSentinel(): void {
    if (sentinelObserver === null) return;
    sentinelObserver.unobserve(sentinel);
    if (showingFavorites || !pager.hasMore()) {
      sentinel.remove();
      return;
    }
    if (!sentinel.isConnected) gridArea.appendChild(sentinel);
    sentinelObserver.observe(sentinel);
  }

  async function loadMoreGifs(): Promise<void> {
    if (showingFavorites) return;
    const query = activeQuery;
    const generation = pager.generation();
    const fresh = await pager.loadMore((pos): Promise<GifPage> =>
      query.length > 0
        ? searchGifs(options.api, query, GIF_LIMIT, pos)
        : getTrendingGifs(options.api, GIF_LIMIT, pos),
    );
    // A newer query, the favorites tab or destroy() owns the grid now.
    if (signal.aborted || showingFavorites || generation !== pager.generation()) return;
    const grid = gridArea.querySelector<HTMLElement>(".gp-grid");
    if (fresh !== null && grid !== null && fresh.length > 0) {
      const hadTabStop = grid.querySelector(".gp-item[tabindex='0']") !== null;
      appendCells(grid, fresh);
      // Only the new cells: the user's current Tab stop stays where it is.
      const added = [...grid.querySelectorAll<HTMLElement>(".gp-item")].slice(-fresh.length);
      added.forEach((cell, i) =>
        cell.setAttribute("tabindex", !hadTabStop && i === 0 ? "0" : "-1"),
      );
    }
    if (grid !== null && grid.querySelector(".gp-item") === null) {
      if (pager.failed()) {
        // Nothing to scroll, so a scroll can never retry: offer the button.
        showLoadError(contentText("gif.failed"), () => {
          searchInput.focus();
          void loadGifs(searchInput.value.trim());
        });
        return;
      }
      if (!pager.hasMore()) renderGifs([]);
    }
    // After a failure stay quiet; the next scroll (below) retries.
    if (!pager.failed()) observeSentinel();
  }

  // A failed page is retried by scrolling again, not by a timer or a banner.
  gridArea.addEventListener(
    "scroll",
    () => {
      if (pager.failed() && pager.hasMore()) observeSentinel();
    },
    { signal, passive: true },
  );

  function showLoading(): void {
    clearChildren(gridArea);
    gridArea.appendChild(loadingEl);
  }

  // The picker is one external item. Until the viewer consents, not
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
          if (showingFavorites) {
            tabFavorites.focus();
            renderFavorites();
          } else {
            searchInput.focus();
            void loadGifs(searchInput.value.trim());
          }
        });
      },
      { signal },
    );
    root.insertBefore(consentBtn, gridArea);
  }

  async function loadGifs(query: string): Promise<void> {
    if (showingFavorites) return;
    if (!externalAllowed(GIF_PICKER_ITEM)) {
      showConsent();
      return;
    }
    const requestId = ++currentRequestId;
    stopPaging();
    showLoading();

    try {
      const page =
        query.length > 0
          ? await searchGifs(options.api, query, GIF_LIMIT)
          : await getTrendingGifs(options.api, GIF_LIMIT);

      // Only render if this is still the latest request
      if (requestId === currentRequestId) {
        activeQuery = query;
        const first = pager.begin(page);
        if (first.length === 0 && pager.hasMore()) {
          // An empty page that still has a cursor: keep an empty grid so the
          // next page has somewhere to land.
          clearChildren(gridArea);
          gridArea.appendChild(createElement("div", { class: "gp-grid" }));
        } else {
          renderGifs(first);
        }
        observeSentinel();
      }
    } catch (err) {
      // The server has no GIF key configured — degrade calmly and tell the
      // caller so it can disable its GIF button, rather than looking broken.
      const disabled = err instanceof ApiClientError && err.code === RestErrorCode.GIF_DISABLED;
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
          // bounded retry; it never turns into the empty-results state.
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
      if (e.key === "Escape" && !isImeCommit(e)) {
        e.preventDefault();
        options.onClose();
      }
    },
    { signal },
  );

  // Focus search on mount
  // On a phone the keyboard would cover half the sheet before anyone asked to search.
  requestAnimationFrame(() => {
    if (!isPhoneLayout()) searchInput.focus();
  });

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
