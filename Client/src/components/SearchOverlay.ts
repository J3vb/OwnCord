/**
 * SearchOverlay — full-text message search overlay with debounced input,
 * scope selection, cursor paging, result list rendering, and keyboard
 * navigation.
 * Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";
import { closeOnBackdropClick } from "@lib/ui/modalFactory";
import type { MountableComponent } from "@lib/text/safeRender";
import type { SearchResultItem, SearchResponse } from "@lib/types";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { channelsStore } from "@stores/channels.store";
import { blocksStore } from "@stores/blocks.store";
import { parseTimestamp, resolveAuthor } from "@lib/text/formatting";
import { resolveDisplayName } from "@lib/ui/avatar";
import { setRovingTabindex, enableRovingNavigation } from "@lib/ui/a11y";
import { markdownToPlainText } from "@lib/text/markdown";
import { formatDate } from "../i18n/format";
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
  /** The channel the overlay opened on; omitted behind the NSFW gate. */
  readonly currentChannelId?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 300;
const MIN_QUERY_LEN = 2;
/** Minimum interval between actual search API calls (rate limiting). */
const MIN_SEARCH_INTERVAL_MS = 500;

/** Filter keys the server parses out of `q` (service.ParseSearch). */
const FILTER_KEYS = new Set([
  "from",
  "in",
  "before",
  "after",
  "during",
  "has",
  "mentions",
  "pinned",
]);
/** A preview whose first hit lies beyond this many chars is windowed around it. */
const WINDOW_LEAD = 60;
const PREVIEW_MAX = 200;
const MIN_TERM_LEN = 2;

/**
 * The words to highlight for a query: whitespace-split, `key:value` filter
 * tokens (including a quoted value that holds spaces) dropped, quotes removed,
 * then every remaining token split on non letter/digit/mark characters (the
 * server's sanitizeFTSQuery turns those into separators) and terms under 2
 * chars ignored. Mirrors the server's lexSearch.
 */
