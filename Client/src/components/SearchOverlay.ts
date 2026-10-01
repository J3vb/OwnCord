/**
 * SearchOverlay — full-text message search overlay with debounced input,
 * scope selection, cursor paging, result list rendering, and keyboard
 * navigation.
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import type { SearchResultItem, SearchResponse } from "@lib/types";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { channelsStore } from "@stores/channels.store";
import { parseTimestamp, resolveAuthor } from "@lib/formatting";
import { resolveDisplayName } from "@lib/avatar";
import { setRovingTabindex, enableRovingNavigation } from "@lib/a11y";
import { messagingText } from "../i18n/messaging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchOverlayOptions {
  /**
   * Run one search page. `before` pages a newest-first result set (the
   * previous page's next_before cursor); omit it for the first page.
   */
  readonly onSearch: (
    query: string,
    channelId?: number,
    signal?: AbortSignal,
    before?: number,
  ) => Promise<SearchResponse>;
  readonly onSelectResult: (result: SearchResultItem) => void;
  readonly onClose: () => void;
  /** The channel the overlay opened on; omitted behind the NSFW gate (B9-7). */
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

/** "in #general" / "in @bob", falling back to a generic label when unknown. */
// oxlint-disable-next-line consistent-function-scoping -- co-located with its sole caller for readability
function channelScopeLabel(channelId: number): string {
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  if (dm !== undefined) return messagingText("search.scope.inDm", { name: dmDisplayName(dm) });
  const channel = channelsStore.getState().channels.get(channelId);
  return channel !== undefined && channel.name !== ""
    ? messagingText("search.scope.inChannel", { channel: channel.name })
    : messagingText("search.scope.channel");
}

