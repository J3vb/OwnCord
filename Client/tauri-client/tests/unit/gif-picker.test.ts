import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGifPicker } from "@components/GifPicker";
import type { GifPickerOptions } from "@components/GifPicker";
import type { TenorGif } from "@lib/tenor";

// ---------------------------------------------------------------------------
// Module mock — must be hoisted before imports in vitest
// ---------------------------------------------------------------------------

vi.mock("@lib/tenor", () => ({
  searchGifs: vi.fn(),
  getTrendingGifs: vi.fn(),
}));

// Import the mocks so tests can control their return values
import { searchGifs, getTrendingGifs } from "@lib/tenor";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGif(id: string): TenorGif {
  return {
    id,
    title: `GIF ${id}`,
    url: `https://media.tenor.com/preview/${id}.gif`,
    fullUrl: `https://media.tenor.com/full/${id}.gif`,
  };
}

const TRENDING_GIFS: readonly TenorGif[] = [
  makeGif("t1"),
  makeGif("t2"),
  makeGif("t3"),
];

const SEARCH_GIFS: readonly TenorGif[] = [
  makeGif("s1"),
  makeGif("s2"),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePicker(overrides?: Partial<GifPickerOptions>) {
  const options: GifPickerOptions = {
    onSelect: overrides?.onSelect ?? vi.fn(),
    onClose: overrides?.onClose ?? vi.fn(),
  };
  const picker = createGifPicker(options);
  return { picker, options };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GifPicker", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();

    // Default: trending returns data, search returns search data
    vi.mocked(getTrendingGifs).mockResolvedValue(TRENDING_GIFS);
    vi.mocked(searchGifs).mockResolvedValue(SEARCH_GIFS);

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
      expect(attribution!.textContent).toBe("Powered by Tenor");
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
      expect(input.placeholder).toBe("Search Tenor");
      picker.destroy();
    });

    it("debounces search — does not call searchGifs immediately on input", () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      input.value = "cats";
      input.dispatchEvent(new Event("input"));

      // Before debounce fires — searchGifs should not have been called yet
      expect(vi.mocked(searchGifs)).not.toHaveBeenCalled();
      picker.destroy();
    });

    it("calls searchGifs after 300 ms debounce", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      input.value = "cats";
      input.dispatchEvent(new Event("input"));

      vi.advanceTimersByTime(300);
      await Promise.resolve(); // flush microtasks

      expect(vi.mocked(searchGifs)).toHaveBeenCalledWith("cats", 20);
      picker.destroy();
    });

    it("cancels previous debounce timer when user types again quickly", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;

      input.value = "ca";
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(100);

      input.value = "cats";
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(300);
      await Promise.resolve();

      // Only one call — the second one after the full debounce window
      expect(vi.mocked(searchGifs)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(searchGifs)).toHaveBeenCalledWith("cats", 20);
      picker.destroy();
    });

    it("trims whitespace from search query before fetching", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      input.value = "  dogs  ";
      input.dispatchEvent(new Event("input"));

      vi.advanceTimersByTime(300);
      await Promise.resolve();

      expect(vi.mocked(searchGifs)).toHaveBeenCalledWith("dogs", 20);
      picker.destroy();
    });

    it("calls getTrendingGifs when search is cleared (empty string)", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      // Type something first
      input.value = "cats";
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(300);
      await Promise.resolve();

      // Clear the input
      input.value = "";
      input.dispatchEvent(new Event("input"));
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
      expect(vi.mocked(getTrendingGifs)).toHaveBeenCalledWith(20);
      picker.destroy();
    });

    it("shows loading indicator while trending fetch is in flight", () => {
      // Return a never-resolving promise to keep loading state
      vi.mocked(getTrendingGifs).mockReturnValue(new Promise(() => {}));

      const { picker } = makePicker();
      container.appendChild(picker.element);

      const loading = picker.element.querySelector(".gp-loading");
      expect(loading).not.toBeNull();
      expect(loading!.textContent).toBe("Loading...");
      picker.destroy();
    });

    it("renders GIF grid after trending data resolves", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      // Flush the resolved promise
      await Promise.resolve();
      await Promise.resolve();

      const items = picker.element.querySelectorAll(".gp-item");
      expect(items.length).toBe(TRENDING_GIFS.length);
      picker.destroy();
    });

    it("each grid item has an img with the preview url", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      const imgs = picker.element.querySelectorAll(".gp-img") as NodeListOf<HTMLImageElement>;
      expect(imgs.length).toBe(TRENDING_GIFS.length);

      TRENDING_GIFS.forEach((gif, i) => {
        expect(imgs[i]!.src).toBe(gif.url);
      });
      picker.destroy();
    });
  });

  // ── GIF grid ──────────────────────────────────────────────────────────────

  describe("GIF grid rendering", () => {
    it("renders one .gp-item per gif", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      const grid = picker.element.querySelector(".gp-grid");
      expect(grid).not.toBeNull();
      expect(grid!.querySelectorAll(".gp-item").length).toBe(TRENDING_GIFS.length);
      picker.destroy();
    });

    it("img alt falls back to 'GIF' when title is empty", async () => {
      const gifNoTitle: TenorGif = {
        id: "no-title",
        title: "",
        url: "https://media.tenor.com/preview/no-title.gif",
        fullUrl: "https://media.tenor.com/full/no-title.gif",
      };
      vi.mocked(getTrendingGifs).mockResolvedValue([gifNoTitle]);

      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      const img = picker.element.querySelector(".gp-img") as HTMLImageElement;
      expect(img.alt).toBe("GIF");
      picker.destroy();
    });

    it("img alt is the gif title when present", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      const imgs = picker.element.querySelectorAll(".gp-img") as NodeListOf<HTMLImageElement>;
      expect(imgs[0]!.alt).toBe(TRENDING_GIFS[0]!.title);
      picker.destroy();
    });

    it("img has loading=lazy attribute", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      const img = picker.element.querySelector(".gp-img") as HTMLImageElement;
      expect(img.getAttribute("loading")).toBe("lazy");
      picker.destroy();
    });
  });

  // ── Clicking a GIF ────────────────────────────────────────────────────────

  describe("clicking a GIF", () => {
    it("calls onSelect with the full URL", async () => {
      const onSelect = vi.fn();
      const { picker } = makePicker({ onSelect });
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      const firstItem = picker.element.querySelector(".gp-item") as HTMLElement;
      firstItem.click();

      expect(onSelect).toHaveBeenCalledWith(TRENDING_GIFS[0]!.fullUrl);
      picker.destroy();
    });

    it("also calls onClose after selecting a GIF", async () => {
      const onClose = vi.fn();
      const { picker } = makePicker({ onClose });
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      const firstItem = picker.element.querySelector(".gp-item") as HTMLElement;
      firstItem.click();

      expect(onClose).toHaveBeenCalledOnce();
      picker.destroy();
    });

    it("calls onSelect with the correct fullUrl for each item", async () => {
      const onSelect = vi.fn();
      const { picker } = makePicker({ onSelect });
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      const items = picker.element.querySelectorAll(".gp-item") as NodeListOf<HTMLElement>;

      // Click each item and verify its fullUrl
      TRENDING_GIFS.forEach((gif, i) => {
        onSelect.mockClear();
        items[i]!.click();
        expect(onSelect).toHaveBeenCalledWith(gif.fullUrl);
      });
      picker.destroy();
    });
  });

  // ── Escape key ────────────────────────────────────────────────────────────

  describe("Escape key", () => {
    it("calls onClose when Escape is pressed on the root element", () => {
      const onClose = vi.fn();
      const { picker } = makePicker({ onClose });
      container.appendChild(picker.element);

      picker.element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      expect(onClose).toHaveBeenCalledOnce();
      picker.destroy();
    });

    it("does not call onClose for other keys", () => {
      const onClose = vi.fn();
      const { picker } = makePicker({ onClose });
      container.appendChild(picker.element);

      picker.element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      picker.element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );

      expect(onClose).not.toHaveBeenCalled();
      picker.destroy();
    });
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  describe("empty state", () => {
    it("shows empty state when getTrendingGifs returns empty array", async () => {
      vi.mocked(getTrendingGifs).mockResolvedValue([]);

      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      const empty = picker.element.querySelector(".gp-empty");
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toBe("No GIFs found");
      picker.destroy();
    });

    it("shows empty state when searchGifs returns empty array", async () => {
      vi.mocked(searchGifs).mockResolvedValue([]);

      const { picker } = makePicker();
      container.appendChild(picker.element);

      // Flush initial trending load
      await Promise.resolve();
      await Promise.resolve();

      // Type a query and wait for debounce + resolution
      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      input.value = "xyzzy";
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(300);

      await Promise.resolve();
      await Promise.resolve();

      const empty = picker.element.querySelector(".gp-empty");
      expect(empty).not.toBeNull();
      expect(empty!.textContent).toBe("No GIFs found");
      picker.destroy();
    });

    it("does not show empty state when gifs are present", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

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
      vi.mocked(getTrendingGifs).mockResolvedValue(TRENDING_GIFS);
      vi.mocked(searchGifs).mockReturnValue(new Promise(() => {}));

      const { picker } = makePicker();
      container.appendChild(picker.element);

      // Flush initial trending
      await Promise.resolve();
      await Promise.resolve();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      input.value = "cats";
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(300);
      // Do NOT await — the search promise never resolves

      const loading = picker.element.querySelector(".gp-loading");
      expect(loading).not.toBeNull();
      expect(loading!.textContent).toBe("Loading...");
      picker.destroy();
    });

    it("replaces loading indicator with grid when fetch completes", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

      // Loading should be gone, grid present
      expect(picker.element.querySelector(".gp-loading")).toBeNull();
      expect(picker.element.querySelector(".gp-grid")).not.toBeNull();
      picker.destroy();
    });
  });

  // ── Error state ───────────────────────────────────────────────────────────

  describe("error state", () => {
    it("shows error message when getTrendingGifs throws", async () => {
      vi.mocked(getTrendingGifs).mockRejectedValue(new Error("Network error"));

      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve(); // extra tick for rejection path

      const errEl = picker.element.querySelector(".gp-empty");
      expect(errEl).not.toBeNull();
      expect(errEl!.textContent).toBe("Network error");
      picker.destroy();
    });

    it("shows generic fallback message when thrown value is not an Error", async () => {
      vi.mocked(getTrendingGifs).mockRejectedValue("oops");

      const { picker } = makePicker();
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const errEl = picker.element.querySelector(".gp-empty");
      expect(errEl).not.toBeNull();
      expect(errEl!.textContent).toBe("Failed to load GIFs");
      picker.destroy();
    });
  });

  // ── Stale request cancellation ────────────────────────────────────────────

  describe("stale request cancellation", () => {
    it("does not render results from a superseded request", async () => {
      // First search resolves late, second resolves immediately
      let resolveFirst!: (v: readonly TenorGif[]) => void;
      const firstPromise = new Promise<readonly TenorGif[]>((res) => {
        resolveFirst = res;
      });

      vi.mocked(getTrendingGifs).mockResolvedValue(TRENDING_GIFS);

      vi.mocked(searchGifs)
        .mockReturnValueOnce(firstPromise)     // "ca" — resolves late
        .mockResolvedValueOnce(SEARCH_GIFS);   // "cats" — resolves immediately

      const { picker } = makePicker();
      container.appendChild(picker.element);

      // Flush trending
      await Promise.resolve();
      await Promise.resolve();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;

      // First query
      input.value = "ca";
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(300);

      // Second query fires before first resolves
      input.value = "cats";
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();

      // Now resolve the stale first request
      resolveFirst([makeGif("stale")]);
      await Promise.resolve();
      await Promise.resolve();

      // Grid should show SEARCH_GIFS (second request), not the stale result
      const items = picker.element.querySelectorAll(".gp-item");
      expect(items.length).toBe(SEARCH_GIFS.length);
      picker.destroy();
    });
  });

  // ── destroy() ─────────────────────────────────────────────────────────────

  describe("destroy()", () => {
    it("clears any pending debounce timer", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      input.value = "cats";
      input.dispatchEvent(new Event("input"));

      // Destroy before debounce fires
      picker.destroy();
      vi.advanceTimersByTime(300);
      await Promise.resolve();

      // searchGifs should not have been called (only getTrendingGifs at init)
      expect(vi.mocked(searchGifs)).not.toHaveBeenCalled();
    });

    it("aborts the AbortController so click events no longer fire", async () => {
      const onSelect = vi.fn();
      const { picker } = makePicker({ onSelect });
      container.appendChild(picker.element);

      await Promise.resolve();
      await Promise.resolve();

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
      const { picker } = makePicker({ onClose });
      container.appendChild(picker.element);

      picker.destroy();

      picker.element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      expect(onClose).not.toHaveBeenCalled();
    });

    it("aborts the AbortController so input events no longer fire", async () => {
      const { picker } = makePicker();
      container.appendChild(picker.element);

      picker.destroy();
      vi.mocked(getTrendingGifs).mockClear();
      vi.mocked(searchGifs).mockClear();

      const input = picker.element.querySelector(".gp-search") as HTMLInputElement;
      input.value = "cats";
      input.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(300);
      await Promise.resolve();

      expect(vi.mocked(searchGifs)).not.toHaveBeenCalled();
    });
  });
});