export function highlightTerms(query: string): string[] {
  const terms: string[] = [];
  const n = query.length;
  let i = 0;
  while (i < n) {
    if (/\s/.test(query[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(query[j]!)) j++;
    const token = query.slice(i, j);
    const colon = token.indexOf(":");
    if (colon > 0 && FILTER_KEYS.has(token.slice(0, colon).toLowerCase())) {
      // A quoted filter value runs to the next quote, spaces included.
      if (token[colon + 1] === '"') {
        const close = query.indexOf('"', i + colon + 2);
        j = close === -1 ? n : close + 1;
      }
    } else {
      for (const part of token.replace(/"/g, "").split(/[^\p{L}\p{N}\p{M}]+/u)) {
        if (Array.from(part).length >= MIN_TERM_LEN) terms.push(part);
      }
    }
    i = j;
  }
  return terms;
}

/**
 * One case-insensitive regex over the terms (longest first so the longer of
 * two overlapping terms wins), or null when there is nothing to match. It runs
 * on the original text, so offsets never drift the way a lowercased copy can
 * ("İ" lowercases to two units), and the `u` flag keeps surrogate pairs whole.
 */
function termRegex(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  const alts = terms
    .toSorted((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(alts.join("|"), "giu");
}

const isLowSurrogate = (text: string, at: number): boolean => {
  const c = text.charCodeAt(at);
  return c >= 0xdc00 && c <= 0xdfff;
};

/** Plain-text preview: markdown stripped, windowed around the first hit, capped. */
function buildPreview(raw: string, terms: readonly string[], spoilerLabel: string): string {
  const plain = markdownToPlainText(raw, spoilerLabel);
  const re = termRegex(terms);
  const hit = re === null ? null : re.exec(plain);
  let start = 0;
  if (hit !== null && hit.index > WINDOW_LEAD) start = hit.index - WINDOW_LEAD;
  // Never cut through a surrogate pair: step back so the pair stays whole at
  // the start, and stop before its high half at the end.
  if (start > 0 && isLowSurrogate(plain, start)) start--;
  let end = start + PREVIEW_MAX;
  if (end < plain.length && isLowSurrogate(plain, end)) end--;
  return (
    (start > 0 ? "\u2026" : "") + plain.slice(start, end) + (end < plain.length ? "\u2026" : "")
  );
}

/** Fill `el` with `text`, each case-insensitive term hit wrapped in a <mark>. */
function fillHighlighted(el: HTMLElement, text: string, terms: readonly string[]): void {
  const re = termRegex(terms);
  let pos = 0;
  if (re !== null) {
    for (const m of text.matchAll(re)) {
      if (m[0] === "") continue;
      if (m.index > pos) el.appendChild(document.createTextNode(text.slice(pos, m.index)));
      const mark = createElement("mark", { class: "search-hit" });
      setText(mark, m[0]);
      el.appendChild(mark);
      pos = m.index + m[0].length;
    }
  }
  if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
}

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
  let retryBtn: HTMLButtonElement | null = null;
  let failedSearch: { query: string; before: number | undefined; append: boolean } | null = null;
  let loadMoreBtn: HTMLButtonElement | null = null;
  let channelOption: HTMLButtonElement | null = null;
  let serverOption: HTMLButtonElement | null = null;
  let activeIndex = 0;
  let results: readonly SearchResultItem[] = [];
  // Whole server is the default scope (D4 option b: "Whole server by default
  // with an 'in #channel' chip"), matching Discord. The chip that narrows to
  // the current channel is only offered when the overlay opened on one, so the
  // NSFW gate (which opens it without a channel) can never be narrowed back in.
  let scopeServer = true;
  let nextBefore: number | null = null;
  // The query that produced the currently displayed results. Paging must use it
  // rather than the live input value: editing the box only schedules a debounce
  // and leaves the old rows (and cursor) on screen until it fires, so a Load
  // more inside that window would otherwise page a different query.
  let lastQuery = "";
  let loadingMore = false;
  let debounceTimer: number | null = null;
  let searchAbort: AbortController | null = null;
  let lastSearchTime = 0;

  // oxlint-disable-next-line consistent-function-scoping -- co-located with its sole caller for readability
  function formatTimestamp(ts: string): string {
    try {
      const d = parseTimestamp(ts);
      return (
        formatDate(d, { year: "numeric", month: "short", day: "numeric" }) +
        " " +
        formatDate(d, { hour: "2-digit", minute: "2-digit" })
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

    const terms = highlightTerms(lastQuery);
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

      const blocked = blocksStore.getState().blockedByMe.has(r.user.id);
      const content = createElement("div", {
        class: blocked
          ? "search-result-content search-result-content--blocked"
          : "search-result-content",
      });
      if (blocked) setText(content, messagingText("blocked.message"));
      else {
        fillHighlighted(
          content,
          buildPreview(r.content, terms, messagingText("search.spoiler")),
          terms,
        );
      }

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
      // The sibling inline autocomplete already does this.
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
    failedSearch = null;
    if (retryBtn !== null) retryBtn.style.display = "none";
  }

  function showFailure(query: string, before: number | undefined, append: boolean): void {
    setStatus(messagingText("search.failed"));
    failedSearch = { query, before, append };
    if (retryBtn !== null) retryBtn.style.display = "inline-block";
  }

  function retry(): void {
    const f = failedSearch;
    if (f === null) return;
    executeSearch(f.query, f.before, f.append);
    input.focus();
  }

  function executeSearch(query: string, before: number | undefined, append: boolean): void {
    if (searchAbort !== null) {
      searchAbort.abort();
    }
    searchAbort = new AbortController();
    const thisSearch = searchAbort;
    lastSearchTime = Date.now();

    // Any new attempt, including a retry, clears the previous failure.
    failedSearch = null;
    if (retryBtn !== null) retryBtn.style.display = "none";

    if (append) {
      // A retried Load more must not keep showing the old failure.
      setStatus("");
      loadingMore = true;
      renderLoadMore();
    } else {
      lastQuery = query;
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
        setStatus(!append && results.length === 0 ? messagingText("search.empty") : "");
      })
      .catch((err: unknown) => {
        if (thisSearch !== searchAbort) return;
        loadingMore = false;
        renderLoadMore();
        if (err instanceof DOMException && err.name === "AbortError") return;
        showFailure(query, before, append);
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
      lastQuery = "";
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
    // Page the query the cursor belongs to, never the live input: an edit
    // inside the debounce window leaves this page's rows (and cursor) on screen.
    if (lastQuery.length < MIN_QUERY_LEN) return;
    executeSearch(lastQuery, nextBefore, true);
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
    lastQuery = "";
    nextBefore = null;
    loadingMore = false;
    // Drop a failed search with its Retry: it belonged to the old scope.
    setStatus("");
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
    // While an input method composes, Enter, arrows and Escape belong to it.
    if (isImeCommit(e)) return;
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
        // walk through several hits. Escape or the backdrop closes.
        options.onSelectResult(selected);
      }
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

    retryBtn = createElement(
      "button",
      {
        class: "search-overlay-retry messages-retry-btn",
        type: "button",
        style: "display:none",
        "data-testid": "search-retry",
      },
      messagingText("search.retry"),
    );
    retryBtn.addEventListener("click", retry, { signal });

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

    appendChildren(box, statusEl, retryBtn, resultsDiv, loadMoreBtn);
    root.appendChild(box);
    container.appendChild(root);

    input.addEventListener("input", handleInput, { signal });
    // Document-level keydown so Escape closes wherever focus is, including the
    // body after a result click; the input still drives arrow/Enter combobox
    // behaviour and the handler gates those on the event target.
    document.addEventListener("keydown", handleKeydown, { signal });
    closeOnBackdropClick(root, () => options.onClose(), signal);
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