export function createSearchOverlay(options: SearchOverlayOptions): MountableComponent {
  const disposable = new Disposable();
  const signal = disposable.signal;

  let root: HTMLDivElement | null = null;
  let resultsDiv: HTMLDivElement;
  let input: HTMLInputElement;
  let statusEl: HTMLDivElement;
  let loadMoreBtn: HTMLButtonElement | null = null;
  let channelOption: HTMLButtonElement | null = null;
  let serverOption: HTMLButtonElement | null = null;
  let activeIndex = 0;
  let results: readonly SearchResultItem[] = [];
  // Whole server is the default scope (D4 option b: "Whole server by default
  // with an 'in #channel' chip"), matching Discord. The chip that narrows to
  // the current channel is only offered when the overlay opened on one, so the
  // NSFW gate (which opens it without a channel) can never be narrowed back in
  // (B9-7).
  let scopeServer = true;
  let nextBefore: number | null = null;
  let loadingMore = false;
  let debounceTimer: number | null = null;
  let searchAbort: AbortController | null = null;
  let lastSearchTime = 0;

  // oxlint-disable-next-line consistent-function-scoping -- co-located with its sole caller for readability
  function formatTimestamp(ts: string): string {
    try {
      const d = parseTimestamp(ts);
      return (
        d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      );
    } catch {
      return ts;
    }
  }

  /** The channel filter for the current scope: undefined = whole server. */
  function scopeChannelId(): number | undefined {
    return scopeServer ? undefined : options.currentChannelId;
  }

  function renderResults(): void {
    clearChildren(resultsDiv);
    activeIndex = Math.min(activeIndex, Math.max(0, results.length - 1));

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const isActive = i === activeIndex;

      const item = createElement("div", {
        class: isActive ? "search-result-item search-result-item--active" : "search-result-item",
        id: `search-result-option-${i}`,
        role: "option",
        "aria-selected": isActive ? "true" : "false",
        "data-testid": `search-result-${i}`,
      });

      const header = createElement("div", { class: "search-result-header" });
      const channel = createElement("span", { class: "search-result-channel" });
      const dm = dmStore.getState().channels.find((c) => c.channelId === r.channel_id);
      setText(channel, dm !== undefined ? `@${dmDisplayName(dm)}` : `#${r.channel_name}`);
      const who = resolveAuthor(r.user);
      const authorName = resolveDisplayName(who);
      const author = createElement("span", { class: "search-result-author" });
      setText(author, authorName);
      appendChildren(header, channel, author);
      if (authorName !== who.username) {
        const handle = createElement("span", { class: "search-result-handle" });
        setText(handle, messagingText("search.authorHandle", { username: who.username }));
        header.appendChild(handle);
      }
      const time = createElement("span", { class: "search-result-time" });
      setText(time, formatTimestamp(r.timestamp));
      header.appendChild(time);

      const content = createElement("div", { class: "search-result-content" });
      setText(content, r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content);

      appendChildren(item, header, content);

      resultsDiv.appendChild(item);
    }

    // Re-point aria-activedescendant on every render — arrow keys, filtering
    // and a fresh result set all funnel through here, so a screen reader tracks
    // the highlighted option while the input keeps DOM focus, and it can never
    // go stale. An empty set clears it (pointing at a missing id is worse).
    if (results.length > 0) {
      input.setAttribute("aria-activedescendant", `search-result-option-${activeIndex}`);
      // The results box is a fixed max-height scroller, so the roving highlight
      // otherwise walks off the bottom while Enter still opens the hidden row.
      // The sibling inline autocomplete already does this (OC-0370).
      (resultsDiv.children[activeIndex] as HTMLElement | undefined)?.scrollIntoView({
        block: "nearest",
      });
    } else {
      input.removeAttribute("aria-activedescendant");
    }

    renderLoadMore();
  }

  function renderLoadMore(): void {
    if (loadMoreBtn === null) return;
    loadMoreBtn.style.display = nextBefore === null ? "none" : "block";
    loadMoreBtn.disabled = loadingMore;
    setText(loadMoreBtn, messagingText(loadingMore ? "search.loadingMore" : "search.loadMore"));
  }

  function setStatus(text: string): void {
    setText(statusEl, text);
    statusEl.style.display = text === "" ? "none" : "block";
  }

  function executeSearch(query: string, before: number | undefined, append: boolean): void {
    if (searchAbort !== null) {
      searchAbort.abort();
    }
    searchAbort = new AbortController();
    const thisSearch = searchAbort;
    lastSearchTime = Date.now();

    if (append) {
      loadingMore = true;
      renderLoadMore();
    } else {
      nextBefore = null;
      loadingMore = false;
      renderLoadMore();
      setStatus(messagingText("search.searching"));
    }

    options
      .onSearch(query, scopeChannelId(), searchAbort.signal, before)
      .then((resp) => {
        // A stale response (superseded by a newer query, or by the query
        // dropping below the minimum and clearing the box) must not repaint
        // results under a different query.
        if (thisSearch !== searchAbort) return;
        results = append ? [...results, ...resp.results] : resp.results;
        nextBefore = resp.next_before ?? null;
        if (!append) activeIndex = 0;
        loadingMore = false;
        renderResults();
        if (!append) setStatus(results.length === 0 ? messagingText("search.empty") : "");
      })
      .catch((err: unknown) => {
        if (thisSearch !== searchAbort) return;
        loadingMore = false;
        renderLoadMore();
        if (err instanceof DOMException && err.name === "AbortError") return;
        setStatus(messagingText("search.failed"));
      });
  }

  function doSearch(): void {
    const query = input.value.trim();
    if (query.length < MIN_QUERY_LEN) {
      // Clearing/shortening the query is a local action: it must not wait on
      // the rate-limit window, and it must abort any outstanding request or
      // its late response would repopulate `results` under the empty box (F5).
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (searchAbort !== null) {
        searchAbort.abort();
        searchAbort = null;
      }
      results = [];
      nextBefore = null;
      loadingMore = false;
      renderResults();
      setStatus(
        query.length > 0 ? messagingText("search.minChars", { count: String(MIN_QUERY_LEN) }) : "",
      );
      return;
    }

    const now = Date.now();
    const sinceLast = now - lastSearchTime;
    if (sinceLast < MIN_SEARCH_INTERVAL_MS) {
      // Too soon after the previous search. Don't drop this query — that would
      // leave the earlier query's results on screen for what the user is now
      // typing. Reschedule for when the rate-limit window opens, reusing the
      // debounce timer so destroy() still tears it down.
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(doSearch, MIN_SEARCH_INTERVAL_MS - sinceLast);
      return;
    }

    executeSearch(query, undefined, false);
  }

  function loadMore(): void {
    if (nextBefore === null || loadingMore) return;
    const query = input.value.trim();
    if (query.length < MIN_QUERY_LEN) return;
    executeSearch(query, nextBefore, true);
  }

  function chooseScope(server: boolean): void {
    // Re-selecting the active scope must not re-run the search: the chip is not
    // a refresh control.
    if (scopeServer === server) return;
    scopeServer = server;
    paintScope();
    // A scope change invalidates every previous result: the rows and the paging
    // cursor belong to the old scope. Abort the in-flight request and clear them
    // before doSearch(), so a rate-limited reschedule cannot leave the other
    // scope's rows and cursor on screen for a later Load more to mix with.
    if (searchAbort !== null) {
      searchAbort.abort();
      searchAbort = null;
    }
    results = [];
    nextBefore = null;
    loadingMore = false;
    renderResults();
    if (input.value.trim().length >= MIN_QUERY_LEN) {
      doSearch();
    }
  }

  function paintScope(): void {
    if (channelOption === null || serverOption === null) return;
    channelOption.classList.toggle("active", !scopeServer);
    channelOption.setAttribute("aria-checked", String(!scopeServer));
    serverOption.classList.toggle("active", scopeServer);
    serverOption.setAttribute("aria-checked", String(scopeServer));
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
      // Escape closes from anywhere: focus moves to the body after clicking a
      // result row (and to the scope radiogroup or Load more after
      // tabbing/roving), so an input-only handler left Escape dead there. Bound
      // on document so the body-focus path is covered too; a single listener
      // cannot double-fire.
      options.onClose();
      return;
    }
    // Arrow/Enter combobox behaviour applies only while the input holds focus.
    if (e.target !== input) return;
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
        // Picking a hit jumps to it without closing the panel, so a reader can
        // walk through several hits (DP-20). Escape or the backdrop closes.
        options.onSelectResult(selected);
      }
    }
  }

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === root) {
      options.onClose();
    }
  }

  // Single delegated listener for the results container, registered once at
  // mount time. renderResults() re-creates row elements on every search and
  // on every arrow-key navigation, so binding a listener directly to each row
  // would re-register (and never release) one abort algorithm per discarded
  // row for the lifetime of the overlay.
  function handleResultsClick(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.closest(".search-result-item");
    if (!row) return;
    const testId = row.getAttribute("data-testid");
    if (!testId) return;
    const idx = Number(testId.slice("search-result-".length));
    const r = results[idx];
    if (r !== undefined) {
      options.onSelectResult(r);
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
      placeholder: messagingText("search.placeholder"),
      "aria-label": messagingText("search.label"),
      // Combobox over the results listbox: the input keeps DOM focus while
      // aria-activedescendant (set in renderResults) names the highlighted row,
      // matching the quick switcher's pattern.
      role: "combobox",
      "aria-expanded": "true",
      "aria-autocomplete": "list",
      "aria-controls": "search-overlay-results",
      "data-testid": "search-overlay-input",
    });

    statusEl = createElement("div", {
      class: "search-overlay-status",
      role: "status",
      style: "display:none",
    });

    resultsDiv = createElement("div", {
      class: "search-overlay-results",
      id: "search-overlay-results",
      role: "listbox",
      "data-testid": "search-overlay-results",
    });

    appendChildren(box, input);
    // A scope control is only meaningful when the overlay opened on a channel;
    // without one, search is already whole-server and there is nothing to narrow.
    if (options.currentChannelId !== undefined) {
      const scope = createElement("div", {
        class: "search-overlay-scope",
        role: "radiogroup",
        "aria-label": messagingText("search.scope.label"),
        "data-testid": "search-scope",
      });
      channelOption = createElement(
        "button",
        {
          class: "search-scope-option",
          type: "button",
          role: "radio",
          "aria-checked": "false",
          tabindex: "-1",
          "data-testid": "search-scope-channel",
        },
        channelScopeLabel(options.currentChannelId),
      );
      serverOption = createElement(
        "button",
        {
          class: "search-scope-option",
          type: "button",
          role: "radio",
          "aria-checked": "true",
          tabindex: "-1",
          "data-testid": "search-scope-server",
        },
        messagingText("search.scope.server"),
      );
      channelOption.addEventListener("click", () => chooseScope(false), { signal });
      serverOption.addEventListener("click", () => chooseScope(true), { signal });
      appendChildren(scope, channelOption, serverOption);
      paintScope();
      setRovingTabindex(scope, "[role='radio']");
      enableRovingNavigation(scope, "[role='radio']", signal);
      box.appendChild(scope);
    }

    loadMoreBtn = createElement(
      "button",
      {
        class: "search-overlay-load-more",
        type: "button",
        style: "display:none",
        "data-testid": "search-load-more",
      },
      messagingText("search.loadMore"),
    );
    loadMoreBtn.addEventListener("click", loadMore, { signal });

    appendChildren(box, statusEl, resultsDiv, loadMoreBtn);
    root.appendChild(box);
    container.appendChild(root);

    input.addEventListener("input", handleInput, { signal });
    // Document-level keydown so Escape closes wherever focus is, including the
    // body after a result click; the input still drives arrow/Enter combobox
    // behaviour and the handler gates those on the event target.
    document.addEventListener("keydown", handleKeydown, { signal });
    root.addEventListener("click", handleBackdropClick, { signal });
    resultsDiv.addEventListener("click", handleResultsClick, { signal });

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
    disposable.destroy();
    root?.remove();
    root = null;
  }

  return { mount, destroy };
}
