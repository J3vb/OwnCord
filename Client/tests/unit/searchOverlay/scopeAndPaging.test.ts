import { describe, it, expect, vi } from "vitest";
import type { SearchResultItem, SearchResponse } from "../../../src/lib/types";
import {
  makeResult,
  makeOptions,
  mountOverlay,
  searchInput,
  typeQuery,
  pressKey,
  expectActiveRow,
  useSearchOverlayEnv,
  searchFor,
} from "../../helpers/searchOverlayHarness";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSearchOverlay", () => {
  let container: HTMLDivElement;
  useSearchOverlayEnv((c) => (container = c));

  it("defaults to whole-server scope even when the overlay opened on a channel (D4)", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const { overlay } = await searchFor(container, { onSearch, currentChannelId: 99 }, "scoped");

    expect(onSearch).toHaveBeenCalledWith("scoped", undefined, expect.any(AbortSignal), undefined);

    overlay.destroy?.();
  });

  it("narrowing to 'This channel' re-runs the search scoped to the current channel (D4)", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const { overlay } = await searchFor(container, { onSearch, currentChannelId: 99 }, "scoped");
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
    const { overlay } = await searchFor(container, { onSearch, currentChannelId: 99 }, "hello");

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
    const { overlay } = await searchFor(container, { onSearch, currentChannelId: 99 }, "hello");
    expect(onSearch).toHaveBeenCalledTimes(1);
    const wholeServerSignal = abortedSignal;

    (container.querySelector("[data-testid='search-scope-channel']") as HTMLButtonElement).click();
    expect(wholeServerSignal!.aborted).toBe(true);

    overlay.destroy?.();
  });

  it("does not offer a scope toggle behind the NSFW gate", () => {
    const overlay = mountOverlay(container, makeOptions());

    // No currentChannelId: whole-server only, nothing to narrow.
    expect(container.querySelector("[data-testid='search-scope']")).toBeNull();

    overlay.destroy?.();
  });

  it("choosing 'Whole server' from channel scope calls onSearch with channelId undefined (D4)", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const { overlay } = await searchFor(container, { onSearch, currentChannelId: 99 }, "scoped");

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
    const overlay = mountOverlay(container, opts);

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
    const { overlay } = await searchFor(container, { onSearch }, "page");

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
    const { overlay, input } = await searchFor(container, { onSearch }, "hello");

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
    const { overlay } = await searchFor(container, { onSearch }, "single");

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
    const { overlay } = await searchFor(container, { onSearch }, "long");

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
      const overlay = mountOverlay(container, makeOptions({ onSearch }));
      const input = searchInput(container);
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
      const overlay = mountOverlay(container, makeOptions({ onSearch, currentChannelId: 42 }));
      const input = searchInput(container);
      await typeQuery(input, "h");
      await typeQuery(input, "hello", 600);
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
      const input = searchInput(container);
      await typeQuery(input, "hello2", 600);
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
      const { overlay, input } = await searchFor(container, { onSearch }, "test");

      // First item is active
      expectActiveRow(container, 0);

      // Arrow up should wrap to last
      pressKey(input, "ArrowUp");
      expectActiveRow(container, 2);

      overlay.destroy?.();
    });

    it("ArrowDown wraps from last to first", async () => {
      const results = [makeResult({ message_id: 1 }), makeResult({ message_id: 2 })];
      const onSearch = vi.fn().mockResolvedValue({ results });
      const { overlay, input } = await searchFor(container, { onSearch }, "test");

      // Move to last
      pressKey(input, "ArrowDown");
      expectActiveRow(container, 1);

      // One more should wrap to first
      pressKey(input, "ArrowDown");
      expectActiveRow(container, 0);

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
    const overlay = mountOverlay(container, opts);

    const input = searchInput(container);

    // First search
    await typeQuery(input, "first");
    expect(onSearch).toHaveBeenCalledTimes(1);
    const firstSignal = abortedSignal;

    // Second search — should abort the first
    // Advance past the MIN_SEARCH_INTERVAL_MS (500ms) rate limit before triggering debounce
    onSearch.mockImplementation(() => Promise.resolve({ results: [] }));
    await vi.advanceTimersByTimeAsync(200); // now 500ms since first search fired
    await typeQuery(input, "second");

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
    const overlay = mountOverlay(container, makeOptions({ onSearch }));

    const input = searchInput(container);
    await typeQuery(input, "test");

    scrollIntoView.mockClear();
    pressKey(input, "ArrowDown");

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
    const { overlay, input } = await searchFor(container, { onSearch }, "hello");
    expect(onSearch).toHaveBeenCalledTimes(1);

    // Clear the query before the stalled search lands.
    await typeQuery(input, "");

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
    const { overlay } = await searchFor(container, { onSearch }, "searching");

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
    const { overlay } = await searchFor(container, { onSearch }, "aborted");

    const status = container.querySelector(".search-overlay-status");
    // Should NOT show "Search failed" for abort errors
    expect(status!.textContent).not.toBe("Search failed");

    overlay.destroy?.();
  });

  it("Enter is a no-op when there are no results", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const onSelectResult = vi.fn();
    const { opts, overlay, input } = await searchFor(
      container,
      { onSearch, onSelectResult },
      "empty",
    );

    pressKey(input, "Enter");
    expect(onSelectResult).not.toHaveBeenCalled();
    expect(opts.onClose).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("ArrowUp/ArrowDown are no-ops when results are empty", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const { overlay, input } = await searchFor(container, { onSearch }, "empty");

    // Should not throw
    pressKey(input, "ArrowDown");
    pressKey(input, "ArrowUp");

    expect(container.querySelectorAll(".search-result-item").length).toBe(0);

    overlay.destroy?.();
  });

  it("debounces rapid input changes", async () => {
    const onSearch = vi.fn().mockResolvedValue({ results: [] });
    const opts = makeOptions({ onSearch });
    const overlay = mountOverlay(container, opts);

    const input = searchInput(container);

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
    const overlay = mountOverlay(container, opts);

    const input = searchInput(container);

    // First query fires after debounce, stamping the rate-limit clock.
    await typeQuery(input, "he");
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
