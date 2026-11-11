/** Emoji cells built up to this count right away; later categories wait until they are near the view. */
const EAGER_CELLS = 120;
const NEAR_PX = 300;

export interface LazyGrids {
  /** Builds the grid now while the eager budget lasts, else when it comes near the view. */
  place(grid: HTMLElement, cellCount: number, fill: () => void): void;
  /** Drops every waiting fill and restarts the eager budget (call before a rebuild). */
  reset(): void;
  /** Builds every waiting grid at once. */
  fillAll(): void;
}

function run(grid: Element, fill: () => void): void {
  grid.classList.remove("ep-lazy");
  fill();
  // Cells built after the roving tab stop was set must not add Tab stops.
  for (const cell of grid.children) cell.setAttribute("tabindex", "-1");
}

export function createLazyGrids(scrollArea: HTMLElement, signal: AbortSignal): LazyGrids {
  const waiting = new Map<Element, () => void>();
  let built = 0;

  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const fill = waiting.get(entry.target);
              if (fill === undefined) continue;
              waiting.delete(entry.target);
              observer?.unobserve(entry.target);
              run(entry.target, fill);
            }
          },
          { root: scrollArea, rootMargin: `${NEAR_PX}px 0px` },
        );

  function fillAll(): void {
    if (waiting.size === 0) return;
    const pending = [...waiting];
    waiting.clear();
    observer?.disconnect();
    for (const [grid, fill] of pending) run(grid, fill);
  }

  // The arrow, Home and End steps read the whole cell list, so every grid
  // must exist before the first key or focus lands in the list.
  scrollArea.addEventListener("keydown", fillAll, { capture: true, signal });
  scrollArea.addEventListener("focusin", fillAll, { signal });
  signal.addEventListener(
    "abort",
    () => {
      waiting.clear();
      observer?.disconnect();
    },
    { once: true },
  );

  return {
    place(grid, cellCount, fill) {
      if (observer === null || built < EAGER_CELLS) {
        built += cellCount;
        fill();
        return;
      }
      grid.classList.add("ep-lazy");
      waiting.set(grid, fill);
      observer.observe(grid);
    },
    reset() {
      waiting.clear();
      observer?.disconnect();
      built = 0;
    },
    fillAll,
  };
}
