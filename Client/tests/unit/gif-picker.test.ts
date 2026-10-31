import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGifPicker } from "@components/GifPicker";
import { messagingText } from "../../src/i18n/messaging";
import { gifFavoritesText } from "../../src/i18n/gifFavorites";
import { ApiClientError } from "@lib/api";
import type { GifPickerOptions } from "@components/GifPicker";
import type { GifApi, GifFavoritesApi, GifPage, GifResult } from "@lib/media/gifProvider";
import {
  bindGifFavoritesApi,
  resetGifFavorites,
  isGifFavorite,
  toggleGifFavorite,
} from "@stores/gifFavorites.store";

// ---------------------------------------------------------------------------
// Module mock — must be hoisted before imports in vitest
// ---------------------------------------------------------------------------

// B9-8: this suite exercises content the viewer has already consented to;
// the consent gate itself is proven in src/features/content-consent/external.test.ts.
const consent = vi.hoisted(() => ({ allowed: true }));
vi.mock("../../src/features/content-consent/external", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
  externalAllowed: () => consent.allowed,
  requestExternalItem: async () => {
    consent.allowed = true;
    return true;
  },
}));

vi.mock("@lib/media/gifProvider", () => ({
  searchGifs: vi.fn(),
  getTrendingGifs: vi.fn(),
}));

// B7-16: grid thumbnails come from the native external-content broker.
const { previewMock, imageMock } = vi.hoisted(() => ({
  previewMock: vi.fn(),
  imageMock: vi.fn(),
}));
vi.mock("../../src/platform/desktop/externalContent", () => ({
  externalContent: { preview: previewMock, image: imageMock },
}));

// Import the mocks so tests can control their return values
import { searchGifs, getTrendingGifs } from "@lib/media/gifProvider";
import { clearExternalImageCache } from "../../src/features/messaging/content/attachments";

let blobCounter = 0;
const createObjectURLMock = vi.fn(() => `blob:test/${++blobCounter}`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGif(id: string): GifResult {
  return {
    id,
    title: `GIF ${id}`,
    url: `https://media.klipy.com/preview/${id}.gif`,
    fullUrl: `https://media.klipy.com/full/${id}.gif`,
  };
}

/** A single, final page: no further cursor. */
function lastPage(gifs: readonly GifResult[]): GifPage {
  return { gifs, next: "" };
}

const TRENDING_GIFS: readonly GifResult[] = [makeGif("t1"), makeGif("t2"), makeGif("t3")];

const SEARCH_GIFS: readonly GifResult[] = [makeGif("s1"), makeGif("s2")];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubApi: GifApi & GifFavoritesApi = {
  gifSearch: vi.fn(),
  gifTrending: vi.fn(),
  gifFavorites: vi.fn().mockResolvedValue({ favorites: [] }),
  addGifFavorite: vi.fn().mockResolvedValue(undefined),
  removeGifFavorite: vi.fn().mockResolvedValue(undefined),
};

function makePicker(overrides?: Partial<GifPickerOptions>) {
  const options: GifPickerOptions = {
    api: overrides?.api ?? stubApi,
    onSelect: overrides?.onSelect ?? vi.fn(),
    onClose: overrides?.onClose ?? vi.fn(),
    onUnavailable: overrides?.onUnavailable,
  };
  bindGifFavoritesApi(options.api);
  const picker = createGifPicker(options);
  return { picker, options };
}

let container: HTMLDivElement;

function mountPicker(overrides?: Partial<GifPickerOptions>) {
  const made = makePicker(overrides);
  container.appendChild(made.picker.element);
  return made;
}

type MountedPicker = ReturnType<typeof mountPicker>["picker"];

/** Trending resolves one GIF titled "" (so labels fall back to "GIF"). */
function mockUntitledGif(): void {
  const gifNoTitle: GifResult = {
    id: "no-title",
    title: "",
    url: "https://media.klipy.com/preview/no-title.gif",
    fullUrl: "https://media.klipy.com/full/no-title.gif",
  };
  vi.mocked(getTrendingGifs).mockResolvedValue(lastPage([gifNoTitle]));
}

function expectNoGifsFound(picker: MountedPicker): void {
  const empty = picker.element.querySelector(".gp-empty");
  expect(empty).not.toBeNull();
  expect(empty!.textContent).toBe("No GIFs found");
}

/** First trending page resolves; the second stays pending until the returned function is called. */
function holdSecondTrendingPage(): (page: GifPage) => void {
  let resolveMore!: (p: GifPage) => void;
  vi.mocked(getTrendingGifs)
    .mockResolvedValueOnce({ gifs: [makeGif("a")], next: "C1" })
    .mockReturnValueOnce(new Promise<GifPage>((r) => (resolveMore = r)));
  return (page) => resolveMore(page);
}

function itemFullUrls(picker: MountedPicker): Array<string | undefined> {
  return Array.from(picker.element.querySelectorAll<HTMLElement>(".gp-item")).map(
    (i) => i.dataset.fullUrl,
  );
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GifPicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();

    // Default: trending returns data, search returns search data
    vi.mocked(getTrendingGifs).mockResolvedValue(lastPage(TRENDING_GIFS));
    vi.mocked(searchGifs).mockResolvedValue(lastPage(SEARCH_GIFS));

    URL.createObjectURL = createObjectURLMock;
    URL.revokeObjectURL = vi.fn();
    imageMock.mockResolvedValue({ ok: true, value: new Blob(["x"], { type: "image/gif" }) });
    previewMock.mockResolvedValue({
      ok: true,
      value: { title: null, description: null, siteName: null, image: null },
    });
    clearExternalImageCache();

    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    container.remove();
  });

  // ── Structure ─────────────────────────────────────────────────────────────

  describe("createGifPicker return value", () => {
    it("returns an element and a destroy function", () => {
      const { picker } = makePicker();
      expect(picker.element).toBeInstanceOf(HTMLDivElement);
      expect(typeof picker.destroy).toBe("function");
      picker.destroy();
    });

    it("root element has gif-picker and open classes", () => {
      const { picker } = makePicker();
      expect(picker.element.classList.contains("gif-picker")).toBe(true);
      expect(picker.element.classList.contains("open")).toBe(true);
      picker.destroy();
    });

    it("attribution text reads 'Powered by Tenor'", () => {
      const { picker } = makePicker();
      const attribution = picker.element.querySelector(".gp-attribution");
      expect(attribution).not.toBeNull();
      expect(attribution!.textContent).toBe("Powered by Klipy");
      picker.destroy();
    });
  });

  // ── Search input ──────────────────────────────────────────────────────────

  describe("search input", () => {
    it("renders a search input with correct placeholder", () => {
      const { picker } = makePicker();
      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      expect(input).not.toBeNull();
      expect(input.tagName).toBe("INPUT");
      expect(input.placeholder).toBe("Search Klipy");
      picker.destroy();
    });

    it("debounces search — does not call searchGifs immediately on input", () => {
      const { picker } = mountPicker();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "cats");

      // Before debounce fires — searchGifs should not have been called yet
      expect(vi.mocked(searchGifs)).not.toHaveBeenCalled();
      picker.destroy();
    });

    it("calls searchGifs after 300 ms debounce", async () => {
      const { picker } = mountPicker();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "cats");

      vi.advanceTimersByTime(300);
      await Promise.resolve(); // flush microtasks

      expect(vi.mocked(searchGifs)).toHaveBeenCalledWith(stubApi, "cats", 20);
      picker.destroy();
    });

    it("cancels previous debounce timer when user types again quickly", async () => {
      const { picker } = mountPicker();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;

      typeInto(input, "ca");
      vi.advanceTimersByTime(100);

      typeInto(input, "cats");
      vi.advanceTimersByTime(300);
      await Promise.resolve();

      // Only one call — the second one after the full debounce window
      expect(vi.mocked(searchGifs)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(searchGifs)).toHaveBeenCalledWith(stubApi, "cats", 20);
      picker.destroy();
    });

    it("trims whitespace from search query before fetching", async () => {
      const { picker } = mountPicker();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "  dogs  ");

      vi.advanceTimersByTime(300);
      await Promise.resolve();

      expect(vi.mocked(searchGifs)).toHaveBeenCalledWith(stubApi, "dogs", 20);
      picker.destroy();
    });

    it("calls getTrendingGifs when search is cleared (empty string)", async () => {
      const { picker } = mountPicker();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      // Type something first
      typeInto(input, "cats");
      vi.advanceTimersByTime(300);
      await Promise.resolve();

      // Clear the input
      typeInto(input, "");
      vi.advanceTimersByTime(300);
      await Promise.resolve();

      // Last call should be getTrendingGifs, not searchGifs
      const trendingCalls = vi.mocked(getTrendingGifs).mock.calls.length;
      expect(trendingCalls).toBeGreaterThanOrEqual(1);
      picker.destroy();
    });
  });

  // ── Initial trending load ─────────────────────────────────────────────────

  describe("initial trending load", () => {
    it("calls getTrendingGifs on creation", () => {
      const { picker } = makePicker();
      // getTrendingGifs is called synchronously (no timer needed) at init
      expect(vi.mocked(getTrendingGifs)).toHaveBeenCalledWith(stubApi, 20);
      picker.destroy();
    });

    it("shows loading indicator while trending fetch is in flight", () => {
      // Return a never-resolving promise to keep loading state
      vi.mocked(getTrendingGifs).mockReturnValue(new Promise(() => {}));

      const { picker } = mountPicker();

      const loading = picker.element.querySelector(".gp-loading");
      expect(loading).not.toBeNull();
      expect(loading!.textContent).toBe("Loading...");
      picker.destroy();
    });

    it("renders GIF grid after trending data resolves", async () => {
      const { picker } = mountPicker();

      // Flush the resolved promise
      await flush();

      const items = picker.element.querySelectorAll(".gp-item");
      expect(items.length).toBe(TRENDING_GIFS.length);
      picker.destroy();
    });

    it("each grid item has an img with the preview url", async () => {
      const { picker } = mountPicker();

      await flush();

      const imgs = picker.element.querySelectorAll(".gp-img") as NodeListOf<HTMLImageElement>;
      expect(imgs.length).toBe(TRENDING_GIFS.length);

      // The webview never loads the Klipy URL itself: the broker is asked for
      // each preview url and the img shows the blob: URL it produced.
      TRENDING_GIFS.forEach((gif, i) => {
        expect(imgs[i]!.getAttribute("src")).not.toBe(gif.url);
        expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url: gif.url });
      });
      await vi.waitFor(() => {
        imgs.forEach((img) => expect(img.getAttribute("src")).toMatch(/^blob:/));
      });
      const srcs = [...imgs].map((img) => img.getAttribute("src"));
      expect(new Set(srcs).size).toBe(TRENDING_GIFS.length);
      srcs.forEach((src) => expect(createObjectURLMock).toHaveReturnedWith(src));
      picker.destroy();
    });
  });

  // ── GIF grid ──────────────────────────────────────────────────────────────

  describe("GIF grid rendering", () => {
    it("renders one .gp-item per gif", async () => {
      const { picker } = mountPicker();

      await flush();

      const grid = picker.element.querySelector(".gp-grid");
      expect(grid).not.toBeNull();
      expect(grid!.querySelectorAll(".gp-item").length).toBe(TRENDING_GIFS.length);
      picker.destroy();
    });

    it("img alt falls back to 'GIF' when title is empty", async () => {
      mockUntitledGif();

      const { picker } = mountPicker();

      await flush();

      const img = picker.element.querySelector(".gp-img") as HTMLImageElement;
      expect(img.alt).toBe("GIF");
      picker.destroy();
    });

    it("img alt is the gif title when present", async () => {
      const { picker } = mountPicker();

      await flush();

      const imgs = picker.element.querySelectorAll(".gp-img") as NodeListOf<HTMLImageElement>;
      expect(imgs[0]!.alt).toBe(TRENDING_GIFS[0]!.title);
      picker.destroy();
    });

    it("img has loading=lazy attribute", async () => {
      const { picker } = mountPicker();

      await flush();

      const img = picker.element.querySelector(".gp-img") as HTMLImageElement;
      expect(img.getAttribute("loading")).toBe("lazy");
      picker.destroy();
    });
  });

  // ── Clicking a GIF ────────────────────────────────────────────────────────

  describe("clicking a GIF", () => {
    it("calls onSelect with the full URL", async () => {
      const onSelect = vi.fn();
      const { picker } = mountPicker({ onSelect });

      await flush();

      const firstItem = picker.element.querySelector(".gp-item") as HTMLElement;
      firstItem.click();

      expect(onSelect).toHaveBeenCalledWith(TRENDING_GIFS[0]!.fullUrl);
      picker.destroy();
    });

    it("also calls onClose after selecting a GIF", async () => {
      const onClose = vi.fn();
      const { picker } = mountPicker({ onClose });

      await flush();

      const firstItem = picker.element.querySelector(".gp-item") as HTMLElement;
      firstItem.click();

      expect(onClose).toHaveBeenCalledOnce();
      picker.destroy();
    });

    it("calls onSelect with the correct fullUrl for each item", async () => {
      const onSelect = vi.fn();
      const { picker } = mountPicker({ onSelect });

      await flush();

      const items = picker.element.querySelectorAll(".gp-item") as NodeListOf<HTMLElement>;

      // Click each item and verify its fullUrl
      TRENDING_GIFS.forEach((gif, i) => {
        onSelect.mockClear();
        items[i]!.click();
        expect(onSelect).toHaveBeenCalledWith(gif.fullUrl);
      });
      picker.destroy();
    });

    // OC-0365: renderGifs replaces the whole cell set on every search, but a
    // per-cell click listener bound to the picker-lifetime `signal` (which
    // only aborts once, at destroy()) would keep every discarded cell from
    // a prior search reachable — and its click handler still live — for the
    // rest of the picker's life.
    it("does not fire onSelect for a cell discarded by a later search", async () => {
      const onSelect = vi.fn();
      const { picker } = mountPicker({ onSelect });

      // Flush trending
      await flush();

      const staleItem = picker.element.querySelector(".gp-item") as HTMLElement;
      expect(staleItem).not.toBeNull();

      // A search re-renders the grid, discarding the trending cells.
      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "cats");
      vi.advanceTimersByTime(300);
      await flush();

      expect(picker.element.contains(staleItem)).toBe(false);

      // Clicking the detached, stale cell must not still reach onSelect.
      staleItem.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(onSelect).not.toHaveBeenCalled();

      picker.destroy();
    });
  });

  // ── Escape key ────────────────────────────────────────────────────────────

  describe("Escape key", () => {
    it("calls onClose when Escape is pressed on the root element", () => {
      const onClose = vi.fn();
      const { picker } = mountPicker({ onClose });

      picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(onClose).toHaveBeenCalledOnce();
      picker.destroy();
    });

    it("does not call onClose for other keys", () => {
      const onClose = vi.fn();
      const { picker } = mountPicker({ onClose });

      picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

      expect(onClose).not.toHaveBeenCalled();
      picker.destroy();
    });
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  describe("empty state", () => {
    it("shows empty state when getTrendingGifs returns empty array", async () => {
      vi.mocked(getTrendingGifs).mockResolvedValue(lastPage([]));

      const { picker } = mountPicker();

      await flush();

      expectNoGifsFound(picker);
      picker.destroy();
    });

    it("shows empty state when searchGifs returns empty array", async () => {
      vi.mocked(searchGifs).mockResolvedValue(lastPage([]));

      const { picker } = mountPicker();

      // Flush initial trending load
      await flush();

      // Type a query and wait for debounce + resolution
      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "xyzzy");
      vi.advanceTimersByTime(300);

      await flush();

      expectNoGifsFound(picker);
      picker.destroy();
    });

    it("does not show empty state when gifs are present", async () => {
      const { picker } = mountPicker();

      await flush();

      // Should have .gp-grid, not .gp-empty
      expect(picker.element.querySelector(".gp-grid")).not.toBeNull();
      expect(picker.element.querySelector(".gp-empty")).toBeNull();
      picker.destroy();
    });
  });

  // ── Loading state ─────────────────────────────────────────────────────────

  describe("loading state", () => {
    it("shows loading indicator while search is in flight", async () => {
      // getTrendingGifs resolves immediately; search never resolves
      vi.mocked(getTrendingGifs).mockResolvedValue(lastPage(TRENDING_GIFS));
      vi.mocked(searchGifs).mockReturnValue(new Promise(() => {}));

      const { picker } = mountPicker();

      // Flush initial trending
      await flush();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "cats");
      vi.advanceTimersByTime(300);
      // Do NOT await — the search promise never resolves

      const loading = picker.element.querySelector(".gp-loading");
      expect(loading).not.toBeNull();
      expect(loading!.textContent).toBe("Loading...");
      picker.destroy();
    });

    it("replaces loading indicator with grid when fetch completes", async () => {
      const { picker } = mountPicker();

      await flush();

      // Loading should be gone, grid present
      expect(picker.element.querySelector(".gp-loading")).toBeNull();
      expect(picker.element.querySelector(".gp-grid")).not.toBeNull();
      picker.destroy();
    });
  });

  // ── Error state ───────────────────────────────────────────────────────────

  describe("error state", () => {
    it("shows a typed failure line with a bounded retry, not the raw error", async () => {
      vi.mocked(getTrendingGifs).mockRejectedValue(new Error("Network error"));

      const { picker } = mountPicker();

      await flush();
      await Promise.resolve(); // extra tick for rejection path

      // The transient state must not look like the empty-results state.
      expect(picker.element.querySelector(".gp-empty")).toBeNull();
      const status = picker.element.querySelector(".msg-media-fallback-text");
      expect(status?.textContent).toBe("Couldn't load GIFs");
      expect(status?.textContent).not.toContain("Network error");
      expect(picker.element.querySelector(".msg-media-retry")).not.toBeNull();
      picker.destroy();
    });

    it("retries the last query when the retry is activated", async () => {
      vi.mocked(getTrendingGifs)
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue(lastPage(TRENDING_GIFS));

      const { picker } = mountPicker();
      await flush();
      await Promise.resolve();
      const before = vi.mocked(getTrendingGifs).mock.calls.length;

      picker.element.querySelector<HTMLButtonElement>(".msg-media-retry")!.click();
      await flush();

      expect(vi.mocked(getTrendingGifs).mock.calls.length).toBeGreaterThan(before);
      expect(picker.element.querySelectorAll(".gp-item").length).toBe(TRENDING_GIFS.length);
      picker.destroy();
    });

    it("shows the typed failure for a non-Error rejection too", async () => {
      vi.mocked(getTrendingGifs).mockRejectedValue("oops");

      const { picker } = mountPicker();

      await flush();
      await Promise.resolve();

      expect(picker.element.querySelector(".msg-media-fallback-text")?.textContent).toBe(
        "Couldn't load GIFs",
      );
      picker.destroy();
    });
  });

  // ── Server has no GIF key configured (503 GIF_DISABLED) ───────────────────

  describe("graceful degradation when the server has no GIF key", () => {
    const disabledError = new ApiClientError(
      503,
      "GIF_DISABLED",
      "GIF search is not configured on this server",
    );

    it("shows a calm reason instead of a raw error", async () => {
      vi.mocked(getTrendingGifs).mockRejectedValue(disabledError);

      const { picker } = mountPicker();

      await flush();
      await Promise.resolve();

      const el = picker.element.querySelector(".gp-empty");
      expect(el).not.toBeNull();
      expect(el!.textContent).toBe(messagingText("gif.disabled"));
      picker.destroy();
    });

    it("marks the picker unavailable and disables the search input", async () => {
      vi.mocked(getTrendingGifs).mockRejectedValue(disabledError);

      const { picker } = mountPicker();

      await flush();
      await Promise.resolve();

      expect(picker.element.classList.contains("gp-unavailable")).toBe(true);
      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      expect(input.disabled).toBe(true);
      picker.destroy();
    });

    it("notifies the caller via onUnavailable so it can hide its GIF button", async () => {
      vi.mocked(getTrendingGifs).mockRejectedValue(disabledError);
      const onUnavailable = vi.fn();

      const { picker } = mountPicker({ onUnavailable });

      await flush();
      await Promise.resolve();

      expect(onUnavailable).toHaveBeenCalledWith(messagingText("gif.disabled"));
      picker.destroy();
    });

    it("does not treat other API errors as unavailable", async () => {
      vi.mocked(getTrendingGifs).mockRejectedValue(
        new ApiClientError(502, "BAD_GATEWAY", "GIF provider is unavailable"),
      );
      const onUnavailable = vi.fn();

      const { picker } = mountPicker({ onUnavailable });

      await flush();
      await Promise.resolve();

      expect(onUnavailable).not.toHaveBeenCalled();
      expect(picker.element.classList.contains("gp-unavailable")).toBe(false);
      picker.destroy();
    });
  });

  // ── Stale request cancellation ────────────────────────────────────────────

  describe("stale request cancellation", () => {
    it("does not render results from a superseded request", async () => {
      // First search resolves late, second resolves immediately
      let resolveFirst!: (v: GifPage) => void;
      const firstPromise = new Promise<GifPage>((res) => {
        resolveFirst = res;
      });

      vi.mocked(getTrendingGifs).mockResolvedValue(lastPage(TRENDING_GIFS));

      vi.mocked(searchGifs)
        .mockReturnValueOnce(firstPromise) // "ca" — resolves late
        .mockResolvedValueOnce(lastPage(SEARCH_GIFS)); // "cats" — resolves immediately

      const { picker } = mountPicker();

      // Flush trending
      await flush();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;

      // First query
      typeInto(input, "ca");
      vi.advanceTimersByTime(300);

      // Second query fires before first resolves
      typeInto(input, "cats");
      vi.advanceTimersByTime(300);
      await flush();

      // Now resolve the stale first request
      resolveFirst(lastPage([makeGif("stale")]));
      await flush();

      // Grid should show SEARCH_GIFS (second request), not the stale result
      const items = picker.element.querySelectorAll(".gp-item");
      expect(items.length).toBe(SEARCH_GIFS.length);
      picker.destroy();
    });
  });

  // ── Listbox semantics (DC-13) ─────────────────────────────────────────────

  describe("listbox semantics", () => {
    it("marks the grid area as a listbox named GIFs", () => {
      const { picker } = makePicker();
      const gridArea = picker.element.querySelector(".gp-grid-area");
      expect(gridArea).not.toBeNull();
      expect(gridArea!.getAttribute("role")).toBe("listbox");
      expect(gridArea!.getAttribute("aria-label")).toBe("GIFs");
      picker.destroy();
    });

    it("gives each item role=option with the gif title as aria-label", async () => {
      const { picker } = mountPicker();

      await flush();

      const items = picker.element.querySelectorAll(".gp-item");
      expect(items.length).toBe(TRENDING_GIFS.length);
      items.forEach((item, i) => {
        expect(item.getAttribute("role")).toBe("option");
        expect(item.getAttribute("aria-label")).toBe(TRENDING_GIFS[i]!.title);
      });
      picker.destroy();
    });

    it("aria-label falls back to 'GIF' when the title is empty", async () => {
      mockUntitledGif();

      const { picker } = mountPicker();

      await flush();

      const item = picker.element.querySelector(".gp-item");
      expect(item!.getAttribute("aria-label")).toBe("GIF");
      picker.destroy();
    });

    it("makes exactly one item tabbable (roving tabindex)", async () => {
      const { picker } = mountPicker();

      await flush();

      const items = Array.from(picker.element.querySelectorAll(".gp-item"));
      const tabbable = items.filter((c) => c.getAttribute("tabindex") === "0");
      expect(tabbable.length).toBe(1);
      expect(tabbable[0]).toBe(items[0]);
      expect(items.slice(1).every((c) => c.getAttribute("tabindex") === "-1")).toBe(true);
      picker.destroy();
    });

    it("re-applies the roving tabindex when a search replaces the items", async () => {
      const { picker } = mountPicker();

      await flush();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "cats");
      vi.advanceTimersByTime(300);
      await flush();

      const items = Array.from(picker.element.querySelectorAll(".gp-item"));
      expect(items.length).toBe(SEARCH_GIFS.length);
      const tabbable = items.filter((c) => c.getAttribute("tabindex") === "0");
      expect(tabbable.length).toBe(1);
      expect(tabbable[0]).toBe(items[0]);
      picker.destroy();
    });

    it("ArrowRight moves focus and the tabbable item to the next gif", async () => {
      const { picker } = mountPicker();

      await flush();

      const items = picker.element.querySelectorAll(".gp-item") as NodeListOf<HTMLElement>;
      expect(items.length).toBeGreaterThan(1);

      items[0]!.focus();
      items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

      expect(document.activeElement).toBe(items[1]);
      expect(items[0]!.getAttribute("tabindex")).toBe("-1");
      expect(items[1]!.getAttribute("tabindex")).toBe("0");
      picker.destroy();
    });

    it("Enter on a focused item fires the same onSelect/onClose as click", async () => {
      const onSelect = vi.fn();
      const onClose = vi.fn();
      const { picker } = mountPicker({ onSelect, onClose });

      await flush();

      const firstItem = picker.element.querySelector(".gp-item") as HTMLElement;
      firstItem.focus();
      firstItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(onSelect).toHaveBeenCalledWith(TRENDING_GIFS[0]!.fullUrl);
      expect(onClose).toHaveBeenCalledOnce();
      picker.destroy();
    });
  });

  // ── destroy() ─────────────────────────────────────────────────────────────

  describe("destroy()", () => {
    it("clears any pending debounce timer", async () => {
      const { picker } = mountPicker();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "cats");

      // Destroy before debounce fires
      picker.destroy();
      vi.advanceTimersByTime(300);
      await Promise.resolve();

      // searchGifs should not have been called (only getTrendingGifs at init)
      expect(vi.mocked(searchGifs)).not.toHaveBeenCalled();
    });

    it("aborts the AbortController so click events no longer fire", async () => {
      const onSelect = vi.fn();
      const { picker } = mountPicker({ onSelect });

      await flush();

      picker.destroy();

      const firstItem = picker.element.querySelector(".gp-item") as HTMLElement | null;
      if (firstItem) {
        firstItem.click();
      }

      // onSelect should not fire after destroy
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("aborts the AbortController so Escape key no longer calls onClose", () => {
      const onClose = vi.fn();
      const { picker } = mountPicker({ onClose });

      picker.destroy();

      picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

      expect(onClose).not.toHaveBeenCalled();
    });

    it("aborts the AbortController so input events no longer fire", async () => {
      const { picker } = mountPicker();

      picker.destroy();
      vi.mocked(getTrendingGifs).mockClear();
      vi.mocked(searchGifs).mockClear();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "cats");
      vi.advanceTimersByTime(300);
      await Promise.resolve();

      expect(vi.mocked(searchGifs)).not.toHaveBeenCalled();
    });
  });

  // ── Load more on scroll ───────────────────────────────────────────────────

  describe("load more on scroll", () => {
    // jsdom has no IntersectionObserver: a fake records what is observed and
    // lets a test report the sentinel as in view.
    let observed: Element[];
    let fire: () => void;

    beforeEach(() => {
      observed = [];
      fire = () => {};
      class FakeObserver {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          fire = () => cb([{ isIntersecting: true }]);
        }
        observe(el: Element): void {
          observed.push(el);
        }
        unobserve(el: Element): void {
          observed = observed.filter((e) => e !== el);
        }
        disconnect(): void {
          observed = [];
        }
      }
      vi.stubGlobal("IntersectionObserver", FakeObserver);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function itemIds(root: HTMLElement): string[] {
      return [...root.querySelectorAll<HTMLElement>(".gp-item")].map(
        (i) => i.dataset.fullUrl?.replace(/^.*\/full\/|\.gif$/g, "") ?? "",
      );
    }

    async function flush(): Promise<void> {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }

    it("appends the next page, deduped by id, and passes the cursor", async () => {
      vi.mocked(getTrendingGifs)
        .mockResolvedValueOnce({ gifs: [makeGif("a"), makeGif("b")], next: "C1" })
        .mockResolvedValueOnce({ gifs: [makeGif("b"), makeGif("c")], next: "" });
      const { picker } = mountPicker();
      await flush();
      expect(itemIds(picker.element)).toEqual(["a", "b"]);
      expect(observed).toHaveLength(1);

      fire();
      await flush();

      expect(vi.mocked(getTrendingGifs)).toHaveBeenLastCalledWith(stubApi, 20, "C1");
      expect(itemIds(picker.element)).toEqual(["a", "b", "c"]);
      // next was empty: nothing left to watch.
      expect(observed).toHaveLength(0);
      picker.destroy();
    });

    it("pages a search with the query and stops on a page of only duplicates", async () => {
      vi.mocked(searchGifs)
        .mockResolvedValueOnce({ gifs: [makeGif("a")], next: "S1" })
        .mockResolvedValueOnce({ gifs: [makeGif("a")], next: "S1" });
      const { picker } = mountPicker();
      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "cats");
      vi.advanceTimersByTime(300);
      await flush();

      fire();
      await flush();

      expect(vi.mocked(searchGifs)).toHaveBeenLastCalledWith(stubApi, "cats", 20, "S1");
      expect(itemIds(picker.element)).toEqual(["a"]);
      expect(observed).toHaveLength(0);
      picker.destroy();
    });

    it("ignores a page that resolves after the query changed", async () => {
      const resolveMore = holdSecondTrendingPage();
      vi.mocked(searchGifs).mockResolvedValue({ gifs: [makeGif("s")], next: "" });
      const { picker } = mountPicker();
      await flush();

      fire(); // page 2 of trending is now in flight
      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      typeInto(input, "cats");
      vi.advanceTimersByTime(300);
      await flush();
      resolveMore({ gifs: [makeGif("late")], next: "C2" });
      await flush();

      expect(itemIds(picker.element)).toEqual(["s"]);
      picker.destroy();
    });

    it("shows nothing broken after a failed page and retries on a scroll after the cooldown", async () => {
      vi.mocked(getTrendingGifs)
        .mockResolvedValueOnce({ gifs: [makeGif("a")], next: "C1" })
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ gifs: [makeGif("b")], next: "" });
      const { picker } = mountPicker();
      await flush();
      const area = picker.element.querySelector(".gp-grid-area")!;

      fire();
      await flush();
      expect(itemIds(picker.element)).toEqual(["a"]);
      expect(picker.element.textContent).not.toContain("Couldn't load GIFs");
      expect(vi.mocked(getTrendingGifs)).toHaveBeenCalledTimes(2);

      // Inside the cooldown a scroll does not retry.
      vi.advanceTimersByTime(2999);
      area.dispatchEvent(new Event("scroll"));
      fire();
      await flush();
      expect(vi.mocked(getTrendingGifs)).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1);
      area.dispatchEvent(new Event("scroll"));
      fire();
      await flush();

      expect(vi.mocked(getTrendingGifs)).toHaveBeenLastCalledWith(stubApi, 20, "C1");
      expect(itemIds(picker.element)).toEqual(["a", "b"]);
      picker.destroy();
    });

    it("does not hammer the server while a page keeps failing", async () => {
      vi.mocked(getTrendingGifs)
        .mockResolvedValueOnce({ gifs: [makeGif("a")], next: "C1" })
        .mockRejectedValue(new Error("offline"));
      const { picker } = mountPicker();
      await flush();
      const area = picker.element.querySelector(".gp-grid-area")!;

      fire();
      await flush();
      for (let i = 0; i < 20; i++) {
        area.dispatchEvent(new Event("scroll"));
        fire();
        await flush();
      }

      expect(vi.mocked(getTrendingGifs)).toHaveBeenCalledTimes(2);
      picker.destroy();
    });

    it("stops paging on a 4xx error", async () => {
      vi.mocked(getTrendingGifs)
        .mockResolvedValueOnce({ gifs: [makeGif("a")], next: "C1" })
        .mockRejectedValue(new ApiClientError(400, "INVALID_INPUT", "bad"));
      const { picker } = mountPicker();
      await flush();

      fire();
      await flush();
      vi.advanceTimersByTime(60_000);
      picker.element.querySelector(".gp-grid-area")!.dispatchEvent(new Event("scroll"));
      fire();
      await flush();

      expect(vi.mocked(getTrendingGifs)).toHaveBeenCalledTimes(2);
      expect(observed).toHaveLength(0);
      picker.destroy();
    });

    it("shows page two when the first page is empty but has a cursor", async () => {
      vi.mocked(getTrendingGifs)
        .mockResolvedValueOnce({ gifs: [], next: "C1" })
        .mockResolvedValueOnce({ gifs: [makeGif("b")], next: "" });
      const { picker } = mountPicker();
      await flush();
      expect(picker.element.querySelector(".gp-empty")).toBeNull();
      expect(observed).toHaveLength(1);

      fire();
      await flush();

      expect(itemIds(picker.element)).toEqual(["b"]);
      picker.destroy();
    });

    it("keeps the Tab stop where the user left it when a page is appended", async () => {
      vi.mocked(getTrendingGifs)
        .mockResolvedValueOnce({ gifs: [makeGif("a"), makeGif("b")], next: "C1" })
        .mockResolvedValueOnce({ gifs: [makeGif("c")], next: "" });
      const { picker } = mountPicker();
      await flush();
      const cells = () => [...picker.element.querySelectorAll<HTMLElement>(".gp-item")];
      cells()[0]!.setAttribute("tabindex", "-1");
      cells()[1]!.setAttribute("tabindex", "0");

      fire();
      await flush();

      expect(cells().map((c) => c.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
      picker.destroy();
    });

    it("leaves the grid alone when the tab changed while a page was in flight", async () => {
      const resolveMore = holdSecondTrendingPage();
      const { picker } = mountPicker();
      await flush();
      fire();
      (picker.element.querySelectorAll(".gp-tab")[1] as HTMLElement).click();
      resolveMore({ gifs: [makeGif("late")], next: "C2" });
      await flush();

      expect(observed).toHaveLength(0);
      expect(itemIds(picker.element)).not.toContain("late");
      picker.destroy();
    });

    it("does not page on the favorites tab", async () => {
      vi.mocked(getTrendingGifs).mockResolvedValue({ gifs: [makeGif("a")], next: "C1" });
      const { picker } = mountPicker();
      await flush();
      expect(observed).toHaveLength(1);

      (picker.element.querySelectorAll(".gp-tab")[1] as HTMLElement).click();
      await flush();
      expect(observed).toHaveLength(0);
      fire();
      await flush();

      expect(vi.mocked(getTrendingGifs)).toHaveBeenCalledTimes(1);
      picker.destroy();
    });
  });

  // ── Favorites ─────────────────────────────────────────────────────────────

  describe("favorites", () => {
    const favs = [
      {
        url: "https://media.klipy.com/full/f1.gif",
        preview_url: "https://media.klipy.com/preview/f1.gif",
        title: "Fav 1",
      },
      {
        url: "https://media.klipy.com/full/f2.gif",
        preview_url: "https://media.klipy.com/preview/f2.gif",
        title: "Fav 2",
      },
    ];

    function favApi(initial = favs): GifApi & GifFavoritesApi {
      return {
        ...stubApi,
        gifFavorites: vi.fn().mockResolvedValue({ favorites: initial }),
        addGifFavorite: vi.fn().mockResolvedValue(undefined),
        removeGifFavorite: vi.fn().mockResolvedValue(undefined),
      };
    }

    const settle = async (): Promise<void> => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    };

    beforeEach(() => resetGifFavorites());

    it("puts a star on every result, pressed only for saved GIFs", async () => {
      const api = favApi([
        { url: TRENDING_GIFS[1]!.fullUrl, preview_url: TRENDING_GIFS[1]!.url, title: "x" },
      ]);
      const { picker } = mountPicker({ api });
      await settle();
      const stars = picker.element.querySelectorAll<HTMLButtonElement>(".gp-item .gp-star");
      expect(stars.length).toBe(TRENDING_GIFS.length);
      expect(stars[0]!.getAttribute("aria-pressed")).toBe("false");
      expect(stars[1]!.getAttribute("aria-pressed")).toBe("true");
      picker.destroy();
    });

    it("clicking a star saves the GIF without sending it", async () => {
      const api = favApi([]);
      const onSelect = vi.fn();
      const { picker } = mountPicker({ api, onSelect });
      await settle();
      picker.element.querySelector<HTMLButtonElement>(".gp-item .gp-star")!.click();
      await settle();
      expect(onSelect).not.toHaveBeenCalled();
      expect(api.addGifFavorite).toHaveBeenCalledWith({
        url: TRENDING_GIFS[0]!.fullUrl,
        preview_url: TRENDING_GIFS[0]!.url,
        title: TRENDING_GIFS[0]!.title,
      });
      expect(isGifFavorite(TRENDING_GIFS[0]!.fullUrl)).toBe(true);
      expect(picker.element.querySelector(".gp-item .gp-star")!.getAttribute("aria-pressed")).toBe(
        "true",
      );
      picker.destroy();
    });

    it("the F key on a focused GIF toggles its favorite", async () => {
      const api = favApi([]);
      const { picker } = mountPicker({ api });
      await settle();
      const item = picker.element.querySelector<HTMLElement>(".gp-item")!;
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await settle();
      expect(api.addGifFavorite).toHaveBeenCalledTimes(1);
      picker.destroy();
    });

    it("the Favorites tab lists saved GIFs newest first and sends one on click", async () => {
      const api = favApi();
      const onSelect = vi.fn();
      const { picker } = mountPicker({ api, onSelect });
      await settle();
      const tabs = picker.element.querySelectorAll<HTMLButtonElement>(".gp-tab");
      expect(tabs.length).toBe(2);
      tabs[1]!.click();
      await settle();
      expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
      const items = picker.element.querySelectorAll<HTMLElement>(".gp-item");
      expect(Array.from(items).map((i) => i.dataset.fullUrl)).toEqual(favs.map((f) => f.url));
      items[1]!.click();
      expect(onSelect).toHaveBeenCalledWith(favs[1]!.url);
      picker.destroy();
    });

    it("unstarring in the Favorites tab removes the GIF from the list", async () => {
      const api = favApi();
      const { picker } = mountPicker({ api });
      await settle();
      picker.element.querySelectorAll<HTMLButtonElement>(".gp-tab")[1]!.click();
      await settle();
      picker.element.querySelector<HTMLButtonElement>(".gp-item .gp-star")!.click();
      await settle();
      expect(api.removeGifFavorite).toHaveBeenCalledWith(favs[0]!.url);
      expect(picker.element.querySelectorAll(".gp-item").length).toBe(1);
      picker.destroy();
    });

    it("moves focus to the search box when a late 404 hides the focused Favorites tab", async () => {
      let reject: (e: unknown) => void = () => {};
      const api = favApi([]);
      api.gifFavorites = vi.fn(
        () =>
          new Promise<never>((_, rej) => {
            reject = rej;
          }),
      );
      const { picker } = mountPicker({ api });
      await settle();
      const tab = picker.element.querySelectorAll<HTMLButtonElement>(".gp-tab")[1]!;
      tab.click();
      tab.focus();
      expect(document.activeElement).toBe(tab);
      reject(new ApiClientError(404, "NOT_FOUND", "nope"));
      await settle();
      expect(picker.element.classList.contains("gp-no-favorites")).toBe(true);
      expect(document.activeElement).toBe(picker.element.querySelector(".gp-search"));
      picker.destroy();
    });

    it("shows an empty state when nothing is saved", async () => {
      const { picker } = mountPicker({ api: favApi([]) });
      await settle();
      picker.element.querySelectorAll<HTMLButtonElement>(".gp-tab")[1]!.click();
      await settle();
      expect(picker.element.querySelector(".gp-empty")!.textContent).toBe(
        gifFavoritesText("favoritesEmpty"),
      );
      picker.destroy();
    });

    it("removing the focused favorite moves focus to a neighbouring GIF", async () => {
      const api = favApi();
      const { picker } = mountPicker({ api });
      await settle();
      picker.element.querySelectorAll<HTMLButtonElement>(".gp-tab")[1]!.click();
      await settle();
      const first = picker.element.querySelector<HTMLElement>(".gp-item")!;
      first.focus();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await settle();
      const remaining = picker.element.querySelector<HTMLElement>(".gp-item")!;
      expect(remaining.dataset.fullUrl).toBe(favs[1]!.url);
      expect(document.activeElement).toBe(remaining);
      picker.destroy();
    });

    it("removing the last favorite moves focus to the Favorites tab", async () => {
      const api = favApi([favs[0]!]);
      const { picker } = mountPicker({ api });
      await settle();
      const tabs = picker.element.querySelectorAll<HTMLButtonElement>(".gp-tab");
      tabs[1]!.click();
      await settle();
      const item = picker.element.querySelector<HTMLElement>(".gp-item")!;
      item.focus();
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await settle();
      expect(document.activeElement).toBe(tabs[1]);
      picker.destroy();
    });

    it("a search pending when Favorites opens does not replace the favorites grid", async () => {
      vi.useFakeTimers();
      try {
        const api = favApi();
        const { picker } = mountPicker({ api });
        await settle();
        const input = picker.element.querySelector<HTMLInputElement>("input")!;
        input.value = "cats";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        picker.element.querySelectorAll<HTMLButtonElement>(".gp-tab")[1]!.click();
        await vi.advanceTimersByTimeAsync(1000);
        expect(itemFullUrls(picker)).toEqual(favs.map((f) => f.url));
        picker.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("granting consent on the Favorites tab renders the favorites and keeps focus", async () => {
      consent.allowed = false;
      try {
        const api = favApi();
        const { picker } = mountPicker({ api });
        await settle();
        const tabs = picker.element.querySelectorAll<HTMLButtonElement>(".gp-tab");
        tabs[1]!.click();
        await settle();
        picker.element.querySelector<HTMLButtonElement>(".gp-consent")!.click();
        await settle();
        expect(itemFullUrls(picker)).toEqual(favs.map((f) => f.url));
        const imgs = picker.element.querySelectorAll<HTMLImageElement>(".gp-item .gp-img");
        expect(imgs.length).toBe(favs.length);
        imgs.forEach((img) => expect(img.src).toMatch(/^blob:/));
        favs.forEach((f) =>
          expect(imageMock).toHaveBeenCalledWith(expect.any(String), { url: f.preview_url }),
        );
        expect(document.activeElement).toBe(tabs[1]);
        picker.destroy();
      } finally {
        consent.allowed = true;
      }
    });

    it("ignores a second toggle of the same GIF while one is in flight", async () => {
      const api = favApi([]);
      bindGifFavoritesApi(api);
      await settle();
      const fav = { url: favs[0]!.url, preview_url: favs[0]!.preview_url, title: "t" };
      await Promise.all([toggleGifFavorite(fav), toggleGifFavorite(fav)]);
      expect(api.addGifFavorite).toHaveBeenCalledTimes(1);
      expect(api.removeGifFavorite).not.toHaveBeenCalled();
      expect(isGifFavorite(fav.url)).toBe(true);
    });

    it("a load from before a reset never lands in the next session", async () => {
      let resolveLoad!: (v: { favorites: typeof favs }) => void;
      const api = favApi();
      api.gifFavorites = vi.fn(
        () => new Promise<{ favorites: typeof favs }>((r) => (resolveLoad = r)),
      );
      bindGifFavoritesApi(api);
      resetGifFavorites();
      resolveLoad({ favorites: favs });
      await settle();
      expect(isGifFavorite(favs[0]!.url)).toBe(false);
    });
  });
});
